/* App root — V4 ligado em dado real via /api/v3/data/*.
   Auth shell (PinGate) → AuthedApp (hooks de dado real e UI).
   - PinGate compartilha sessionStorage key 'v3pin' com o /dashboard atual
   - useSnapshotAsHFData(date) popula window.HFData e devolve o shape
   - state.events espelha hfdata.events pra permitir preview de edits/drag
     (não persistido — V4_ALLOW_WRITES=0 até E5)
   - Worker status do /health no topbar
*/
import React from 'react';
import { createRoot } from 'react-dom/client';

// data mock fallback + helpers (executam side-effect: setam window.HFData / window.HFH).
// O mock só aparece se o adapter ainda não populou (1º paint pré-1º poll).
import { HFData } from './data.js';
import './helpers.js';

// feature flags (V4_ALLOW_WRITES default 0 — drag/edit só preview até E5/E6)
import { V4_ALLOW_WRITES } from './flags.js';

// adapter API → HFData
import { useSnapshotAsHFData, getPin, clearPin, useFetch, nyToday } from './adapters/from-api.js';

// PIN gate
import { PinGate } from './components/PinGate.jsx';

// componentes
import { Sidebar, TopBar } from './components/Shell.jsx';
import { SidePanel } from './components/SidePanel.jsx';

// páginas
import { CommandCenter } from './pages/CommandCenter.jsx';
import { FloorDisplay } from './pages/FloorDisplay.jsx';
import {
  ProductionPage, GoalsPage, PeoplePage, PickPackPage, SupportPage,
  ProductPage, FalarPage, PlanPage, ConfigPage,
  CarolinaPage,    // E0: placeholder Bloco 5
} from './pages/OtherPages.jsx';

// tweaks panel
import {
  TweaksPanel, TweakSection, TweakRadio, TweakToggle,
} from './tweaks-panel.jsx';

const DEFAULT_TWEAKS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "density": "spacious",
  "accentMix": "balanced",
  "showLeaves": true,
  "language": "bilingual"
}/*EDITMODE-END*/;

/** Worker status pill — polla /api/v3/data/health a cada 12s. */
function WorkerPill() {
  const { data } = useFetch('/health', []);
  if (!data) return null;
  const w = data.worker || {};
  const ok = !!w.alive;
  return (
    <span title={`fila: ${data.queue || 0} · ${data.mode || '?'}`} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 999,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      fontSize: 11, fontWeight: 600, color: 'var(--text-2)',
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: ok ? 'var(--hf-leaf-500, #22b35d)' : 'var(--bad, #d9534f)',
      }}/>
      worker {ok ? 'ativo' : 'sem tick'}
    </span>
  );
}

// ── Shell de auth — só ele chama PinGate ─────────────────
function App() {
  const [authed, setAuthed] = React.useState(() => !!getPin());
  if (!authed) {
    return <PinGate onOk={() => setAuthed(true)} />;
  }
  return <AuthedApp onLogout={() => { clearPin(); setAuthed(false); }} />;
}

// ── App pós-auth — onde os hooks de dado real moram ─────
function AuthedApp({ onLogout }) {
  // Routing by hash
  const [route, setRoute] = React.useState(() => (location.hash || "#hoje").slice(1));
  React.useEffect(() => {
    const onHash = () => setRoute((location.hash || "#hoje").slice(1));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Date global (YYYY-MM-DD NY) — compartilhado por todas as páginas.
  const [date, setDate] = React.useState(() => nyToday());

  // Snapshot adapter — única fonte de verdade pros eventos do dia.
  const snapshot = useSnapshotAsHFData(date);

  // Local state pra preview de edits/drag. Reset quando o adapter traz events
  // novos (poll 12s) — mantém selectedEventId entre refreshes.
  const [state, setState] = React.useState({ events: [], selectedEventId: null });
  React.useEffect(() => {
    setState((s) => ({ ...s, events: snapshot.hfdata.events || [] }));
  }, [snapshot.hfdata.events]);

  // Theme + tweaks
  const [tweaks, setTweaks] = React.useState(() => {
    try { return { ...DEFAULT_TWEAKS, ...JSON.parse(sessionStorage.getItem("hf-tweaks") || "{}") }; }
    catch { return DEFAULT_TWEAKS; }
  });
  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", tweaks.theme);
    sessionStorage.setItem("hf-tweaks", JSON.stringify(tweaks));
  }, [tweaks]);
  const setTweak = (key, val) => {
    setTweaks((t) => {
      const next = typeof key === "object" ? { ...t, ...key } : { ...t, [key]: val };
      try { window.parent.postMessage({ type: "__edit_mode_set_keys", edits: next }, "*"); } catch {}
      return next;
    });
  };

  // Side panel — agora flutuante e posicionado perto do clique (E7 #1).
  const [panelEvent, setPanelEvent] = React.useState(null);
  const [panelPos, setPanelPos] = React.useState(null);
  const openPanel = (ev, coords) => {
    setPanelEvent(ev);
    setPanelPos(coords && coords.x != null ? coords : null);
    setState((s) => ({ ...s, selectedEventId: ev?.id || null }));
  };
  const closePanel = () => { setPanelEvent(null); setPanelPos(null); setState((s) => ({ ...s, selectedEventId: null })); };

  // Toast (one-shot)
  const [toast, setToast] = React.useState(null);
  const ack = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  };

  // New event creator (preview até E5)
  const newEvent = () => {
    const ops = snapshot.hfdata.operators || [];
    const ev = {
      id: 'new-' + Date.now(),
      _new: true,
      op: ops.length ? ops[0].id : 'p0',
      activity: "unknown",
      product: null,
      started_min: 12 * 60,
      ended_min: null,
      cowork: [], qty: null, unit: null, description: "",
      confidence: "high",
    };
    setPanelEvent(ev);
    if (!V4_ALLOW_WRITES) ack("modo leitura — novo registro é só preview");
  };

  // Handlers (preview-only enquanto V4_ALLOW_WRITES=0)
  const onUpdate = (next) => {
    setState((s) => {
      const exists = s.events.some((e) => e.id === next.id);
      return {
        ...s,
        events: exists ? s.events.map((e) => e.id === next.id ? next : e) : [...s.events, next],
      };
    });
    setPanelEvent(null);
    ack(V4_ALLOW_WRITES
      ? `Evento ev${next.id} salvo`
      : `preview ev${next.id} (não persistido — modo leitura)`);
  };
  const onDelete = (ev) => {
    setState((s) => ({ ...s, events: s.events.filter((e) => e.id !== ev.id) }));
    setPanelEvent(null);
    ack(V4_ALLOW_WRITES
      ? `Evento ev${ev.id} apagado`
      : `preview ev${ev.id} oculto (não persistido — modo leitura)`);
  };

  const toggleTheme = () => setTweak("theme", tweaks.theme === "dark" ? "light" : "dark");

  // Page routing
  let pageNode;
  const pageProps = {
    state, setState, openPanel, ack,
    loading: snapshot.loading, error: snapshot.error,
    hfdata: snapshot.hfdata, refresh: snapshot.refresh,
    date,
  };
  switch (route) {
    case "hoje":          pageNode = <CommandCenter {...pageProps}/>; break;
    case "producao":      pageNode = <ProductionPage state={state}/>; break;
    case "metas":         pageNode = <GoalsPage state={state}/>; break;
    case "pessoas":       pageNode = <PeoplePage state={state}/>; break;
    case "floor":         pageNode = <FloorDisplay state={state}/>; break;
    case "pp":            pageNode = <PickPackPage state={state}/>; break;
    case "suporte":       pageNode = <SupportPage state={state}/>; break;
    case "produto":       pageNode = <ProductPage/>; break;
    case "falar":         pageNode = <FalarPage/>; break;
    case "planejamento":  pageNode = <PlanPage/>; break;
    case "carolina":      pageNode = <CarolinaPage/>; break;
    case "config":        pageNode = <ConfigPage/>; break;
    default:              pageNode = <CommandCenter {...pageProps}/>;
  }

  return (
    <div className={`app`}>
      <Sidebar route={route} onRoute={(id) => { location.hash = "#" + id; }}/>
      <TopBar
        pageId={route} date={date} onDate={setDate}
        theme={tweaks.theme} onTheme={toggleTheme}
        onNewEvent={newEvent}
        workerNode={<WorkerPill/>}
        readOnly={!V4_ALLOW_WRITES}
        onLogout={onLogout}
      />
      <main className="main">
        <div className="main-inner">{pageNode}</div>
      </main>

      {panelEvent && (
        <SidePanel
          event={panelEvent}
          onClose={closePanel}
          onUpdate={onUpdate}
          onDelete={onDelete}
          operators={snapshot.hfdata.operators || []}
          now={window.HFH.liveNowMin()}
          initialPos={panelPos}
        />
      )}

      <TweaksPanel title="Tweaks · HealthFare">
        <TweakSection label="Aparência · Appearance">
          <TweakRadio label="Tema · Theme" value={tweaks.theme} onChange={(v) => setTweak("theme", v)}
            options={[{ value: "light", label: "Claro" }, { value: "dark", label: "Escuro" }]}/>
          <TweakRadio label="Densidade · Density" value={tweaks.density} onChange={(v) => setTweak("density", v)}
            options={[{ value: "compact", label: "Compacto" }, { value: "spacious", label: "Espaçoso" }]}/>
        </TweakSection>
        <TweakSection label="Idioma · Language">
          <TweakRadio label="Labels" value={tweaks.language} onChange={(v) => setTweak("language", v)}
            options={[{ value: "bilingual", label: "PT/EN" }, { value: "pt", label: "PT" }, { value: "en", label: "EN" }]}/>
        </TweakSection>
        <TweakSection label="Estilo · Style">
          <TweakToggle label="Folhas · Leaves" value={tweaks.showLeaves} onChange={(v) => setTweak("showLeaves", v)}/>
          <TweakRadio label="Tom · Accent" value={tweaks.accentMix} onChange={(v) => setTweak("accentMix", v)}
            options={[{ value: "navy", label: "Navy" }, { value: "balanced", label: "50/50" }, { value: "leaf", label: "Leaf" }]}/>
        </TweakSection>
      </TweaksPanel>

      {toast && (
        <div style={{ position: "fixed", bottom: 22, right: 22, padding: "10px 16px", borderRadius: 12,
          background: "var(--hf-navy-700)", color: "#fff", boxShadow: "var(--shadow-lg)",
          fontSize: 13, fontWeight: 600, zIndex: 200,
          display: "flex", alignItems: "center", gap: 8, animation: "slidein 0.18s ease" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--hf-leaf-400)" }}/>
          {toast}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App/>);
