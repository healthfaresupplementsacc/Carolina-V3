import React from 'react';
import { Icon, Leaf } from '../components/Icons.jsx';
import { KPI, CapBar, CountdownCard, FlowDot } from '../components/Primitives.jsx';
import { Timeline } from '../components/Timeline.jsx';

/* Command Center — the main "Hoje" view.
   KPI strip, deadline countdown, alerts, filters, timeline.
*/

function CommandCenter({ state, setState, openPanel, newEventTrigger, ack }) {
  const now = window.HFH.useNow(true);
  const { operators, events, goals, alerts, products, pp, DEADLINE_MIN } = window.HFData;

  // Resolve live state events
  const { fmtClock, fmtDur, fmtCron } = window.HFH;

  // Local interaction state
  const [filterOps, setFilterOps] = React.useState(new Set());
  const [filterFlows, setFilterFlows] = React.useState(new Set());
  const [hourPx, setHourPx] = React.useState(state.density === "compact" ? 110 : 140);
  React.useEffect(() => { setHourPx(state.density === "compact" ? 110 : 140); }, [state.density]);

  // Calculate live KPIs
  const liveProd = events.filter(ev => {
    const act = window.HFData.activities[ev.activity];
    return act && act.flow === "production" && ev.qty;
  }).reduce((sum, ev) => sum + (ev.qty || 0), 0);
  const liveGoalsActive = goals.filter(g => !g.completed).length;
  const liveGoalsHit = goals.filter(g => g.completed).length;
  const ppRemaining = Math.max(0, DEADLINE_MIN - now);

  // Handlers
  const updateEvent = (id, patch) => {
    setState(s => ({
      ...s,
      events: s.events.map(e => e.id === id ? { ...e, ...patch } : e),
    }));
    ack(`Evento ev${id} atualizado`);
  };
  const mergeRequest = (idA, idB) => {
    const evA = state.events.find(e => e.id === idA);
    const evB = state.events.find(e => e.id === idB);
    if (!evA || !evB) return;
    if (!window.confirm(`Juntar ev${idA} (${window.HFData.activities[evA.activity]?.name}) com ev${idB} (${window.HFData.activities[evB.activity]?.name})?`)) return;
    const start = Math.min(evA.started_min, evB.started_min);
    const end = (evA.ended_min == null || evB.ended_min == null) ? null : Math.max(evA.ended_min, evB.ended_min);
    setState(s => ({
      ...s,
      events: s.events.filter(e => e.id !== idB).map(e => e.id === idA ? { ...e, started_min: start, ended_min: end } : e),
    }));
    ack(`Eventos juntados em ev${idA}`);
  };
  const deleteEvent = (ev) => {
    setState(s => ({ ...s, events: s.events.filter(e => e.id !== ev.id) }));
    openPanel(null);
    ack(`Evento ev${ev.id} apagado`);
  };

  const events_ = state.events;

  return (
    <div>
      {/* KPI strip */}
      <div className="kpi-grid">
        <KPI label="Produção hoje" en="Production today"
             value={liveProd.toLocaleString()} suffix="garrafas"
             headRight={<FlowDot flow="production"/>}
             foot={<>
               <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
                 <span className="pill prod"><span className="dot"/>Tribulus 468</span>
                 <span className="pill prod"><span className="dot"/>Ashwa 612</span>
                 <span className="pill prod"><span className="dot"/>Turmeric 412</span>
               </div>
             </>}/>
        <KPI label="Metas em curso" en="Goals in progress"
             value={liveGoalsActive} suffix={`/ ${liveGoalsActive + liveGoalsHit}`}
             headRight={<Icon name="target" size={14} style={{ color: "var(--hf-leaf-500)" }}/>}
             foot={<>
               <CapBar pct={62} label="Tribulus" sub="467/750"/>
               <div style={{ height: 6 }}/>
               <CapBar pct={82} label="Turmeric" sub="412/500"/>
             </>}/>
        <KPI label="P&P do dia" en="Pick & Pack"
             value={fmtDur(pp.total_minutes)} suffix=""
             headRight={<Icon name="pp" size={14} style={{ color: "var(--hf-leaf-500)" }}/>}
             foot={<>
               <div style={{ display: "flex", gap: 14, marginTop: 4 }}>
                 <div><div style={{ fontSize: 11, color: "var(--text-3)" }}>ordens</div><b className="mono">{pp.orders}</b></div>
                 <div><div style={{ fontSize: 11, color: "var(--text-3)" }}>seg/ordem</div><b className="mono">{pp.seconds_per_order}s</b></div>
               </div>
             </>}/>
        <KPI label="Atenção" en="Attention"
             value={alerts.length}
             attn={alerts.length > 0}
             headRight={<Icon name="bell" size={14}/>}
             foot={<div style={{ fontSize: 11.5, color: "var(--text-3)" }}>2 warning · 1 critical</div>}/>
      </div>

      {/* Countdown */}
      <div style={{ marginTop: 14 }}>
        <CountdownCard deadlineMin={DEADLINE_MIN} now={now}
                       label="Correio" en="Mailing cut-off" title="Próxima retirada de pedidos"/>
      </div>

      {/* Filters strip */}
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Filtros</h2><span className="en">· Filter view</span>
        <div className="rule"/>
      </div>
      <div className="filters">
        <span style={{ fontSize: 11, color: "var(--text-3)", letterSpacing: 0.05, textTransform: "uppercase", fontWeight: 700, marginRight: 4 }}>Fluxo:</span>
        {["production","pnp","support"].map(f => {
          const on = filterFlows.has(f);
          return (
            <button key={f} className={`filter-chip flow-${f} ${on ? "on" : ""}`}
                    onClick={() => setFilterFlows(s => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; })}>
              <span className="dot"/>{window.HFData.FLOWS[f].label}
            </button>
          );
        })}
        <span style={{ width: 16 }}/>
        <span style={{ fontSize: 11, color: "var(--text-3)", letterSpacing: 0.05, textTransform: "uppercase", fontWeight: 700, marginRight: 4 }}>Pessoa:</span>
        {operators.map(o => {
          const on = filterOps.has(o.id);
          return (
            <button key={o.id} className={`filter-chip ${on ? "on" : ""}`}
                    onClick={() => setFilterOps(s => { const n = new Set(s); n.has(o.id) ? n.delete(o.id) : n.add(o.id); return n; })}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: o.c1, display: "inline-block" }}/>
              {o.short}
            </button>
          );
        })}
        {(filterOps.size > 0 || filterFlows.size > 0) && (
          <button className="btn sm ghost" onClick={() => { setFilterOps(new Set()); setFilterFlows(new Set()); }}>
            Limpar
          </button>
        )}
      </div>

      {/* Timeline */}
      <div style={{ marginTop: 12 }}>
        <Timeline
          operators={operators}
          events={events_}
          now={now}
          hourPx={hourPx}
          filterOps={filterOps}
          filterFlows={filterFlows}
          onUpdateEvent={updateEvent}
          onMergeRequest={mergeRequest}
          onSelectEvent={(id) => openPanel(state.events.find(e => e.id === id))}
          selectedId={state.selectedEventId}
        />
      </div>

      {/* Alerts + secondary content */}
      <div className="section-title" style={{ marginTop: 24 }}>
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Atenção do dia</h2><span className="en">· Today's flags</span>
        <div className="rule"/>
      </div>
      <div className="split-row">
        <div className="card" style={{ padding: 14 }}>
          {alerts.map(a => (
            <div key={a.id} className={`alert-row ${a.severity}`}>
              <div className="ico"><Icon name="bell" size={14}/></div>
              <div>
                <div className="title">{a.title} <span style={{ color: "var(--text-3)", fontWeight: 500, fontSize: 11.5 }}>· {a.en}</span></div>
                <div className="sub">{a.detail}</div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn sm">Resolver</button>
              </div>
            </div>
          ))}
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", fontWeight: 700, letterSpacing: 0.06, marginBottom: 8 }}>
            <Leaf size={11} color="var(--hf-leaf-500)" style={{ marginRight: 4, verticalAlign: "middle" }}/>
            Resumo · Day summary
          </div>
          <Row label="Início do expediente" value={fmtClock(8*60)}/>
          <Row label="Operadores ativos" value={`${operators.length} pessoas`}/>
          <Row label="Eventos hoje" value={`${events_.length}`}/>
          <Row label="Cowork chains" value="3 ativos"/>
          <Row label="Tempo médio/ordem" value={`${pp.seconds_per_order}s`}/>
          <Row label="Próximo correio" value={fmtClock(DEADLINE_MIN)}/>
        </div>
      </div>
    </div>
  );
}

const Row = ({ label, value }) => (
  <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px dashed var(--border)", fontSize: 13 }}>
    <span style={{ color: "var(--text-3)" }}>{label}</span>
    <b className="mono tabnum">{value}</b>
  </div>
);

window.CommandCenter = CommandCenter;

export { CommandCenter };
