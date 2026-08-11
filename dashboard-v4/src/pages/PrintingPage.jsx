/* Página "Impressão" — tudo das impressoras da fábrica (Bruno 07-17).
   - Status FÍSICO ao vivo por impressora (o poller do .28 manda transições →
     v3.printer_status). A EPSON CW-C8000u fala o estado real via ESC/Label
     ~H(SMA,S (PR=imprimindo / IL=ocioso) — a transição PR→IL é o fim físico.
   - Spooler ao vivo (SSE /api/v3/data/print-stream) — jobs em andamento + ETA.
   - Stats do dia (labels, jobs, operadores) + por impressora/operador/produto.
   - Saúde EPSON (tinta/mídia) quando o canal trouxer (slots já prontos).
   - Histórico das últimas impressões (quem, o quê, batch, tempo).
   Dado real: GET /api/v3/data/printers?date= (poll 12s) + SSE pro spooler.
*/
import React from 'react';
import { Icon, Leaf } from '../components/Icons.jsx';
import { KPI, CapBar } from '../components/Primitives.jsx';
import { usePoll, getPin } from '../adapters/from-api.js';

// Mapa de rótulo de status físico → cor + texto amigável.
function statusView(label) {
  const s = String(label || '').toLowerCase();
  if (/imprim|print|\bpr\b/.test(s)) return { key: 'printing', txt: 'Imprimindo', c: 'var(--hf-navy-500)', live: true };
  if (/erro|error|jam|papel|paper|falta|out/.test(s)) return { key: 'error', txt: label || 'Erro', c: 'var(--bad, #dc2626)', live: false };
  if (/ocios|idle|\bil\b|normal|pronta|ready/.test(s)) return { key: 'idle', txt: 'Ociosa', c: 'var(--hf-leaf-600)', live: false };
  if (/wait|wt|pause|ps/.test(s)) return { key: 'wait', txt: label || 'Aguardando', c: 'var(--warn, #d97706)', live: false };
  return { key: 'unknown', txt: label || 'Desconhecido', c: 'var(--text-3)', live: false };
}

function fmtAgo(sec) {
  if (sec == null) return '—';
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.round(sec / 60) + 'min';
  return Math.round(sec / 3600) + 'h';
}
function fmtDur(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}
function fmtClock(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit',
    });
  } catch { return '—'; }
}

// Cores reais das tintas (K/C/M/Y) pra pintar as barras.
const INK_COLORS = { K: '#1a1a1a', C: '#00a8e0', M: '#e6007e', Y: '#f5d800', maint: '#8a6d3b' };
const INK_NAME = { K: 'Preto', C: 'Ciano', M: 'Magenta', Y: 'Amarelo' };
// avisos do ESC/Label ~H(QWN → texto pt
const WARN_LABEL = {
  IC1: 'Ciano baixo', IM1: 'Magenta baixo', IY1: 'Amarelo baixo', IK1: 'Preto baixo',
  MNF: 'Caixa de manut. quase cheia', NCR: 'Recuperando bico', NSU: 'Verificação de bico off',
  WSC: 'Chamada de serviço', WNC: 'Bico entupido',
};

// Uma barra de tinta: cor real da tinta, nível (código RH/RM/RL/RN/RR/NA) e %.
function InkBar({ name, c, level }) {
  const pct = level && level.pct != null ? level.pct : 0;
  const low = pct <= 15;
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
        <span style={{ fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: c, border: '1px solid rgba(0,0,0,0.15)', display: 'inline-block' }}/>
          {name}
        </span>
        <span style={{ fontSize: 11.5, color: low ? 'var(--bad, #dc2626)' : 'var(--text-3)', fontWeight: low ? 700 : 500 }}>
          {level ? level.label : '—'}
        </span>
      </div>
      <div style={{ height: 9, borderRadius: 5, background: 'var(--surface-2)', overflow: 'hidden', border: '1px solid var(--border)' }}>
        <div style={{ width: pct + '%', height: '100%', background: c, borderRadius: 5,
                      opacity: level && (level.code === 'NA') ? 0.25 : 1,
                      boxShadow: low ? 'inset 0 0 0 99px rgba(220,38,38,0.25)' : 'none' }}/>
      </div>
    </div>
  );
}

// Painel de tinta CMYK (ordem K, C, M, Y).
function InkPanel({ ink }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.05, fontWeight: 700, marginBottom: 6 }}>Tinta</div>
      {['K', 'C', 'M', 'Y'].filter((k) => ink[k]).map((k) => (
        <InkBar key={k} name={INK_NAME[k]} c={INK_COLORS[k]} level={ink[k]}/>
      ))}
    </div>
  );
}

// ── SSE do spooler ao vivo (mesma stream do widget do Hoje). Assina uma vez;
//    mantém "jobs ativos" (progress/done) num state local. ──
function useSpoolerStream() {
  const [live, setLive] = React.useState({ active: [], done: [] });
  React.useEffect(() => {
    const pin = getPin();
    const es = new EventSource(`/api/v3/data/print-stream?pin=${encodeURIComponent(pin)}`);
    es.addEventListener('snapshot', (e) => {
      try { setLive(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('progress', (e) => {
      try {
        const p = JSON.parse(e.data);
        setLive((prev) => {
          const rest = (prev.active || []).filter((j) => !(j.computer === p.computer && j.job_id === p.job_id));
          return { ...prev, active: [...rest, p].sort((a, b) => (a.job_id > b.job_id ? 1 : -1)) };
        });
      } catch {}
    });
    es.addEventListener('done', (e) => {
      try {
        const d = JSON.parse(e.data);
        setLive((prev) => ({
          ...prev,
          active: (prev.active || []).filter((j) => !(j.computer === d.computer && j.job_id === d.job_id)),
          done: [d, ...(prev.done || [])].slice(0, 8),
        }));
      } catch {}
    });
    // fim FÍSICO real (PR→IL) — a impressora terminou de verdade
    es.addEventListener('finished', (e) => {
      try {
        const f = JSON.parse(e.data);
        setLive((prev) => ({ ...prev, lastFinished: { ...f, at: Date.now() } }));
      } catch {}
    });
    es.onerror = () => { /* EventSource reconecta sozinho */ };
    return () => es.close();
  }, []);
  return live;
}

function PrintingPage({ date }) {
  const { data, loading } = usePoll(date ? `/printers?date=${date}` : '/printers', [date], 12000);
  const stream = useSpoolerStream();

  const printers = (data && data.printers) || [];
  const stats = (data && data.stats) || { jobs: 0, labels: 0, operators: 0 };
  const byPrinter = (data && data.byPrinter) || [];
  const byOperator = (data && data.byOperator) || [];
  const byProduct = (data && data.byProduct) || [];
  const history = (data && data.history) || [];
  const transitions = (data && data.transitions) || [];
  const incidents = (data && data.incidents) || [];
  const errorLog = (data && data.errorLog) || [];
  const stationOp = data && data.stationOperator;   // quem está logado no PC .28 agora
  // spooler ao vivo: prioriza o que veio do SSE (mais fresco); cai pro poll.
  const activeJobs = (stream.active && stream.active.length ? stream.active : ((data && data.live && data.live.active) || []));

  if (loading && !data) {
    return <div className="card" style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)' }}>Carregando impressoras…</div>;
  }

  return (
    <div>
      {/* ── Stats do dia ── */}
      <div className="kpi-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 18 }}>
        <KPI label="Labels impressos" en="Labels" value={stats.labels} suffix=" hoje"
             foot={`${stats.jobs} impressões · ${stats.operators} operador(es)`}/>
        <KPI label="Impressões" en="Jobs" value={stats.jobs} suffix=" hoje"
             foot={activeJobs.length > 0 ? `${activeJobs.length} em andamento agora` : 'nenhuma agora'}/>
        <KPI label="Impressoras" en="Printers" value={printers.length}
             foot={printers.filter((p) => statusView(p.status_label).live).length + ' imprimindo agora'}/>
      </div>

      {/* ── QUEM está no PC da impressão AGORA (Bruno 07-27) ── */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 12,
             borderLeft: '4px solid ' + (stationOp ? (stationOp.active_now ? 'var(--hf-leaf-500, #22b35d)' : 'var(--warn, #d97706)') : 'var(--text-3)') }}>
        <span style={{ fontSize: 22 }}>💻</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.06 }}>Na estação de impressão (.28) agora</div>
          {stationOp && stationOp.stale ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--text-3)' }}/>
              <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
                último login foi de <b>{stationOp.name || '—'}</b>, mas está velho — <b>não dá pra confirmar</b> quem está agora
              </span>
            </div>
          ) : stationOp ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: stationOp.active_now ? 'var(--hf-leaf-500, #22b35d)' : 'var(--warn, #d97706)' }}/>
              <b style={{ fontSize: 15 }}>{stationOp.name || 'sem nome'}</b>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {stationOp.active_now ? 'ativo agora' : `logado, parado há ${fmtDur(Math.round((stationOp.last_seen_sec || 0) / 60))}`}
                {stationOp.active_sec != null ? ` · ${fmtDur(Math.round(stationOp.active_sec / 60))} ativo no PC` : ''}
              </span>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3 }}>ninguém logado (tela bloqueada esperando PIN)</div>
          )}
        </div>
      </div>

      {/* ── Incidentes ABERTOS (impressora com problema agora) ── */}
      {incidents.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          {incidents.map((inc) => (
            <div key={inc.printer} className="card" style={{ padding: 16, marginBottom: 8, borderLeft: '4px solid var(--bad, #dc2626)', background: 'color-mix(in srgb, var(--bad, #dc2626) 6%, var(--surface))' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 18 }}>⚠️</span>
                <b style={{ fontSize: 14 }}>{inc.printer}</b>
                <span className="pill" style={{ background: 'color-mix(in srgb, var(--bad) 14%, transparent)', color: 'var(--bad)', borderColor: 'color-mix(in srgb, var(--bad) 34%, transparent)' }}>
                  <span className="dot" style={{ background: 'var(--bad)' }}/>{inc.error || 'problema'}
                </span>
                <span style={{ flex: 1 }}/>
                {inc.down_seconds != null && <span style={{ fontSize: 12.5, color: 'var(--bad)', fontWeight: 700 }}>parada há {fmtDur(inc.down_seconds)}</span>}
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-3)', display: 'flex', gap: 14 }}>
                {inc.tried_by && <span>tentou consertar: <b>{inc.tried_by}</b></span>}
                {inc.alerts > 0 && <span>{inc.alerts} alerta(s) enviado(s)</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Status físico ao vivo por impressora ── */}
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Impressoras · estado físico</h2><span className="en">· Live physical status</span>
        <div className="rule"/>
      </div>
      {printers.length === 0 ? (
        <div className="card" style={{ padding: 24, color: 'var(--text-3)', textAlign: 'center' }}>
          Sem status ainda. O poller do .28 vai reportar assim que uma impressora mudar de estado.
          <div style={{ fontSize: 11.5, marginTop: 8, fontStyle: 'italic' }}>
            (Fim físico real vem do canal ESC/Label da EPSON — <span className="mono">~H(SMA,S</span> → PR→IL.)
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginBottom: 18 }}>
          {printers.map((p) => {
            const sv = statusView(p.status_label);
            const ink = p.ink || null;   // { color: pct } quando o canal trouxer
            const media = p.media || null;
            return (
              <div key={p.computer + '|' + p.printer} className="card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Icon name="factory" size={18}/>
                  <b style={{ fontSize: 14, flex: 1 }}>{p.printer}</b>
                  <span className={`pill ${sv.live ? 'live' : ''}`} style={{ background: sv.c === 'var(--text-3)' ? 'var(--surface-2)' : `color-mix(in srgb, ${sv.c} 14%, transparent)`, color: sv.c, borderColor: `color-mix(in srgb, ${sv.c} 34%, transparent)` }}>
                    <span className="dot" style={{ background: sv.c }}/>{sv.txt}
                  </span>
                </div>
                {p.error_label && (
                  <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--bad, #dc2626)', fontWeight: 600 }}>
                    ⚠ {p.error_label}
                  </div>
                )}
                {ink && <InkPanel ink={ink}/>}
                {media && media.maint_box && (
                  <div style={{ marginTop: 10 }}>
                    <InkBar name="Caixa de manutenção" c={INK_COLORS.maint} level={media.maint_box}/>
                  </div>
                )}
                {media && media.warnings && media.warnings.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {media.warnings.map((w) => (
                      <span key={w} className="pill" style={{ fontSize: 10.5, background: 'color-mix(in srgb, var(--warn, #d97706) 12%, transparent)', color: 'var(--warn, #d97706)' }}>
                        <span className="dot" style={{ background: 'var(--warn, #d97706)' }}/>{WARN_LABEL[w] || w}
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-3)', display: 'flex', gap: 12 }}>
                  <span>atualizado há {fmtAgo(p.age_sec)}</span>
                  <span className="mono">{p.computer}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Spooler ao vivo (jobs em andamento) ── */}
      {activeJobs.length > 0 && (
        <>
          <div className="section-title">
            <span className="pill live"><span className="dot"/>ao vivo</span>
            <h2 style={{ marginLeft: 8 }}>Imprimindo agora</h2><span className="en">· Spooler live</span>
            <div className="rule"/>
          </div>
          <div style={{ display: 'grid', gap: 10, marginBottom: 18 }}>
            {activeJobs.map((j) => (
              <div key={j.computer + '|' + j.job_id} className="card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <b style={{ fontSize: 13.5 }}>{j.document || 'documento'}</b>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{j.printer}</span>
                  <span style={{ flex: 1 }}/>
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{fmtDur(j.elapsed_sec)} decorrido</span>
                </div>
                {(j.total_pages || 0) > 1 && j.pct != null ? (
                  <div style={{ marginTop: 8 }}>
                    <CapBar pct={j.pct} size="lg"
                            label={`${j.pages_printed || 0}/${j.total_pages || '?'} pág`}
                            sub={j.eta_sec != null ? `~${fmtDur(j.eta_sec)} restante (spooler)` : `${j.pct}%`}
                            color1="var(--hf-navy-500)" color2="var(--hf-leaf-500)"/>
                    <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>
                      * barra = spooler (dados enviados). Fim FÍSICO real vem do estado da impressora acima.
                    </div>
                  </div>
                ) : (
                  // PDF (Acrobat): o spooler não sabe o total ("1 página") — sem barra
                  // falsa. A contagem REAL vem do contador da impressora no fim físico.
                  <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-3)', fontStyle: 'italic' }}>
                    PDF — o spooler não informa o total; a impressora conta os labels e o
                    número REAL entra no registro quando ela terminar (estado acima).
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Quebras do dia ── */}
      {(byPrinter.length > 0 || byOperator.length > 0 || byProduct.length > 0) && (
        <>
          <div className="section-title">
            <Leaf size={14} color="var(--hf-leaf-500)"/>
            <h2>Hoje · por impressora, operador e produto</h2><span className="en">· Today breakdown</span>
            <div className="rule"/>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginBottom: 18 }}>
            <BreakdownCard title="Por impressora" rows={byPrinter} nameKey="printer"/>
            <BreakdownCard title="Por operador" rows={byOperator} nameKey="operator"/>
            <BreakdownCard title="Por produto" rows={byProduct} nameKey="product"/>
          </div>
        </>
      )}

      {/* ── Histórico ── */}
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Últimas impressões</h2><span className="en">· History</span>
        <div className="rule"/>
      </div>
      {history.length === 0 ? (
        <div className="card" style={{ padding: 24, color: 'var(--text-3)', textAlign: 'center' }}>Nenhuma impressão registrada ainda.</div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.04 }}>
                  <th style={{ padding: '10px 12px' }}>Hora</th>
                  <th style={{ padding: '10px 12px' }}>Operador</th>
                  <th style={{ padding: '10px 12px' }}>Documento</th>
                  <th style={{ padding: '10px 12px' }}>Produto · Batch</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>Labels</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }} title="Tempo FÍSICO que a impressora levou (PR→IL)">Impressão</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>Ativo no PC</th>
                  <th style={{ padding: '10px 12px' }}>Impressora</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }} className="mono">{fmtClock(h.completed_at || h.created_at)}</td>
                    <td style={{ padding: '9px 12px' }}>
                      {h.operator || h.operator_fallback || <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>sem PIN</span>}
                    </td>
                    <td style={{ padding: '9px 12px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.document}>{h.document || '—'}</td>
                    <td style={{ padding: '9px 12px' }}>
                      {h.product ? (
                        <span><b>{h.product}</b>{h.batch && <span className="mono" style={{ color: 'var(--text-3)', marginLeft: 6 }}>{h.batch}</span>}</span>
                      ) : (
                        <span style={{ color: h.has_batch === false ? 'var(--warn)' : 'var(--text-3)', fontStyle: 'italic' }}>
                          {h.has_batch === false ? 'sem batch' : 'não identificado'}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 700 }}>{h.sheets || '—'}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' }} className="mono">{h.print_seconds ? fmtDur(h.print_seconds) : '—'}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' }} className="mono">{h.session_active_sec ? fmtDur(h.session_active_sec) : '—'}</td>
                    <td style={{ padding: '9px 12px', color: 'var(--text-3)', fontSize: 11.5 }}>{h.printer || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Histórico de problemas (recorrência de erros de mídia) ── */}
      {errorLog.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--text-3)' }}>
            Histórico de problemas ({errorLog.length}) — sem papel / atolou / sem tinta
          </summary>
          <div className="card" style={{ padding: 12, marginTop: 8, fontSize: 12 }}>
            {errorLog.map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '3px 0' }}>
                <span className="mono" style={{ color: 'var(--text-3)' }}>{fmtClock(e.at)}</span>
                <span style={{ color: 'var(--bad)', fontWeight: 600 }}>{e.error_label}</span>
                <span style={{ color: 'var(--text-3)' }}>{e.printer}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* ── Transições de status (debug/telemetria do físico) ── */}
      {transitions.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--text-3)' }}>
            Transições de status recentes ({transitions.length}) — telemetria do fim físico
          </summary>
          <div className="card" style={{ padding: 12, marginTop: 8, fontSize: 12 }}>
            {transitions.map((t, i) => {
              const sv = statusView(t.status_label);
              return (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '3px 0', color: 'var(--text-2)' }}>
                  <span className="mono" style={{ color: 'var(--text-3)' }}>{fmtClock(t.at)}</span>
                  <span style={{ color: sv.c, fontWeight: 600 }}>{sv.txt}</span>
                  <span style={{ color: 'var(--text-3)' }}>{t.printer}</span>
                  {t.error_label && <span style={{ color: 'var(--bad)' }}>⚠ {t.error_label}</span>}
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

function BreakdownCard({ title, rows, nameKey }) {
  const max = Math.max(1, ...rows.map((r) => r.labels || 0));
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', marginBottom: 10 }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>—</div>
      ) : rows.slice(0, 6).map((r, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 3 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{r[nameKey]}</span>
            <b>{r.labels}</b>
          </div>
          <div className="cap" style={{ width: '100%' }}>
            <div className="cap-fill" style={{ width: Math.round(((r.labels || 0) / max) * 100) + '%', background: 'linear-gradient(90deg, var(--hf-navy-500), var(--hf-leaf-500))' }}/>
          </div>
        </div>
      ))}
    </div>
  );
}

window.PrintingPage = PrintingPage;
export { PrintingPage };
