/* Página "Impressão" — tudo das impressoras da fábrica (Bruno 07-17).
   - Status FÍSICO ao vivo por impressora (o poller do .28 manda transições →
     v3.printer_status). A EPSON CW-C8000u fala o estado real via ESC/Label
     ~H(SMA,S (PR=imprimindo / IL=ocioso) — a transição PR→IL é o fim físico.
   - Spooler ao vivo (SSE /api/v3/data/print-stream) — jobs em andamento + ETA.
   - Stats do dia (labels, jobs, operadores) + por impressora/operador/produto.
   - Saúde EPSON (tinta/mídia) quando o canal trouxer (slots já prontos).
   - Histórico das últimas impressões (quem, o quê, batch, tempo).
   Dado real: GET /api/v3/data/printers?date= (poll 12s) + SSE pro spooler.

   S15 Fase 2 (grupo C): STYLE-KIT 100%. Cards de impressora, barras de tinta e
   incidentes usam os tons do kit (ok/warn/bad/info/neutral); histórico virou
   kit-table. SSE, polling e contratos de dado NÃO mudaram.
*/
import React from 'react';
import { Icon } from '../components/Icons.jsx';
import { usePoll, getPin } from '../adapters/from-api.js';
import { getPrintQueue, cancelPrintJob,
  getShippingPreview, submitShippingLabels, fetchPrintFile } from '../adapters/warehouse-api.js';
import './pages-admin.css';

// Mapa de rótulo de status físico → tom do kit + texto amigável.
function statusView(label) {
  const s = String(label || '').toLowerCase();
  if (/imprim|print|\bpr\b/.test(s)) return { key: 'printing', txt: 'Imprimindo', tone: 'info', live: true };
  if (/erro|error|jam|papel|paper|falta|out/.test(s)) return { key: 'error', txt: label || 'Erro', tone: 'bad', live: false };
  if (/ocios|idle|\bil\b|normal|pronta|ready/.test(s)) return { key: 'idle', txt: 'Ociosa', tone: 'ok', live: false };
  if (/wait|wt|pause|ps/.test(s)) return { key: 'wait', txt: label || 'Aguardando', tone: 'warn', live: false };
  return { key: 'unknown', txt: label || 'Desconhecido', tone: 'neutral', live: false };
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

// Cores reais das tintas (K/C/M/Y) pra pintar as barras. São cor FÍSICA do
// cartucho, não semântica de status — por isso ficam fora dos tokens do kit.
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
    <div className="ink-row">
      <div className="ink-top">
        <span className="ink-name">
          <span className="ink-swatch" style={{ background: c }}/>
          {name}
        </span>
        {level
          ? <span className={'kit-chip ' + (low ? 'bad' : 'neutral')}>{level.label}</span>
          : <span className="adm-note faint">sem leitura</span>}
      </div>
      <div className="ink-track">
        <div className="ink-fill" style={{ width: pct + '%', background: c,
                      opacity: level && (level.code === 'NA') ? 0.25 : 1 }}/>
      </div>
    </div>
  );
}

// Painel de tinta CMYK (ordem K, C, M, Y).
function InkPanel({ ink }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div className="kit-mlabel" style={{ marginBottom: 8 }}>Tinta</div>
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

/* ── Fila do celular (S15.29) ────────────────────────────────────────────────
   Quem pede etiqueta do iPhone não tem impressora na mão: o pedido entra numa
   fila e os PCs com papel (Central do /op, hub de Estoque, estação .28) puxam.
   Este painel é a janela do admin pra ESSA fila: o que está esperando, quem
   pediu, há quanto tempo e quem pegou. Cancelar só vale enquanto ninguém pegou;
   depois disso o papel já pode estar saindo, e "cancelar" seria mentira. */
const QUEUE_KIND = {
  bin_labels: 'Etiquetas de prateleira',
  box_label: 'Etiqueta de caixa',
  picklist: 'Picklist de hoje',
  shipping_labels: 'Etiquetas de envio',
};
const QUEUE_STATUS = {
  queued: { txt: 'na fila', tone: 'warn' },
  taken: { txt: 'imprimindo', tone: 'info' },
  done: { txt: 'impresso', tone: 'ok' },
  error: { txt: 'deu erro', tone: 'bad' },
  cancelled: { txt: 'cancelado', tone: 'neutral' },
};
function queueAge(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 1) return 'agora mesmo';
  if (m < 60) return 'há ' + m + ' min';
  const h = Math.floor(m / 60); const r = m % 60;
  return 'há ' + h + ' h' + (r ? ' ' + r + ' min' : '');
}
function queueCount(job) {
  const p = (job && job.payload) || {};
  if (Array.isArray(p.labels)) return p.labels.length;
  return job && job.kind === 'picklist' ? 1 : 0;
}

/* ── Etiquetas de envio de hoje ───────────────────────────────────────────────
   A etiqueta da transportadora sai do NOSSO sistema, com um rodapé que a Veeqo
   não tem: apelido do produto, local na prateleira, garrafas, tamanho do
   envelope e quem separou / quem embalou. Vão agrupadas por produto e na ordem
   do local, com folha divisória entre produtos, pra quem separa andar a
   prateleira uma vez só. O PDF é composto no servidor; aqui o admin decide
   entre mandar pra 4x6 da Central ou abrir o arquivo pra conferir. */

/** Hoje em Nova York: o dia do P&P é o da fábrica, não o do navegador. */
function todayNY() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch { return new Date().toISOString().slice(0, 10); }
}

/** Uma linha por produto: apelido · quantas · local. Ordem = a do servidor. */
function shippingGroups(prev) {
  const by = new Map();
  ((prev && prev.ready) || []).forEach((o) => {
    const p = (o.products || [])[0] || {};
    const nick = p.nickname || p.sku || 'sem produto';
    if (!by.has(nick)) by.set(nick, { nickname: nick, count: 0, location: p.bin_code || p.shelf_code || 'sem local' });
    by.get(nick).count += 1;
  });
  return [...by.values()];
}

function ShippingLabelsPanel() {
  const [prev, setPrev] = React.useState(null);
  const [down, setDown] = React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [msg, setMsg] = React.useState(null);

  const load = React.useCallback(() => getShippingPreview(todayNY()).then(
    (j) => { setPrev((j && j.data) || j || {}); setDown(false); },
    () => { setDown(true); setPrev(null); },
  ), []);

  React.useEffect(() => {
    let alive = true;
    const run = () => { if (alive) load(); };
    run();
    const t = setInterval(run, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [load]);

  const counts = (prev && prev.counts) || {};
  const ready = Number(counts.ready) || 0;
  const printed = Number(counts.printed) || 0;
  const toPrint = Number(counts.to_print) || 0;

  /** Manda pro computador: compõe SEM take, a Central puxa da fila e imprime. */
  async function send() {
    setBusy('send'); setMsg(null);
    try {
      await submitShippingLabels({ day: todayNY() });
      setMsg({ tone: 'ok', txt: 'Mandado. Sai na 4x6 da Central em até 30 s.' });
      load();
    } catch (e) {
      setMsg(e && e.code === 'nothing_to_print'
        ? { tone: 'ok', txt: 'Nada novo pra imprimir. As de hoje já saíram.' }
        : { tone: 'bad', txt: (e && e.message) || 'não deu pra montar as etiquetas' });
    } finally { setBusy(''); }
  }

  /* Abrir aqui: a aba nasce ANTES do await (popup que não vem do clique é
     bloqueado) e recebe um blob local, porque o arquivo mora atrás do PIN e
     uma aba nova não manda header nenhum. */
  async function open() {
    const win = window.open('', '_blank');
    setBusy('open'); setMsg(null);
    try {
      const r = await submitShippingLabels({ day: todayNY(), take: true });
      const d = (r && r.data) || r || {};
      const id = d.job && d.job.id;
      if (!id) throw new Error('o servidor não devolveu o arquivo');
      const blob = await fetchPrintFile(id);
      const url = URL.createObjectURL(blob);
      if (win) win.location = url;
      setMsg({ tone: 'ok', txt: 'PDF aberto na outra aba. Imprima na 4x6 e confirme na Central.' });
      load();
    } catch (e) {
      if (win) { try { win.close(); } catch { /* já fechada */ } }
      setMsg(e && e.code === 'nothing_to_print'
        ? { tone: 'ok', txt: 'Nada novo pra imprimir. As de hoje já saíram.' }
        : { tone: 'bad', txt: (e && e.message) || 'não deu pra abrir o PDF' });
    } finally { setBusy(''); }
  }

  const groups = shippingGroups(prev);

  return (
    <div data-panel="etiquetas-envio">
      <div className="adm-sec" style={{ marginTop: 20 }}>
        {toPrint > 0 && <span className="kit-chip warn">{toPrint} pra imprimir</span>}
        <span className="kit-mlabel">Etiquetas de envio de hoje</span>
        <span className="rule"/>
        <button className="kit-btn sec sm" data-act="atualizar-envio" onClick={load}>Atualizar</button>
      </div>
      <div className="kit-card pad" style={{ marginBottom: 18 }}>
        {down ? (
          <div className="adm-state">
            Não deu pra falar com a Veeqo agora. Toque em Atualizar daqui a pouco; o resto da página continua.
          </div>
        ) : !prev ? (
          <div className="adm-state">Vendo o que a Veeqo tem pra hoje…</div>
        ) : (
          <>
            <p className="adm-note faint" style={{ marginTop: 0, marginBottom: 10 }}>
              Saem com o rodapé do nosso sistema (produto, local, garrafas, envelope e quem separou/embalou),
              agrupadas por produto e na ordem do local.
            </p>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 12 }} data-counts="shipping">
              <span className="kit-chip neutral">{ready} prontas na Veeqo</span>
              <span className="kit-chip ok">{printed} já impressas</span>
              <span className={'kit-chip ' + (toPrint ? 'warn' : 'neutral')}>{toPrint} pra imprimir</span>
            </div>
            {groups.length > 0 && (
              <div style={{ overflowX: 'auto', marginBottom: 12 }}>
                <table className="kit-table" data-table="etiquetas-envio">
                  <thead><tr><th>Produto</th><th className="num">Etiquetas</th><th>Local</th></tr></thead>
                  <tbody>
                    {groups.map((g) => (
                      <tr key={g.nickname}>
                        <td><b>{g.nickname}</b></td>
                        <td className="num">{g.count}</td>
                        <td>{g.location}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {toPrint === 0 && (
              <div className="adm-note" style={{ marginBottom: 10 }}>
                {ready ? 'Tudo de hoje já saiu no papel.' : 'Nenhuma etiqueta comprada na Veeqo hoje ainda.'}
              </div>
            )}
            <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
              <button className="kit-btn" data-act="mandar-envio" disabled={!!busy || !toPrint} onClick={send}>
                {busy === 'send' ? 'Mandando…' : 'Mandar pro computador'}
              </button>
              <button className="kit-btn sec" data-act="abrir-envio" disabled={!!busy || (!toPrint && !ready)} onClick={open}>
                {busy === 'open' ? 'Montando…' : 'Abrir PDF aqui'}
              </button>
            </div>
            {msg && (
              <div className={'adm-note ' + (msg.tone === 'bad' ? 'bad' : '')} style={{ marginTop: 10 }} data-msg="envio">
                {msg.txt}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MobileQueuePanel() {
  const [jobs, setJobs] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [bump, setBump] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    const load = () => getPrintQueue('all', 30).then(
      (j) => { if (alive) { setJobs((j.data && j.data.jobs) || []); setErr(null); } },
      (e) => { if (alive) setErr(e); },
    );
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [bump]);

  async function cancel(id) {
    setBusy(id);
    try { await cancelPrintJob(id); setBump((b) => b + 1); }
    catch (e) { setErr(e); }
    finally { setBusy(null); }
  }

  // painel silencioso quando não há nada: a página é das impressoras, a fila é
  // um extra que só ocupa espaço quando tem alguém esperando papel.
  const list = jobs || [];
  const live = list.filter((j) => j.status === 'queued' || j.status === 'taken');
  if (!err && jobs && !list.length) return null;

  return (
    <div data-panel="fila-celular">
      <div className="adm-sec" style={{ marginTop: 20 }}>
        {live.length > 0 && <span className="kit-chip warn">{live.length} esperando</span>}
        <span className="kit-mlabel">Fila do celular · pedidos de impressão</span>
        <span className="rule"/>
      </div>
      {err ? (
        <div className="adm-state">
          Não deu pra ler a fila agora. Ela não atrapalha o resto da página; tente atualizar em alguns segundos.
        </div>
      ) : !jobs ? (
        <div className="adm-state">Carregando a fila…</div>
      ) : (
        <div className="kit-card pad" style={{ marginBottom: 18 }}>
          <p className="adm-note faint" style={{ marginTop: 0, marginBottom: 10 }}>
            Quem pede do celular não tem impressora na mão. O papel sai na Central do operador, no hub de Estoque ou na estação de impressão,
            onde o pedido aparece com um botão de Imprimir.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="kit-table" data-table="fila-celular">
              <thead>
                <tr>
                  <th>O quê</th>
                  <th className="num">Folhas</th>
                  <th>Quem pediu</th>
                  <th>Quando</th>
                  <th>Estado</th>
                  <th>Ação</th>
                </tr>
              </thead>
              <tbody>
                {list.map((j) => {
                  const sv = QUEUE_STATUS[j.status] || QUEUE_STATUS.queued;
                  return (
                    <tr key={j.id} data-job={j.id}>
                      <td>
                        <b>{QUEUE_KIND[j.kind] || j.kind}</b>
                        {j.is_test && <span className="kit-chip neutral" style={{ marginLeft: 6 }}>teste</span>}
                      </td>
                      <td className="num">{queueCount(j) || '—'}</td>
                      <td>{j.requested_by || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{queueAge(j.age_min)}</td>
                      <td>
                        <span className={'kit-chip ' + sv.tone}>{sv.txt}</span>
                        {j.status === 'taken' && j.taken_by && <span className="adm-note faint" style={{ marginLeft: 6 }}>{j.taken_by}</span>}
                        {j.status === 'error' && j.error_note && <span className="adm-note faint" style={{ marginLeft: 6 }}>{j.error_note}</span>}
                      </td>
                      <td>
                        {j.status === 'queued' ? (
                          <button className="kit-btn sec sm" data-act="cancelar-job" disabled={busy === j.id}
                                  onClick={() => cancel(j.id)}>
                            {busy === j.id ? 'Cancelando…' : 'Cancelar'}
                          </button>
                        ) : <span className="adm-note faint">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
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
    return <div className="adm-state">Carregando impressoras…</div>;
  }

  const printingNow = printers.filter((p) => statusView(p.status_label).live).length;

  return (
    <div data-page="impressao" style={{ paddingBottom: 60 }}>
      <div className="adm-head">
        <div className="lead">
          <span className="kit-eyebrow">● HEALTHFARE · IMPRESSÃO</span>
          <h1 className="kit-h1">Impressoras da <em>fábrica</em></h1>
          <p className="kit-sub">
            Estado físico ao vivo, tinta, incidentes e o histórico de quem imprimiu o quê. O fim real da impressão vem da própria máquina.
          </p>
        </div>
      </div>

      {/* ── Stats do dia ── */}
      <div className="adm-kpis" data-kpis="impressao">
        <div className="adm-kpi">
          <div className="kit-mlabel">Labels impressos</div>
          <div className="v">{stats.labels}<small>hoje</small></div>
          <div className="adm-note faint" style={{ marginTop: 4 }}>{stats.jobs} impressões · {stats.operators} operador(es)</div>
        </div>
        <div className="adm-kpi">
          <div className="kit-mlabel">Impressões</div>
          <div className="v">{stats.jobs}<small>hoje</small></div>
          <div className="adm-note faint" style={{ marginTop: 4 }}>
            {activeJobs.length > 0 ? activeJobs.length + ' em andamento agora' : 'nenhuma agora'}
          </div>
        </div>
        <div className="adm-kpi">
          <div className="kit-mlabel">Impressoras</div>
          <div className={'v ' + (printingNow > 0 ? 'ok' : '')}>{printers.length}</div>
          <div className="adm-note faint" style={{ marginTop: 4 }}>{printingNow} imprimindo agora</div>
        </div>
      </div>

      {/* ── QUEM está no PC da impressão AGORA (Bruno 07-27) ── */}
      <div className={'kit-card pad ' + (stationOp && !stationOp.stale && !stationOp.active_now ? 'warn' : '')}
           style={{ marginBottom: 18, display: 'flex', alignItems: 'center', gap: 14 }}>
        <Icon name="config" size={20}/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="kit-mlabel">Na estação de impressão (.28) agora</div>
          {stationOp && stationOp.stale ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 4, flexWrap: 'wrap' }}>
              <span className="sys-dot off"/>
              <span className="adm-note">
                último login foi de <b>{stationOp.name || '—'}</b>, mas está velho. Não dá pra confirmar quem está agora.
              </span>
            </div>
          ) : stationOp ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 4, flexWrap: 'wrap' }}>
              <span className={'sys-dot ' + (stationOp.active_now ? 'ok' : 'warn')}/>
              <b style={{ fontSize: 15, color: 'var(--primary-deep)' }}>{stationOp.name || 'sem nome'}</b>
              <span className={'kit-chip ' + (stationOp.active_now ? 'ok' : 'warn')}>
                {stationOp.active_now ? 'ativo agora' : 'parado há ' + fmtDur(Math.round((stationOp.last_seen_sec || 0) / 60))}
              </span>
              {stationOp.active_sec != null && (
                <span className="adm-note faint">{fmtDur(Math.round(stationOp.active_sec / 60))} ativo no PC</span>
              )}
            </div>
          ) : (
            <div className="adm-note" style={{ marginTop: 4 }}>ninguém logado (tela bloqueada esperando PIN)</div>
          )}
        </div>
      </div>

      {/* ── Etiquetas de envio de hoje (o que vai pro cliente) ── */}
      <ShippingLabelsPanel/>

      {/* ── Fila de impressão pedida pelo celular ── */}
      <MobileQueuePanel/>

      {/* ── Incidentes ABERTOS (impressora com problema agora) ── */}
      {incidents.length > 0 && (
        <div style={{ marginBottom: 18, display: 'grid', gap: 10 }} data-list="incidentes">
          {incidents.map((inc) => (
            <div key={inc.printer} className="kit-card pad bad">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <b style={{ fontSize: 14, color: 'var(--bad-deep)' }}>{inc.printer}</b>
                <span className="kit-chip bad">{inc.error || 'problema'}</span>
                <span style={{ flex: 1 }}/>
                {inc.down_seconds != null && <span className="kit-chip bad">parada há {fmtDur(inc.down_seconds)}</span>}
              </div>
              <div className="adm-note" style={{ marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {inc.tried_by && <span>tentou consertar: <b>{inc.tried_by}</b></span>}
                {inc.alerts > 0 && <span>{inc.alerts} alerta(s) enviado(s)</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Status físico ao vivo por impressora ── */}
      <div className="adm-sec" style={{ marginTop: 20 }}>
        <span className="kit-mlabel">Impressoras · estado físico</span>
        <span className="rule"/>
      </div>
      {printers.length === 0 ? (
        <div className="adm-state">
          Sem status ainda. O poller do .28 vai reportar assim que uma impressora mudar de estado.
          <div className="adm-note faint" style={{ marginTop: 8 }}>
            O fim físico real vem do canal ESC/Label da EPSON (~H(SMA,S, transição PR para IL).
          </div>
        </div>
      ) : (
        <div className="adm-grid two" style={{ marginBottom: 18 }} data-list="impressoras">
          {printers.map((p) => {
            const sv = statusView(p.status_label);
            const ink = p.ink || null;   // { color: pct } quando o canal trouxer
            const media = p.media || null;
            return (
              <div key={p.computer + '|' + p.printer} className="kit-card pad">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Icon name="factory" size={18}/>
                  <b style={{ fontSize: 14, flex: 1, color: 'var(--primary-deep)' }}>{p.printer}</b>
                  <span className={'kit-chip ' + sv.tone}>{sv.txt}</span>
                </div>
                {p.error_label && (
                  <div style={{ marginTop: 10 }}><span className="kit-chip bad">{p.error_label}</span></div>
                )}
                {ink && <InkPanel ink={ink}/>}
                {media && media.maint_box && (
                  <div style={{ marginTop: 12 }}>
                    <InkBar name="Caixa de manutenção" c={INK_COLORS.maint} level={media.maint_box}/>
                  </div>
                )}
                {media && media.warnings && media.warnings.length > 0 && (
                  <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {media.warnings.map((w) => (
                      <span key={w} className="kit-chip warn">{WARN_LABEL[w] || w}</span>
                    ))}
                  </div>
                )}
                <div className="adm-note faint" style={{ marginTop: 14, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <span>atualizado há {fmtAgo(p.age_sec)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{p.computer}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Spooler ao vivo (jobs em andamento) ── */}
      {activeJobs.length > 0 && (
        <>
          <div className="adm-sec" style={{ marginTop: 20 }}>
            <span className="kit-chip ok">ao vivo</span>
            <span className="kit-mlabel">Imprimindo agora · spooler</span>
            <span className="rule"/>
          </div>
          <div style={{ display: 'grid', gap: 10, marginBottom: 18 }}>
            {activeJobs.map((j) => (
              <div key={j.computer + '|' + j.job_id} className="kit-card pad">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 13.5, color: 'var(--primary-deep)' }}>{j.document || 'documento'}</b>
                  <span className="kit-chip neutral">{j.printer}</span>
                  <span style={{ flex: 1 }}/>
                  <span className="adm-note faint">{fmtDur(j.elapsed_sec)} decorrido</span>
                </div>
                {(j.total_pages || 0) > 1 && j.pct != null ? (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                      <span className="kit-mlabel">{(j.pages_printed || 0)}/{j.total_pages || '?'} pág</span>
                      <span className="adm-note faint">
                        {j.eta_sec != null ? '~' + fmtDur(j.eta_sec) + ' restante (spooler)' : j.pct + '%'}
                      </span>
                    </div>
                    <div className="adm-bar-track" style={{ height: 10 }}>
                      <div className="adm-bar-fill" style={{ width: Math.max(0, Math.min(100, j.pct)) + '%' }}/>
                    </div>
                    <div className="adm-note faint" style={{ marginTop: 7 }}>
                      A barra é o spooler (dados enviados). O fim físico real vem do estado da impressora acima.
                    </div>
                  </div>
                ) : (
                  // PDF (Acrobat): o spooler não sabe o total ("1 página") — sem barra
                  // falsa. A contagem REAL vem do contador da impressora no fim físico.
                  <div className="adm-note faint" style={{ marginTop: 8 }}>
                    PDF: o spooler não informa o total. A impressora conta os labels e o número real entra no
                    registro quando ela terminar (estado acima).
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
          <div className="adm-sec" style={{ marginTop: 20 }}>
            <span className="kit-mlabel">Hoje · por impressora, operador e produto</span>
            <span className="rule"/>
          </div>
          <div className="adm-grid three" style={{ marginBottom: 18 }}>
            <BreakdownCard title="Por impressora" rows={byPrinter} nameKey="printer"/>
            <BreakdownCard title="Por operador" rows={byOperator} nameKey="operator"/>
            <BreakdownCard title="Por produto" rows={byProduct} nameKey="product"/>
          </div>
        </>
      )}

      {/* ── Histórico ── */}
      <div className="adm-sec" style={{ marginTop: 20 }}>
        <span className="kit-mlabel">Últimas impressões</span>
        <span className="rule"/>
      </div>
      {history.length === 0 ? (
        <div className="adm-state">Nenhuma impressão registrada ainda.</div>
      ) : (
        <div className="kit-card pad">
          <div style={{ overflowX: 'auto' }}>
            <table className="kit-table" data-table="historico">
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Operador</th>
                  <th>Documento</th>
                  <th>Produto · Batch</th>
                  <th className="num">Labels</th>
                  <th className="num" title="Tempo FÍSICO que a impressora levou (PR para IL)">Impressão</th>
                  <th className="num">Ativo no PC</th>
                  <th>Impressora</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td style={{ font: '500 12px var(--font-mono)', whiteSpace: 'nowrap' }}>{fmtClock(h.completed_at || h.created_at)}</td>
                    <td>
                      {h.operator || h.operator_fallback || <span className="kit-chip neutral">sem PIN</span>}
                    </td>
                    <td style={{ maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.document}>{h.document || '—'}</td>
                    <td>
                      {h.product ? (
                        <span><b>{h.product}</b>{h.batch && <span className="kit-chip neutral" style={{ marginLeft: 6 }}>{h.batch}</span>}</span>
                      ) : (
                        <span className={'kit-chip ' + (h.has_batch === false ? 'warn' : 'neutral')}>
                          {h.has_batch === false ? 'sem batch' : 'não identificado'}
                        </span>
                      )}
                    </td>
                    <td className="num"><b>{h.sheets || '—'}</b></td>
                    <td className="num">{h.print_seconds ? fmtDur(h.print_seconds) : '—'}</td>
                    <td className="num">{h.session_active_sec ? fmtDur(h.session_active_sec) : '—'}</td>
                    <td style={{ color: 'var(--ink-dim)', fontSize: 12.5 }}>{h.printer || '—'}</td>
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
          <summary style={{ cursor: 'pointer' }}>
            <span className="kit-mlabel">Histórico de problemas ({errorLog.length}) · sem papel, atolou, sem tinta</span>
          </summary>
          <div className="kit-card pad" style={{ marginTop: 8 }}>
            {errorLog.map((e, i) => (
              <div key={i} className="kit-dotted-row">
                <span style={{ font: '500 12px var(--font-mono)', color: 'var(--ink-faint)' }}>{fmtClock(e.at)}</span>
                <span className="kit-chip bad">{e.error_label}</span>
                <span className="adm-note">{e.printer}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* ── Transições de status (debug/telemetria do físico) ── */}
      {transitions.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer' }}>
            <span className="kit-mlabel">Transições de status recentes ({transitions.length}) · telemetria do fim físico</span>
          </summary>
          <div className="kit-card pad" style={{ marginTop: 8 }}>
            {transitions.map((t, i) => {
              const sv = statusView(t.status_label);
              return (
                <div key={i} className="kit-dotted-row">
                  <span style={{ font: '500 12px var(--font-mono)', color: 'var(--ink-faint)' }}>{fmtClock(t.at)}</span>
                  <span className={'kit-chip ' + sv.tone}>{sv.txt}</span>
                  <span className="adm-note">{t.printer}</span>
                  {t.error_label && <span className="kit-chip bad">{t.error_label}</span>}
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
    <div className="kit-card pad">
      <div className="adm-sec"><span className="kit-mlabel">{title}</span><span className="rule"/></div>
      {rows.length === 0 ? (
        <div className="adm-empty">Sem dados</div>
      ) : rows.slice(0, 6).map((r, i) => (
        <div key={i} style={{ marginBottom: 9 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4, gap: 8 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r[nameKey]}</span>
            <b style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>{r.labels}</b>
          </div>
          <div className="adm-bar-track">
            <div className="adm-bar-fill" style={{ width: Math.round(((r.labels || 0) / max) * 100) + '%' }}/>
          </div>
        </div>
      ))}
    </div>
  );
}

window.PrintingPage = PrintingPage;
export { PrintingPage };
