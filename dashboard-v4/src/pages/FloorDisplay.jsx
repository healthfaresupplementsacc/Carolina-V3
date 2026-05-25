import React from 'react';
import { Icon, Leaf } from '../components/Icons.jsx';
import { OperatorAvatar } from '../components/Primitives.jsx';

/* Floor Display — TV-friendly mockup.
   Big dark glassy shell. One large card per operator showing:
   - Avatar + name + role + status bar (flow color)
   - Current activity (large), product, live timer
   - Past 3 activities below as a mini history
   - Cowork chips
   Footer with day summary + clock + deadline.
*/

function FloorDisplay({ state }) {
  const now = window.HFH.useNow(true);
  const { operators, activities, products, DEADLINE_MIN } = window.HFData;
  const { fmtClock, fmtCron, fmtDur, fmtClockShort } = window.HFH;
  const events = state.events;

  const byOp = {};
  for (const ev of events) (byOp[ev.op] = byOp[ev.op] || []).push(ev);

  const totalOrdersToday = 475;
  const totalBottlesToday = 1230;

  // Real clock
  const realTime = new Date();
  const realClock = realTime.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="fd-shell">
      <div className="fd-header">
        <div className="fd-brand">
          <div className="fd-brand-mark">
            <svg width="28" height="28" viewBox="0 0 24 24">
              <path d="M5 4v16M5 12h10M15 4v16" stroke="#1e3f8c" strokeWidth="2.6" strokeLinecap="round"/>
              <path d="M19 6c-1 5-4 8-9 10 1-4 3-7 5-8a6 6 0 0 1 4-2z" fill="#22b35d"/>
            </svg>
          </div>
          <div>
            <div className="fd-brand-name">HealthFare · Painel da Fábrica</div>
            <div className="fd-brand-sub">Floor Display · Live · {operators.length} operadores</div>
          </div>
        </div>
        <div style={{ flex: 1 }}/>
        <span className="pill live" style={{ background: "rgba(63,200,116,0.18)", borderColor: "rgba(63,200,116,0.32)", color: "#d2f5e0" }}>
          <span className="dot"/>AO VIVO · {fmtClock(now)}
        </span>
        <div className="fd-day-clock mono">
          {realClock}<small>NY</small>
        </div>
      </div>

      <div className="fd-grid">
        {operators.map(op => {
          const opEvents = (byOp[op.id] || []).slice().sort((a,b) => a.started_min - b.started_min);
          const live = opEvents.find(e => e.ended_min == null);
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
                  <span className="label">{isLive ? "Agora · Now" : (current ? "Último · Last" : "Pausado · Paused")}</span>
                </div>
                <div className="activity">{act ? act.name : "—"}</div>
                {prod && (
                  <div className="product">
                    <Leaf size={10} color="var(--hf-leaf-400)" style={{ marginRight: 4, verticalAlign: "middle" }}/>
                    {prod.name} <span style={{ opacity: 0.55, fontFamily: "JetBrains Mono, monospace" }}>· {prod.batch}</span>
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
                  <small>{isLive ? "elapsed" : (current ? "duração" : "")}</small>
                </div>
              </div>
              <div className="fd-past">
                <div className="label">Antes · Earlier</div>
                {past.length === 0 && (
                  <div className="row"><span className="clk">—</span><span className="ac" style={{ opacity: 0.5 }}>sem registros anteriores</span></div>
                )}
                {past.map(ev => {
                  const a = activities[ev.activity];
                  return (
                    <div key={ev.id} className={`row flow-${a?.flow || "support"}`}>
                      <span className="clk">{fmtClockShort(ev.started_min)}</span>
                      <span className="bullet"/>
                      <span className="ac">{a?.name}{ev.product ? ` · ${products[ev.product].name}` : ""}</span>
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
        <span className="pill"><Icon name="factory" size={11}/>Garrafas hoje · Bottles: <b style={{ marginLeft: 4 }}>{totalBottlesToday.toLocaleString()}</b></span>
        <span className="pill"><Icon name="pp" size={11}/>Ordens · Orders: <b style={{ marginLeft: 4 }}>{totalOrdersToday}</b></span>
        <span className="pill live"><span className="dot"/>{operators.filter(o => (byOp[o.id] || []).some(e => e.ended_min == null)).length} ao vivo · live</span>
        <span style={{ flex: 1 }}/>
        <span className="pill"><Icon name="clock" size={11}/>Correio em <b style={{ marginLeft: 4 }} className="mono">{fmtDur(Math.max(0, DEADLINE_MIN - now))}</b></span>
      </div>
    </div>
  );
}

window.FloorDisplay = FloorDisplay;

export { FloorDisplay };
