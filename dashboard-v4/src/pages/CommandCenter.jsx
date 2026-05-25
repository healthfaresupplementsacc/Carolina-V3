/* Command Center — a tela "Hoje". E4: ligada em dado real.
   Lê os events do props (state.events, espelhado do adapter)
   e o resto (operators/goals/alerts/products/pp/DEADLINE_MIN/FLOWS) do
   window.HFData populado pelo useSnapshotAsHFData.

   Conteúdo do template adaptado pra usar APENAS dado real:
     - pills "Top lotes" derivam de production.lotes do dia
     - "Metas em curso" usam os goals reais (esperado/realizado)
     - Atenção lista alerts derivados (dup/inv/down/open) — sem números fake
     - Resumo do dia usa cowork count vivo, deadline real, count de events
*/
import React from 'react';
import { Icon, Leaf } from '../components/Icons.jsx';
import { KPI, CapBar, CountdownCard, FlowDot } from '../components/Primitives.jsx';
import { Timeline } from '../components/Timeline.jsx';

function CommandCenter({ state, setState, openPanel, ack, loading, error, hfdata, refresh, date }) {
  const now = window.HFH.useNow(true);
  const HFD = hfdata || window.HFData;
  const { operators = [], goals = [], alerts = [], products = {}, pp = {}, DEADLINE_MIN } = HFD;
  const { fmtClock, fmtDur } = window.HFH;

  // filtros locais
  const [filterOps, setFilterOps] = React.useState(new Set());
  const [filterFlows, setFilterFlows] = React.useState(new Set());
  const [hourPx, setHourPx] = React.useState(140);

  // ─── Derivações reais ────────────────────────────────────
  // 1) Total produzido hoje (soma qty de events de production com unit "bottle")
  const liveProd = state.events
    .filter((ev) => HFD.activities && HFD.activities[ev.activity] && HFD.activities[ev.activity].flow === 'production' && ev.qty)
    .reduce((s, ev) => s + (Number(ev.qty) || 0), 0);

  // 2) Top 3 goals/lotes do dia (mostra produto + realizado)
  const topLotes = goals.slice().sort((a, b) => (b.done || 0) - (a.done || 0)).slice(0, 3);

  // 3) Metas concluídas / em curso
  const goalsActive = goals.filter((g) => !g.completed).length;
  const goalsHit = goals.filter((g) => g.completed).length;

  // 4) Cowork chains ativos (events com cowork.length > 0)
  const coworkActive = state.events.filter((e) => e.cowork && e.cowork.length > 0 && e.ended_min == null).length;

  // 5) Atenção summary (warn vs bad)
  const warnCount = alerts.filter((a) => a.severity === 'warn').length;
  const badCount = alerts.filter((a) => a.severity === 'bad').length;
  const infoCount = alerts.filter((a) => a.severity === 'info').length;

  // ─── Handlers de preview (não persistem; V4_ALLOW_WRITES=0) ─
  const updateEvent = (id, patch) => {
    setState((s) => ({ ...s, events: s.events.map((e) => e.id === id ? { ...e, ...patch } : e) }));
  };
  const mergeRequest = (idA, idB) => {
    const evA = state.events.find((e) => e.id === idA);
    const evB = state.events.find((e) => e.id === idB);
    if (!evA || !evB) return;
    if (!window.confirm(`Juntar ev${idA} com ev${idB}? (preview — não persiste)`)) return;
    const start = Math.min(evA.started_min, evB.started_min);
    const end = (evA.ended_min == null || evB.ended_min == null) ? null : Math.max(evA.ended_min, evB.ended_min);
    setState((s) => ({
      ...s,
      events: s.events.filter((e) => e.id !== idB)
        .map((e) => e.id === idA ? { ...e, started_min: start, ended_min: end } : e),
    }));
    ack(`merge preview ev${idA}+${idB}`);
  };

  // ─── Loading state ───────────────────────────────────────
  if (loading) {
    return (
      <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
        <div style={{ fontSize: 14 }}>Carregando dado real do servidor…</div>
        <div style={{ fontSize: 11, marginTop: 6 }}>/api/v3/data/timeline · /production · /pp · /goals · /deadlines · /catalog</div>
      </div>
    );
  }
  if (error && state.events.length === 0) {
    return (
      <div className="card" style={{ padding: 30, color: 'var(--bad)' }}>
        <b>Erro carregando dado:</b> {error.message || String(error)}
        <div style={{ marginTop: 12 }}>
          <button className="btn sm" onClick={refresh}>Tentar de novo</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Erro silencioso (refresh falhou mas temos data antiga) */}
      {error && state.events.length > 0 && (
        <div className="alert-row warn" style={{ marginBottom: 10 }}>
          <div className="ico"><Icon name="bell" size={14}/></div>
          <div><b>Refresh falhou:</b> {error.message || String(error)}. Mostrando última leitura.</div>
        </div>
      )}

      {/* KPI strip */}
      <div className="kpi-grid">
        <KPI label="Produção hoje" en="Production today"
             value={liveProd.toLocaleString()} suffix="garrafas"
             headRight={<FlowDot flow="production"/>}
             foot={
               topLotes.length ? (
                 <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                   {topLotes.map((g) => (
                     <span key={g.id} className="pill prod">
                       <span className="dot"/>{g._product_name || g.product || '(?)'} {g.done}
                     </span>
                   ))}
                 </div>
               ) : <div style={{ fontSize: 12, color: 'var(--text-3)' }}>sem contagens hoje</div>
             }/>
        <KPI label="Metas em curso" en="Goals in progress"
             value={goalsActive} suffix={`/ ${goalsActive + goalsHit}`}
             headRight={<Icon name="target" size={14}/>}
             foot={
               goals.length ? (
                 <>
                   {goals.slice(0, 2).map((g) => (
                     <React.Fragment key={g.id}>
                       <CapBar pct={g.pct}
                               label={g._product_name || g.product || '(?)'}
                               sub={`${g.done}/${g.target}`}/>
                       <div style={{ height: 6 }}/>
                     </React.Fragment>
                   ))}
                 </>
               ) : <div style={{ fontSize: 12, color: 'var(--text-3)' }}>sem metas registradas</div>
             }/>
        <KPI label="P&P do dia" en="Pick & Pack"
             value={pp.total_minutes ? fmtDur(pp.total_minutes) : '—'}
             headRight={<Icon name="pp" size={14}/>}
             foot={
               <div style={{ display: 'flex', gap: 14, marginTop: 4 }}>
                 <div><div style={{ fontSize: 11, color: 'var(--text-3)' }}>ordens</div><b className="mono">{pp.orders || 0}</b></div>
                 <div><div style={{ fontSize: 11, color: 'var(--text-3)' }}>seg/ordem</div><b className="mono">{pp.seconds_per_order ? pp.seconds_per_order + 's' : '—'}</b></div>
               </div>
             }/>
        <KPI label="Atenção" en="Attention"
             value={alerts.length}
             attn={badCount > 0}
             headRight={<Icon name="bell" size={14}/>}
             foot={
               <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                 {badCount} crítico · {warnCount} warning · {infoCount} info
               </div>
             }/>
      </div>

      {/* Countdown (deadline real) */}
      <div style={{ marginTop: 14 }}>
        {pp.deadline_min != null ? (
          <CountdownCard deadlineMin={pp.deadline_min} now={now}
                         label="Correio" en="Mailing cut-off"
                         title="Próxima retirada de pedidos"/>
        ) : (
          <div className="card" style={{ padding: 14, color: 'var(--text-3)', fontSize: 13 }}>
            Sem deadline ativa configurada · <a href="#config" style={{ color: 'var(--hf-navy-600)' }}>configurar</a>
          </div>
        )}
      </div>

      {/* Filters strip */}
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Filtros</h2><span className="en">· Filter view</span>
        <div className="rule"/>
      </div>
      <div className="filters">
        <span style={{ fontSize: 11, color: "var(--text-3)", letterSpacing: 0.05, textTransform: "uppercase", fontWeight: 700, marginRight: 4 }}>Fluxo:</span>
        {["production", "pnp", "support"].map((f) => {
          const on = filterFlows.has(f);
          return (
            <button key={f} className={`filter-chip flow-${f} ${on ? "on" : ""}`}
                    onClick={() => setFilterFlows((s) => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; })}>
              <span className="dot"/>{(HFD.FLOWS && HFD.FLOWS[f] && HFD.FLOWS[f].label) || f}
            </button>
          );
        })}
        <span style={{ width: 16 }}/>
        <span style={{ fontSize: 11, color: "var(--text-3)", letterSpacing: 0.05, textTransform: "uppercase", fontWeight: 700, marginRight: 4 }}>Pessoa:</span>
        {operators.map((o) => {
          const on = filterOps.has(o.id);
          return (
            <button key={o.id} className={`filter-chip ${on ? "on" : ""}`}
                    onClick={() => setFilterOps((s) => { const n = new Set(s); n.has(o.id) ? n.delete(o.id) : n.add(o.id); return n; })}>
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
        {operators.length === 0 ? (
          <div className="card" style={{ padding: 30, color: 'var(--text-3)', textAlign: 'center' }}>
            Sem pessoas cadastradas ainda · (catálogo /api/v3/data/catalog/persons retornou vazio)
          </div>
        ) : (
          <Timeline
            operators={operators}
            events={state.events}
            now={now}
            hourPx={hourPx}
            filterOps={filterOps}
            filterFlows={filterFlows}
            onUpdateEvent={updateEvent}
            onMergeRequest={mergeRequest}
            onSelectEvent={(id) => openPanel(state.events.find((e) => e.id === id))}
            selectedId={state.selectedEventId}
          />
        )}
      </div>

      {/* Atenção + Resumo */}
      <div className="section-title" style={{ marginTop: 24 }}>
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Atenção do dia</h2><span className="en">· Today's flags</span>
        <div className="rule"/>
      </div>
      <div className="split-row">
        <div className="card" style={{ padding: 14 }}>
          {alerts.length ? alerts.map((a) => (
            <div key={a.id} className={`alert-row ${a.severity}`}>
              <div className="ico"><Icon name="bell" size={14}/></div>
              <div>
                <div className="title">{a.title} <span style={{ color: "var(--text-3)", fontWeight: 500, fontSize: 11.5 }}>· {a.en}</span></div>
                <div className="sub">{a.detail}</div>
              </div>
            </div>
          )) : (
            <div style={{ padding: 12, fontSize: 13, color: 'var(--text-3)' }}>nenhum alerta · all clear</div>
          )}
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", fontWeight: 700, letterSpacing: 0.06, marginBottom: 8 }}>
            <Leaf size={11} color="var(--hf-leaf-500)" style={{ marginRight: 4, verticalAlign: "middle" }}/>
            Resumo · Day summary
          </div>
          <Row label="Data"                    value={date}/>
          <Row label="Operadores ativos"       value={`${operators.length} pessoa(s)`}/>
          <Row label="Eventos hoje"            value={`${state.events.length}`}/>
          <Row label="Em andamento (live)"     value={`${state.events.filter((e) => e.ended_min == null).length}`}/>
          <Row label="Cowork ativos"           value={`${coworkActive}`}/>
          <Row label="Tempo médio/ordem"       value={pp.seconds_per_order ? `${pp.seconds_per_order}s` : '—'}/>
          <Row label="Próximo corte"           value={pp.deadline_min != null ? fmtClock(pp.deadline_min) : '—'}/>
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
