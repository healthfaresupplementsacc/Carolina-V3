// HEALTHFARE V3 — SPA — shell: auth PIN, topbar, nav, roteamento por hash.
import React, { useState, useEffect } from 'react';
import { getPin, setPin, clearPin, useFetch, nyToday, shiftDate } from './api.js';
import * as Pages from './pages.jsx';

const TABS = [
  ['hoje', 'Hoje'], ['producao', 'Produção'], ['pp', 'P&P'], ['suporte', 'Suporte'],
  ['pessoas', 'Pessoas'], ['produto', 'Produto'], ['metas', 'Metas'],
  ['falar', 'Falar'],
  ['planejamento', 'Planejamento'], ['carolina', 'Carolina'], ['config', 'Config'],
];
const PAGE = {
  hoje: Pages.Hoje, producao: Pages.Producao, pp: Pages.PP, suporte: Pages.Suporte,
  pessoas: Pages.Pessoas, produto: Pages.Produto, metas: Pages.Metas,
  falar: Pages.Falar,
  planejamento: Pages.Planejamento, carolina: Pages.Carolina, config: Pages.Config,
};

/** Rota atual do hash (#hoje → 'hoje'). */
function useHashRoute() {
  const [route, setRoute] = useState((location.hash || '#hoje').slice(1) || 'hoje');
  useEffect(() => {
    const on = () => setRoute((location.hash || '#hoje').slice(1) || 'hoje');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function PinGate({ onOk }) {
  const [v, setV] = useState('');
  const [err, setErr] = useState(false);
  return (
    <div className="gate">
      <div className="brand" style={{ marginBottom: 16 }}>HealthFare V3</div>
      <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) { setPin(v.trim()); onOk(); } else setErr(true); }}>
        <input type="password" value={v} placeholder="PIN" autoFocus
          onChange={(e) => { setV(e.target.value); setErr(false); }} />
        <div style={{ marginTop: 12 }}><button type="submit">entrar</button></div>
      </form>
      {err ? <p className="errbox small">digite o PIN</p> : null}
    </div>
  );
}

function Worker() {
  const { data } = useFetch('/health', []);
  if (!data) return <span className="worker">worker …</span>;
  const w = data.worker || {};
  return (
    <span className="worker">
      {w.alive ? '🟢' : '🔴'} worker {w.alive ? 'ativo' : 'sem tick'}
      {' · '}fila {data.queue} · {data.mode}
    </span>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(!!getPin());
  const [date, setDate] = useState(nyToday());
  const route = useHashRoute();

  if (!authed) return <PinGate onOk={() => setAuthed(true)} />;

  const Page = PAGE[route] || Pages.Hoje;
  return (
    <>
      <header className="topbar">
        <span className="brand">HealthFare V3 <span className="muted small">shadow</span></span>
        <Worker />
        <span className="spacer" />
        <span className="datesel">
          <button onClick={() => setDate(shiftDate(date, -1))} aria-label="dia anterior">◀</button>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value || nyToday())} />
          <button onClick={() => setDate(shiftDate(date, 1))} aria-label="próximo dia">▶</button>
        </span>
        <button onClick={() => { clearPin(); setAuthed(false); }} title="sair">sair</button>
      </header>
      <nav className="tabs">
        {TABS.map(([slug, label]) => (
          <a key={slug} href={'#' + slug} className={route === slug ? 'active' : ''}>{label}</a>
        ))}
      </nav>
      <main>
        <Page date={date} />
      </main>
    </>
  );
}
