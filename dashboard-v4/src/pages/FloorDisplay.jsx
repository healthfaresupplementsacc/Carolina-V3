import React from 'react';
import { Icon, Leaf } from '../components/Icons.jsx';
import { OperatorAvatar } from '../components/Primitives.jsx';
import './pages-operacao.css';

/* Floor Display — a TV da fábrica.
   S15 fase 2: a pele virou STYLE-KIT (navy-deep chapado, verde do kit, DM
   Serif nos números). CONTINUA alto contraste e números grandes — é uma TV
   vista de longe. Nenhuma lógica mudou: mesmos dados, mesmos cálculos.
   Um card grande por operador com:
   - Avatar + nome + cargo + barra de status (cor do fluxo)
   - Atividade atual (grande), produto, cronômetro ao vivo
   - As 3 atividades anteriores como mini histórico
   - Chips de cowork
   Rodapé com resumo do dia + relógio + deadline.
*/

// E7-resto Leva 3: ligada em hfdata + state real. Admins filtrados pelo adapter.
// TV mode — cards grandes, dado real, sem mocks (totals hardcoded REMOVIDOS).
function FloorDisplay({ state, hfdata, raw, loading, date }) {
  const now = window.HFH.useNow(true);
  const HFD = hfdata || window.HFData;
  const { operators = [], activities = {}, products = {}, pp = {} } = HFD;
  const { fmtClock, fmtCron, fmtDur, fmtClockShort } = window.HFH;
  const events = state.events;

  const byOp = {};
  for (const ev of events) (byOp[ev.op] = byOp[ev.op] || []).push(ev);

  // Totais REAIS — totalBottles via raw.counts.totals_by_product; totalOrders via pp.orders
  const countsRaw = (raw && raw.counts) || {};
  const totalsByProduct = countsRaw.totals_by_product || {};
  const totalBottlesToday = Object.values(totalsByProduct).reduce((s, n) => s + (Number(n) || 0), 0);
  const totalOrdersToday = pp.orders || 0;
  const deadlineMin = pp.deadline_min;

  // Real clock (wall clock NY)
  const realClock = (function () {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    } catch { return '--:--'; }
  })();

  if (loading) {
    return <div className="fd-shell opa-fd"><div className="opa-fd-empty">Carregando…</div></div>;
  }

  return (
    <div className="fd-shell opa-fd">
      <div className="fd-header">
        <div className="fd-brand">
          <div className="fd-brand-mark">
            <svg width="28" height="28" viewBox="0 0 24 24">
              <path d="M5 4v16M5 12h10M15 4v16" stroke="#0d1f3c" strokeWidth="2.6" strokeLinecap="round"/>
              <path d="M19 6c-1 5-4 8-9 10 1-4 3-7 5-8a6 6 0 0 1 4-2z" fill="#3ab54a"/>
            </svg>
          </div>
          <div>
            <div className="fd-brand-name">HealthFare · Painel da Fábrica</div>
            <div className="fd-brand-sub">● FLOOR DISPLAY · {operators.length} OPERADOR(ES) · {date || 'HOJE'}</div>
          </div>
        </div>
        <div style={{ flex: 1 }}/>
        <span className="opa-fd-livechip">
          <span className="dot"/>AO VIVO · {fmtClock(now)}
        </span>
        <div className="fd-day-clock">
          {realClock}<small>NY</small>
        </div>
      </div>

      <div className="fd-grid">
        {operators.length === 0 && (
          <div className="opa-fd-empty">
            Sem operadores postando em {date || 'hoje'}.
          </div>
        )}
        {operators.map(op => {
          const opEvents = (byOp[op.id] || []).slice().sort((a,b) => a.started_min - b.started_min);
          // Live: prefere foreground sobre background pra "agora"
          const liveFg = opEvents.find(e => e.ended_min == null && !e._is_background);
          const liveBg = opEvents.find(e => e.ended_min == null && e._is_background);
          const live = liveFg || liveBg;
          const past = opEvents.filter(e => e.ended_min != null).slice(-3).reverse();
          const current = live || opEvents[opEvents.length - 1];
          const isLive = !!live;
          const act = current ? activities[current.activity] : null;
          const flow = act?.flow;
          const prod = current?.product ? products[current.product] : null;
          const dur = current ? (current.ended_min == null ? now - current.started_min : current.ended_min - current.started_min) : 0;

          return (
            <div key={op.id} className={`fd-card flow-${flow || "support"} ${!isLive ? "idle" : ""}`}>
              <div className="status-bar"/>
              <div className="head">
                <OperatorAvatar op={op} size="lg"/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="nm">{op.name}</div>
                  <div className="ro">{op.role} · {op.en_role}</div>
                </div>
              </div>
              <div className="fd-current">
                <div className="label-row">
                  {isLive && <span className="live-dot-lg"/>}
                  <span className="label">{isLive ? "Agora" : (current ? "Último" : "Pausado")}</span>
                </div>
                <div className="activity">{act ? act.name : "—"}</div>
                {prod && (
                  <div className="product">
                    <Leaf size={10} color="#7fd68c" style={{ marginRight: 4, verticalAlign: "middle" }}/>
                    {prod.name} {prod.batch && <span style={{ opacity: 0.62, fontFamily: "var(--font-mono)" }}>· {prod.batch}</span>}
                  </div>
                )}
                {/* Background paralelo — se a pessoa tem fg E bg, mostra o bg como secondary */}
                {liveFg && liveBg && (
                  <div style={{ marginTop: 5, fontSize: 11.5, color: 'rgba(255,255,255,.7)' }}>
                    + bg: {activities[liveBg.activity]?.name || liveBg.activity}
                    {liveBg.product && products[liveBg.product] && ` · ${products[liveBg.product].name}`}
                  </div>
                )}
                {current && current.cowork && current.cowork.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    {current.cowork.map(cw => {
                      const co = operators.find(o => o.id === cw);
                      return co ? <span key={cw} className="fd-cowork-chip"><Icon name="link" size={9}/>{co.short}</span> : null;
                    })}
                  </div>
                )}
                <div className="timer">
                  {isLive ? fmtCron(dur) : (current ? fmtDur(dur) : "0:00:00")}
                  <small>{isLive ? "decorrido" : (current ? "duração" : "")}</small>
                </div>
              </div>
              <div className="fd-past">
                <div className="label">Antes</div>
                {past.length === 0 && (
                  <div className="row"><span className="clk">—</span><span className="ac" style={{ opacity: 0.5 }}>sem registros anteriores</span></div>
                )}
                {past.map(ev => {
                  const a = activities[ev.activity];
                  const pName = ev.product ? products[ev.product]?.name : null;   // safe
                  return (
                    <div key={ev.id} className={`row flow-${a?.flow || "support"}`}>
                      <span className="clk">{fmtClockShort(ev.started_min)}</span>
                      <span className="bullet"/>
                      <span className="ac">{a?.name || '?'}{pName ? ` · ${pName}` : ""}</span>
                      <span className="d">{fmtDur(ev.ended_min - ev.started_min)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="fd-footer">
        <span className="opa-fd-foot-chip"><Icon name="factory" size={11}/>Garrafas hoje <b>{totalBottlesToday.toLocaleString()}</b></span>
        <span className="opa-fd-foot-chip"><Icon name="pp" size={11}/>Ordens <b>{totalOrdersToday}</b></span>
        <span className="opa-fd-foot-chip live"><span className="dot"/>{operators.filter(o => (byOp[o.id] || []).some(e => e.ended_min == null)).length} ao vivo</span>
        <span style={{ flex: 1 }}/>
        {deadlineMin != null && (
          <span className="opa-fd-foot-chip"><Icon name="clock" size={11}/>Correio em <b>{fmtDur(Math.max(0, deadlineMin - now))}</b></span>
        )}
      </div>
    </div>
  );
}

window.FloorDisplay = FloorDisplay;

export { FloorDisplay };
