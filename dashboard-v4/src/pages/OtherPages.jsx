import React from 'react';
import { Icon, Leaf } from '../components/Icons.jsx';
import { KPI, CapBar, CountdownCard, OperatorAvatar } from '../components/Primitives.jsx';

/* Production, Goals, People + light placeholders for the rest. */

// ============ Production ============
// E7-resto Leva 2: ligada em raw.production.lotes (vem direto do backend
// com o flow=production já filtrado e fase/duração calculadas).
function ProductionPage({ state, hfdata, raw, openPanel, loading, error, date }) {
  const HFD = hfdata || window.HFData;
  const { operators = [], activities = {}, goals: hfGoals = [] } = HFD;
  const lotes = (raw && raw.production && raw.production.lotes) || [];
  const now = window.HFH.useNow(true);
  const { fmtDur } = window.HFH;
  if (loading) return <div className="card" style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)' }}>Carregando lotes…</div>;

  // Sort: lotes com mais tempo primeiro (mais ativos)
  const sortedLotes = lotes.slice().sort((a, b) => (b.total_seconds || 0) - (a.total_seconds || 0));

  return (
    <div>
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Lotes em produção</h2><span className="en">· Batches in production</span>
        <div className="rule"/>
      </div>
      {sortedLotes.length === 0 && (
        <div className="card" style={{ padding: 30, color: 'var(--text-3)', textAlign: 'center' }}>
          Sem lotes em produção em {date || 'hoje'}.
        </div>
      )}
      {sortedLotes.map((lote) => {
        const productName = (lote.product && lote.product.canonical_name) || '(sem produto)';
        const batchNumber = lote.batch_number || '(sem batch)';
        const totalMin = Math.round((lote.total_seconds || 0) / 60);
        // events do dia que apontam pra esse lote — pra derivar live state + crew
        const loteKey = lote.batch_id != null ? ('b' + lote.batch_id) : null;
        const loteEvents = loteKey ? state.events.filter((e) => e.product === loteKey) : [];
        const liveCount = loteEvents.filter((e) => e.ended_min == null).length;
        // Goal vinculado por chave 'b<batch_id>'
        const goal = hfGoals.find((g) => g.product === loteKey);
        const pct = goal && goal.target > 0 ? Math.min(100, Math.round((goal.done / goal.target) * 100)) : null;
        // Crew vem do backend (display_names); enriquece com avatar se bater pelo nome
        const crewNames = (lote.people || []);
        const crewOps = crewNames.map((name) => operators.find((o) => o.name === name)).filter(Boolean);
        // Phases vêm do backend: [{activity, seconds}]
        const phaseList = (lote.phases || []).slice().sort((a, b) => (b.seconds || 0) - (a.seconds || 0));
        // dc_shipment é flow=production — aparece nas phases se houver

        return (
          <div key={lote.batch_id || productName} className="card lote-card" style={{ marginBottom: 12 }}>
            <div className="head">
              <Leaf size={16} color="var(--hf-leaf-500)"/>
              <h3>{productName}</h3>
              <span className="batch mono">{batchNumber}</span>
              {liveCount > 0 && <span className="pill live" style={{ marginLeft: 6 }}><span className="dot"/>{liveCount} live</span>}
              <span style={{ flex: 1 }}/>
              <div className="crew" style={{ display: 'flex', gap: 4 }}>
                {crewOps.slice(0, 5).map((o) => <OperatorAvatar key={o.id} op={o} size="md"/>)}
                {crewNames.length > crewOps.length && (
                  <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 4 }}>+{crewNames.length - crewOps.length}</span>
                )}
              </div>
            </div>
            {goal && (
              <div style={{ marginTop: 6 }}>
                <CapBar pct={pct} size="lg"
                        label={`Meta: ${goal.done}/${goal.target} ${goal.unit || 'bottle'}`}
                        sub={`${pct}% ${goal.completed ? '✓ batido' : 'em curso'}`}
                        color1={pct >= 100 ? 'var(--hf-leaf-500)' : 'var(--hf-navy-500)'}
                        color2={pct >= 100 ? 'var(--hf-leaf-600)' : 'var(--hf-leaf-500)'}/>
              </div>
            )}
            <div className="esteira" style={{ marginTop: 8 }}>
              {phaseList.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>sem fases ainda</div>
              ) : phaseList.map((p, i) => {
                const phaseMin = Math.round((p.seconds || 0) / 60);
                return (
                  <React.Fragment key={p.activity}>
                    <div className="fase done">
                      <div className="ind"/>
                      <div className="nm">{p.activity}</div>
                      <div className="du">{fmtDur(phaseMin)}</div>
                    </div>
                    {i < phaseList.length - 1 && <div className="fase-arrow"><Icon name="right" size={14}/></div>}
                  </React.Fragment>
                );
              })}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8, display: 'flex', gap: 14 }}>
              <span>Tempo total no lote · <b className="mono" style={{ color: 'var(--text-2)' }}>{fmtDur(totalMin)}</b></span>
              {lote.invalid_event_count > 0 && (
                <span style={{ color: 'var(--warn)' }}>⚠ {lote.invalid_event_count} event(s) com duração inválida</span>
              )}
              {loteEvents.length > 0 && (
                <span style={{ marginLeft: 'auto' }}>{loteEvents.length} eventos · clique no Hoje pra detalhe</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============ Goals ============
// E7-resto Leva 2: ligada em hfdata.goals (adapted) + raw.goals.goals (cru).
// hfdata.goals já tem pct/done/target/unit/completed/_product_name/_batch_number.
// Edição preview: V4_ALLOW_WRITES=0 → save toasta liga-no-E5.
function GoalsPage({ state, hfdata, ack, loading, error, date }) {
  const HFD = hfdata || window.HFData;
  const { goals = [] } = HFD;
  const { fmtDur } = window.HFH;
  if (loading) return <div className="card" style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)' }}>Carregando metas…</div>;
  return (
    <div>
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Metas do dia</h2><span className="en">· Today's goals</span>
        <div className="rule"/>
      </div>
      {goals.length === 0 && (
        <div className="card" style={{ padding: 30, color: 'var(--text-3)', textAlign: 'center' }}>
          Sem metas registradas em {date || 'hoje'}.
        </div>
      )}
      <div className="goals-grid">
        {goals.map((g) => {
          const productName = g._product_name || '(produto)';
          const batchNumber = g._batch_number || '';
          const pct = g.pct != null ? g.pct : (g.target > 0 ? Math.round((g.done / g.target) * 100) : 0);
          const hit = !!g.completed || pct >= 100;
          // events que viraram contagem (livre de duplicatas) — pra deduzir "iniciado às"
          // Não temos started_at por goal no adapter; mostra count de duplicatas se houver.
          const dupCount = (g.duplicatas_suspeitas || []).length;
          return (
            <div key={g.id} className="card goal-card">
              <div className="head">
                <Leaf size={14} color="var(--hf-leaf-500)"/>
                <h3>{productName}</h3>
                {batchNumber && <span className="batch mono">{batchNumber}</span>}
                <span style={{ flex: 1 }}/>
                {hit && <span className="pill ok"><span className="dot"/>batido</span>}
                {!hit && pct >= 80 && <span className="pill warn"><span className="dot"/>quase lá</span>}
                {!hit && pct < 80 && <span className="pill prod"><span className="dot"/>em curso</span>}
              </div>
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <div className="num">{(g.done || 0).toLocaleString()}<small> / {(g.target || 0).toLocaleString()} {g.unit || 'bottle'}</small></div>
                <span style={{ flex: 1 }}/>
                <div className={`num ${hit ? 'pct-ok' : pct >= 80 ? 'pct-warn' : ''}`}>{pct}%</div>
              </div>
              <div style={{ marginTop: 12 }}>
                <CapBar pct={pct} size="xl"
                        color1={hit ? 'var(--hf-leaf-500)' : 'var(--hf-navy-500)'}
                        color2={hit ? 'var(--hf-leaf-600)' : 'var(--hf-leaf-500)'}/>
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 14, fontSize: 12, color: 'var(--text-3)', alignItems: 'center' }}>
                {dupCount > 0 && (
                  <span style={{ color: 'var(--warn)' }}>⚠ {dupCount} contagem(ns) duplicata(s) suspeita(s)</span>
                )}
                <span style={{ flex: 1 }}/>
                <button className="btn sm ghost" onClick={() => ack && ack(`preview · PATCH /goals/${g.id} liga no E5`)}>
                  <Icon name="edit" size={12}/>Editar
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ People ============
// E7-resto Leva 1: ligada em hfdata real (operators só dos que postaram —
// admins filtrados no adapter). Cada lane mini-tl mostra todos os events
// do dia da pessoa; o título de cada person-card destaca a atividade ATUAL
// (live) com produto+batch resolvidos.
function PeoplePage({ state, hfdata, openPanel, ack, loading, error, date }) {
  const HFD = hfdata || window.HFData;
  const { operators = [], activities = {}, products = {}, DAY_START = 480, DAY_END = 1260, _gaps = {} } = HFD;
  const now = window.HFH.useNow(true);
  const { fmtCron, fmtDur, fmtClock } = window.HFH;
  const dayMin = DAY_END - DAY_START;
  if (loading) {
    return <div className="card" style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)' }}>Carregando equipe…</div>;
  }
  if (operators.length === 0) {
    return <div className="card" style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)' }}>
      Sem operadores postando em {date || 'hoje'} · (admins filtrados)
    </div>;
  }

  return (
    <div>
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Equipe</h2><span className="en">· Team today</span>
        <div className="rule"/>
      </div>
      <div className="people-grid">
        {operators.map(op => {
          const opEvents = (state.events || []).filter(e => e.op === op.id)
            .sort((a, b) => a.started_min - b.started_min);
          const live = opEvents.find(e => e.ended_min == null && !e._is_background);
          const liveBg = opEvents.filter(e => e.ended_min == null && e._is_background);
          const closed = opEvents.filter(e => e.ended_min != null);
          const totalActive = closed.reduce((s, e) => s + (e.ended_min - e.started_min), 0)
            + (live ? (now - live.started_min) : 0);
          const productsCount = new Set(opEvents.filter(e => e.product).map(e => e.product)).size;
          const last = opEvents[opEvents.length - 1];
          const cur = live || last;
          const curAct = cur ? activities[cur.activity] : null;
          const curProd = cur?.product ? products[cur.product] : null;
          const gap = _gaps[op.id] || {};

          return (
            <div key={op.id} className="card person-card">
              <div className="head">
                <OperatorAvatar op={op} size="lg"/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em" }}>{op.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-3)" }}>{op.role}</div>
                </div>
                {live
                  ? <span className="pill live"><span className="dot"/>ao vivo</span>
                  : <span className="pill"><span className="dot"/>parado</span>}
              </div>
              <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10 }}>
                <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.08, color: "var(--text-3)", fontWeight: 700 }}>
                  {live ? "Agora · Now" : "Último · Last"}
                </div>
                {curAct ? (
                  <>
                    <div style={{ fontWeight: 700, fontSize: 14, marginTop: 3 }}>{curAct.name}</div>
                    {curProd && <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                      {curProd.name}{curProd.batch && <span className="mono" style={{ marginLeft: 6, color: 'var(--text-3)' }}>· {curProd.batch}</span>}
                    </div>}
                    <div className="mono" style={{ fontSize: 13, color: "var(--hf-navy-600)", marginTop: 5 }}>
                      {live
                        ? `⏱ ${fmtCron(now - cur.started_min)}`
                        : `${fmtDur((cur.ended_min || 0) - (cur.started_min || 0))} (encerrou ${fmtClock(cur.ended_min)})`}
                    </div>
                  </>
                ) : <div style={{ fontSize: 13, color: "var(--text-3)" }}>sem registros</div>}
                {liveBg.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                    + {liveBg.length} background ativo(s): {liveBg.map(e => activities[e.activity]?.name || e.activity).join(', ')}
                  </div>
                )}
              </div>
              <div className="stats">
                <div className="stat"><div className="label">Eventos</div><div className="value">{opEvents.length}</div></div>
                <div className="stat"><div className="label">Tempo ativo</div><div className="value mono">{fmtDur(totalActive)}</div></div>
                <div className="stat"><div className="label">Produtos</div><div className="value">{productsCount}</div></div>
              </div>
              {(gap.idle_seconds || gap.unreported_seconds) ? (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)', display: 'flex', gap: 8 }}>
                  {gap.idle_seconds > 0 && <span>idle {fmtDur(Math.round(gap.idle_seconds / 60))}</span>}
                  {gap.unreported_seconds > 0 && <span style={{ color: 'var(--warn)' }}>não reportado {fmtDur(Math.round(gap.unreported_seconds / 60))}</span>}
                </div>
              ) : null}
              <div className="mini-tl" style={{ marginTop: 8 }}>
                {opEvents.map(ev => {
                  const a = activities[ev.activity]; if (!a) return null;
                  const end = ev.ended_min == null ? now : ev.ended_min;
                  const left = ((ev.started_min - DAY_START) / dayMin) * 100;
                  const width = Math.max(0.5, ((end - ev.started_min) / dayMin) * 100);
                  const productName = ev.product ? (products[ev.product]?.name || '') : '';
                  return (
                    <button key={ev.id} className="mini-bk"
                            style={{ left: `${left}%`, width: `${width}%`,
                                     background: `linear-gradient(180deg, var(--flow-${a.flow}), var(--flow-${a.flow}-2))`,
                                     border: 'none', cursor: 'pointer', padding: 0 }}
                            onClick={(e) => openPanel && openPanel(ev, { x: e.clientX, y: e.clientY })}
                            title={`${a.name}${productName ? ' · ' + productName : ''} · ${fmtClock(ev.started_min)}`}/>
                  );
                })}
                <div className="mini-now" style={{ left: `${((now - DAY_START) / dayMin) * 100}%` }}/>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ Placeholders (Pick & Pack, Support, Product, Falar, Planejamento, Config) ============
function PlaceholderPage({ icon, pt, en, subtitle, body }) {
  return (
    <div className="card placeholder">
      <div className="ic"><Icon name={icon} size={28}/></div>
      <h2>{pt} <span style={{ color: "var(--text-3)", fontWeight: 500, fontSize: 13 }}>· {en}</span></h2>
      <p>{subtitle}</p>
      {body}
    </div>
  );
}

function PickPackPage({ state, hfdata, raw, openPanel, loading, error, date }) {
  // E7-resto Leva 1: ligada em hfdata real.
  // Sub-passos reais do /api/v3/data/pp:
  //   pp.sub_steps = [{activity, seconds (pessoa-hora soma), wall_seconds (união)}]
  //   pp.person_seconds = [{person, seconds}]
  //   pp.total_seconds = união do tempo de parede (sem dupla contagem cowork)
  // ANTES estava com 4 sub-passos HARDCODED ("Impressão 20m feito, Etiquetagem
  // 105m feito…") — agora vem do backend.
  const HFD = hfdata || window.HFData;
  const { pp = {}, activities = {}, products = {} } = HFD;
  const ppRaw = (raw && raw.pp) || pp._raw || {};
  const now = window.HFH.useNow(true);
  const { fmtDur, fmtClock } = window.HFH;
  const events = state.events || [];

  if (loading) {
    return <div className="card" style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)' }}>Carregando P&P…</div>;
  }

  // Sub-passos: usa wall_seconds (união) — Bruno pediu específico "não soma".
  const subSteps = (ppRaw.sub_steps || []).slice().sort((a, b) => (b.wall_seconds || 0) - (a.wall_seconds || 0));
  const personSeconds = ppRaw.person_seconds || [];
  // Cowork: events de P&P (flow=pnp) com cowork.length > 0
  const ppEvents = events.filter((e) => (activities[e.activity] || {}).flow === 'pnp');
  const coworkEvents = ppEvents.filter((e) => e.cowork && e.cowork.length > 0);
  const liveCount = ppEvents.filter((e) => e.ended_min == null).length;
  // Correio: do pp.deadline_min real
  const correioMin = pp.deadline_min;
  return (
    <div>
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Pick & Pack do dia</h2><span className="en">· Today's P&P block</span>
        <div className="rule"/>
      </div>
      <div className="card" style={{ padding: 22 }}>
        {correioMin != null && (
          <CountdownCard deadlineMin={correioMin} now={now}
                         label="Correio" en="Mailing cut-off"
                         title={`Próximo corte às ${fmtClock(correioMin)}`}/>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginTop: 18 }}>
          <KPI label="Tempo total (união)" en="Wall time"
               value={pp.total_minutes ? fmtDur(pp.total_minutes) : '—'}
               foot={<div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                 {liveCount > 0 ? `${liveCount} live` : 'sem live'}
               </div>}/>
          <KPI label="Ordens" en="Orders"
               value={pp.orders ? pp.orders.toLocaleString() : '—'}/>
          <KPI label="Tempo/ordem" en="Per order"
               value={pp.seconds_per_order ? `${pp.seconds_per_order}s` : '—'}/>
        </div>
        <div className="section-title" style={{ marginTop: 14 }}>
          <h2>Sub-passos</h2><span className="en">· Steps (union wall-time)</span><div className="rule"/>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {subSteps.length === 0 ? (
            <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 13 }}>
              Nenhum sub-passo de P&P registrado em {date || 'hoje'}.
            </div>
          ) : subSteps.map((s) => {
            const wallMin = Math.round((s.wall_seconds || 0) / 60);
            const sumMin = Math.round((s.seconds || 0) / 60);
            const cowork = sumMin > wallMin;   // pessoa-hora > parede → houve cowork
            return (
              <div key={s.activity} className="alert-row" style={{ background: "var(--surface-2)" }}>
                <div className="ico"><Icon name="clock" size={14}/></div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{s.activity}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)" }} className="mono">
                    parede {fmtDur(wallMin)}{cowork && <> · pessoa-hora {fmtDur(sumMin)} <span style={{ color: 'var(--hf-leaf-600)' }}>(cowork)</span></>}
                  </div>
                </div>
                <span className="pill prod"><span className="dot"/>{fmtDur(wallMin)}</span>
              </div>
            );
          })}
        </div>
        {personSeconds.length > 0 && (
          <>
            <div className="section-title" style={{ marginTop: 14 }}>
              <h2>Carga por pessoa</h2><span className="en">· Person-hour load</span><div className="rule"/>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
              {personSeconds.sort((a, b) => b.seconds - a.seconds).map((ps) => (
                <div key={ps.person} className="alert-row" style={{ background: 'var(--surface-2)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>{ps.person}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)' }} className="mono">{fmtDur(Math.round(ps.seconds / 60))}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {coworkEvents.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-3)' }}>
            🔗 {coworkEvents.length} event(s) com cowork ativo no P&P
          </div>
        )}
      </div>
    </div>
  );
}

// E7-resto Leva 2: usa raw.support.occurrences (vem do flow-views-repo,
// já com is_downtime calculado pra slug=repair). Inclui também
// clinic_shipment (injeções) que é flow=support.
function SupportPage({ state, hfdata, raw, openPanel, loading, date }) {
  const HFD = hfdata || window.HFData;
  const { operators = [] } = HFD;
  const occurrences = (raw && raw.support && raw.support.occurrences) || [];
  const { fmtClock, fmtDur } = window.HFH;
  const now = window.HFH.useNow(true);
  if (loading) return <div className="card" style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)' }}>Carregando suporte…</div>;
  // Sorted by started_at asc
  const sorted = occurrences.slice().sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  // Mapping ISO NY → minutes-since-midnight pra reutilizar fmtClock
  const isoToMin = (iso) => {
    if (!iso) return null;
    const s = String(iso);
    return Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));
  };
  // Agrega contagens por tipo
  const counts = sorted.reduce((m, o) => { m[o.activity] = (m[o.activity] || 0) + 1; return m; }, {});
  const downtimeCount = sorted.filter((o) => o.is_downtime).length;

  return (
    <div>
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Suporte · ocorrências</h2><span className="en">· Support log</span>
        <div className="rule"/>
      </div>
      <div className="card" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5 }}>
          <div><b>{sorted.length}</b> ocorrência(s) em {date || 'hoje'}</div>
          {downtimeCount > 0 && <div style={{ color: 'var(--bad)' }}><b>{downtimeCount}</b> downtime (conserto)</div>}
          {Object.entries(counts).slice(0, 6).map(([act, c]) => (
            <div key={act} style={{ color: 'var(--text-3)' }}><b style={{ color: 'var(--text-2)' }}>{c}</b> {act}</div>
          ))}
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: 'var(--surface-2)' }}>
            <tr>
              <th style={th}>Atividade · Activity</th>
              <th style={th}>Pessoa · Person</th>
              <th style={th}>Início · Start</th>
              <th style={th}>Duração · Duration</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: 'var(--text-3)' }}>
                Sem ocorrências de suporte registradas.
              </td></tr>
            )}
            {sorted.map((o) => {
              const op = operators.find((x) => x.name === o.person);
              const startMin = isoToMin(o.started_at);
              const endMin = o.ended_at ? isoToMin(o.ended_at) : null;
              const durMin = o.seconds != null ? Math.round(o.seconds / 60) : (endMin != null ? endMin - startMin : (now - startMin));
              const live = !o.ended_at;
              return (
                <tr key={o.event_id} style={{ borderTop: '1px solid var(--border)', cursor: openPanel ? 'pointer' : 'default' }}
                    onClick={(e) => {
                      if (!openPanel) return;
                      const ev = state.events.find((x) => x.id === o.event_id);
                      if (ev) openPanel(ev, { x: e.clientX, y: e.clientY });
                    }}>
                  <td style={td}>
                    <span className="pill support"><span className="dot"/>{o.activity}</span>
                    {o.is_downtime && <span className="pill bad" style={{ marginLeft: 6 }}><span className="dot"/>downtime</span>}
                  </td>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {op && <OperatorAvatar op={op} size="md"/>}
                      <b>{o.person || '—'}</b>
                    </div>
                  </td>
                  <td style={{ ...td, fontFamily: 'JetBrains Mono, monospace' }}>{startMin != null ? fmtClock(startMin) : '—'}</td>
                  <td style={{ ...td, fontFamily: 'JetBrains Mono, monospace' }}>{fmtDur(durMin)}</td>
                  <td style={td}>
                    {live
                      ? <span className="pill live"><span className="dot"/>ao vivo</span>
                      : <span style={{ color: 'var(--text-3)', fontSize: 12 }}>fechado</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
const th = { padding: "10px 14px", textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.06, color: "var(--text-3)", fontWeight: 700 };
const td = { padding: "12px 14px", fontSize: 13 };

function ProductPage()  { return <PlaceholderPage icon="product" pt="Produto" en="Product" subtitle="Histórico por produto + contagens. Em construção nesta versão do mockup — Claude Code pode editar baseado nas necessidades."/>; }
function FalarPage()    { return <PlaceholderPage icon="chat"    pt="Falar"   en="Speak"   subtitle="Porta de saída manual (postar como Carolina). Em construção."/>; }
function PlanPage()     { return <PlaceholderPage icon="plan"    pt="Planejamento" en="Planning" subtitle="Tasks futuras, o que vem pela frente, notificação opcional por task. Em construção."/>; }
function ConfigPage()   { return <PlaceholderPage icon="config"  pt="Config"  en="Settings" subtitle="CRUD de Deadlines, thresholds, expedient_end, expected_seconds dos backgrounds. Em construção."/>; }
function CarolinaPage() { return <PlaceholderPage icon="chat"    pt="Carolina" en="Carolina" subtitle="Chat de aprendizado da Carolina (Bloco 5). Placeholder no E0 — UI desenhada depois."/>; }

Object.assign(window, { ProductionPage, GoalsPage, PeoplePage, PickPackPage, SupportPage, ProductPage, FalarPage, PlanPage, ConfigPage, CarolinaPage });

export { ProductionPage, GoalsPage, PeoplePage, PickPackPage, SupportPage, ProductPage, FalarPage, PlanPage, ConfigPage, CarolinaPage, PlaceholderPage };
