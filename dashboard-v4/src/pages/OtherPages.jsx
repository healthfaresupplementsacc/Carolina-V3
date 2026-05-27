import React from 'react';
import { Icon, Leaf } from '../components/Icons.jsx';
import { KPI, CapBar, CountdownCard, OperatorAvatar } from '../components/Primitives.jsx';

/* Production, Goals, People + light placeholders for the rest. */

// ============ Production ============
function ProductionPage({ state }) {
  const { events, operators, activities, products, goals } = window.HFData;
  const now = window.HFH.useNow(true);
  const { fmtDur, fmtClock } = window.HFH;

  // Group events by product/batch (lote)
  const loteMap = {};
  for (const ev of state.events) {
    if (!ev.product) continue;
    const k = ev.product;
    loteMap[k] = loteMap[k] || { product: products[k], events: [], crew: new Set() };
    loteMap[k].events.push(ev);
    loteMap[k].crew.add(ev.op);
    (ev.cowork || []).forEach(c => loteMap[k].crew.add(c));
  }
  const lotes = Object.entries(loteMap).map(([id, l]) => ({ id, ...l, crew: [...l.crew] }))
                .sort((a,b) => (b.events[0]?.started_min || 0) - (a.events[0]?.started_min || 0));

  // Group by phase (activity) per product
  return (
    <div>
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Lotes em produção</h2><span className="en">· Batches in production</span>
        <div className="rule"/>
      </div>
      {lotes.map(lote => {
        const phases = {};
        lote.events.forEach(ev => {
          const a = activities[ev.activity]; if (!a || a.flow !== "production") return;
          phases[ev.activity] = phases[ev.activity] || { activity: a, total: 0, live: false };
          const end = ev.ended_min == null ? now : ev.ended_min;
          phases[ev.activity].total += end - ev.started_min;
          if (ev.ended_min == null) phases[ev.activity].live = true;
        });
        const phaseList = Object.values(phases).sort((a,b) => a.activity.name.localeCompare(b.activity.name));
        const total = lote.events.reduce((s, ev) => {
          const end = ev.ended_min == null ? now : ev.ended_min;
          return s + (end - ev.started_min);
        }, 0);
        const goal = goals.find(g => g.product === lote.id);
        const pct = goal ? Math.min(100, Math.round((goal.done / goal.target) * 100)) : null;

        return (
          <div key={lote.id} className="card lote-card">
            <div className="head">
              <Leaf size={16} color="var(--hf-leaf-500)"/>
              <h3>{lote.product.name}</h3>
              <span className="batch">{lote.product.batch}</span>
              <span className="pill prod" style={{ marginLeft: 6 }}><span className="dot"/>{lote.product.category}</span>
              <span style={{ flex: 1 }}/>
              <div className="crew">
                {lote.crew.slice(0,5).map(c => {
                  const o = operators.find(x => x.id === c);
                  return o ? <OperatorAvatar key={c} op={o} size="md"/> : null;
                })}
              </div>
            </div>
            {goal && (
              <div style={{ marginTop: 6 }}>
                <CapBar pct={pct} size="lg" label={`Meta · Goal: ${goal.done}/${goal.target}`} sub={`${pct}% ${goal.completed ? "✓ batido" : "em curso"}`}
                        color1={pct >= 100 ? "var(--hf-leaf-500)" : "var(--hf-navy-500)"}
                        color2={pct >= 100 ? "var(--hf-leaf-600)" : "var(--hf-leaf-500)"}/>
              </div>
            )}
            <div className="esteira">
              {phaseList.map((p, i) => (
                <React.Fragment key={p.activity.name}>
                  <div className={`fase ${p.live ? "live" : "done"}`}>
                    <div className="ind"/>
                    <div className="nm">{p.activity.name}</div>
                    <div className="du">{fmtDur(p.total)}{p.live && <span style={{ color: "var(--hf-navy-500)", marginLeft: 4 }}>● live</span>}</div>
                  </div>
                  {i < phaseList.length - 1 && <div className="fase-arrow"><Icon name="right" size={14}/></div>}
                </React.Fragment>
              ))}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4 }}>
              Tempo total no lote · <b className="mono" style={{ color: "var(--text-2)" }}>{fmtDur(total)}</b>
              {goal && <> · iniciou {fmtClock(goal.started_min)}</>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============ Goals ============
function GoalsPage({ state }) {
  const { products, goals } = window.HFData;
  const now = window.HFH.useNow(true);
  const { fmtClock, fmtDur } = window.HFH;
  return (
    <div>
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Metas do dia</h2><span className="en">· Today's goals</span>
        <div className="rule"/>
      </div>
      <div className="goals-grid">
        {goals.map(g => {
          const p = products[g.product];
          const pct = Math.min(100, Math.round((g.done / g.target) * 100));
          const hit = g.completed || pct >= 100;
          return (
            <div key={g.id} className="card goal-card">
              <div className="head">
                <Leaf size={14} color="var(--hf-leaf-500)"/>
                <h3>{p.name}</h3>
                <span className="batch">{p.batch}</span>
                <span style={{ flex: 1 }}/>
                {hit && <span className="pill ok"><span className="dot"/>batido · hit</span>}
                {!hit && pct >= 80 && <span className="pill warn"><span className="dot"/>quase lá · almost</span>}
                {!hit && pct < 80 && <span className="pill prod"><span className="dot"/>em curso · in progress</span>}
              </div>
              <div style={{ marginTop: 10, display: "flex", alignItems: "baseline", gap: 10 }}>
                <div className="num">{g.done.toLocaleString()}<small> / {g.target.toLocaleString()} {g.unit}</small></div>
                <span style={{ flex: 1 }}/>
                <div className={`num ${hit ? "pct-ok" : pct >= 80 ? "pct-warn" : ""}`}>{pct}%</div>
              </div>
              <div style={{ marginTop: 12 }}>
                <CapBar pct={pct} size="xl"
                        color1={hit ? "var(--hf-leaf-500)" : "var(--hf-navy-500)"}
                        color2={hit ? "var(--hf-leaf-600)" : "var(--hf-leaf-500)"}/>
              </div>
              <div style={{ marginTop: 10, display: "flex", gap: 14, fontSize: 12, color: "var(--text-3)" }}>
                <span>iniciou <b className="mono" style={{ color: "var(--text-2)" }}>{fmtClock(g.started_min)}</b></span>
                <span>há <b className="mono" style={{ color: "var(--text-2)" }}>{fmtDur(now - g.started_min)}</b></span>
                <span style={{ flex: 1 }}/>
                <button className="btn sm ghost"><Icon name="edit" size={12}/>Editar</button>
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

function SupportPage({ state }) {
  const { activities, operators } = window.HFData;
  const { fmtClock, fmtDur } = window.HFH;
  const now = window.HFH.useNow(true);
  const supportEvents = state.events
    .filter(e => activities[e.activity]?.flow === "support")
    .filter(e => ["conserto","limpeza","organizacao"].includes(e.activity))
    .sort((a,b) => a.started_min - b.started_min);
  return (
    <div>
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Suporte · ocorrências</h2><span className="en">· Support log</span>
        <div className="rule"/>
      </div>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead style={{ background: "var(--surface-2)" }}>
            <tr>
              <th style={th}>Atividade · Activity</th>
              <th style={th}>Pessoa · Person</th>
              <th style={th}>Início · Start</th>
              <th style={th}>Duração · Duration</th>
              <th style={th}>Descrição · Note</th>
            </tr>
          </thead>
          <tbody>
            {supportEvents.map(e => {
              const a = activities[e.activity];
              const op = operators.find(x => x.id === e.op);
              const end = e.ended_min == null ? now : e.ended_min;
              const isRepair = e.activity === "conserto";
              return (
                <tr key={e.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={td}>
                    <span className={`pill support`}><span className="dot"/>{a.name}</span>
                    {isRepair && <span className="pill bad" style={{ marginLeft: 6 }}><span className="dot"/>downtime</span>}
                  </td>
                  <td style={td}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><OperatorAvatar op={op} size="md" style={{ width: 26, height: 26, fontSize: 11 }}/><b>{op?.name}</b></div></td>
                  <td style={{ ...td, fontFamily: "JetBrains Mono, monospace" }}>{fmtClock(e.started_min)}</td>
                  <td style={{ ...td, fontFamily: "JetBrains Mono, monospace" }}>{fmtDur(end - e.started_min)}</td>
                  <td style={{ ...td, color: "var(--text-3)" }}>{e.description || "—"}</td>
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
