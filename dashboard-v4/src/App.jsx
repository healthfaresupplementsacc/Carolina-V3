/* App root — routing by hash, theme + state mgmt, page switcher, tweaks.
   ESM (E0): import explícito de cada componente; data.js e helpers.js
   importados primeiro (side-effect) pra popular window.HFData/HFH. */
import React from 'react';
import { createRoot } from 'react-dom/client';

// data + helpers (executam side-effect: setam window.HFData / window.HFH)
import { HFData } from './data.js';
import './helpers.js';

// feature flags (V4_ALLOW_WRITES default 0 — drag/edit só preview até E5/E6)
import { V4_ALLOW_WRITES } from './flags.js';

// componentes
import { Sidebar, TopBar } from './components/Shell.jsx';
import { SidePanel } from './components/SidePanel.jsx';

// páginas
import { CommandCenter } from './pages/CommandCenter.jsx';
import { FloorDisplay } from './pages/FloorDisplay.jsx';
import {
  ProductionPage, GoalsPage, PeoplePage, PickPackPage, SupportPage,
  ProductPage, FalarPage, PlanPage, ConfigPage,
  CarolinaPage,    // ajuste E0: Carolina volta como placeholder Bloco 5
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

function App() {
  // Routing by hash
  const [route, setRoute] = React.useState(() => (location.hash || "#hoje").slice(1));
  React.useEffect(() => {
    const onHash = () => setRoute((location.hash || "#hoje").slice(1));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Date
  const [date, setDate] = React.useState(() => new Date().toISOString().slice(0, 10));

  // Page state (events live here so they can be mutated by drag/edit)
  const [state, setState] = React.useState(() => ({
    events: [...window.HFData.events],
    selectedEventId: null,
  }));

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
    setTweaks(t => {
      const next = typeof key === "object" ? { ...t, ...key } : { ...t, [key]: val };
      try { window.parent.postMessage({ type: "__edit_mode_set_keys", edits: next }, "*"); } catch {}
      return next;
    });
  };

  // Side panel
  const [panelEvent, setPanelEvent] = React.useState(null);
  const openPanel = (ev) => {
    setPanelEvent(ev);
    setState(s => ({ ...s, selectedEventId: ev?.id || null }));
  };
  const closePanel = () => openPanel(null);

  // Toast (one-shot)
  const [toast, setToast] = React.useState(null);
  const ack = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  };

  // New event creator
  const newEvent = () => {
    const ev = {
      id: Date.now(),
      _new: true,
      op: window.HFData.operators[0].id,
      activity: "linha",
      product: null,
      started_min: 12 * 60,
      ended_min: null,
      cowork: [],
      qty: null, unit: null, description: "",
      confidence: "high",
    };
    setPanelEvent(ev);
  };

  // Handlers passed to pages
  const onUpdate = (next) => {
    setState(s => {
      const exists = s.events.some(e => e.id === next.id);
      return {
        ...s,
        events: exists ? s.events.map(e => e.id === next.id ? next : e) : [...s.events, next],
      };
    });
    setPanelEvent(null);
    ack(`Evento ev${next.id} salvo`);
  };
  const onDelete = (ev) => {
    setState(s => ({ ...s, events: s.events.filter(e => e.id !== ev.id) }));
    setPanelEvent(null);
    ack(`Evento ev${ev.id} apagado`);
  };

  const toggleTheme = () => setTweak("theme", tweaks.theme === "dark" ? "light" : "dark");

  // Page routing
  let pageNode;
  switch (route) {
    case "hoje":          pageNode = <CommandCenter state={state} setState={setState} openPanel={openPanel} ack={ack}/>; break;
    case "producao":      pageNode = <ProductionPage state={state}/>; break;
    case "metas":         pageNode = <GoalsPage state={state}/>; break;
    case "pessoas":       pageNode = <PeoplePage state={state}/>; break;
    case "floor":         pageNode = <FloorDisplay state={state}/>; break;
    case "pp":            pageNode = <PickPackPage state={state}/>; break;
    case "suporte":       pageNode = <SupportPage state={state}/>; break;
    case "produto":       pageNode = <ProductPage/>; break;
    case "falar":         pageNode = <FalarPage/>; break;
    case "planejamento":  pageNode = <PlanPage/>; break;
    case "carolina":      pageNode = <CarolinaPage/>; break;  // E0: placeholder Bloco 5
    case "config":        pageNode = <ConfigPage/>; break;
    default:              pageNode = <CommandCenter state={state} setState={setState} openPanel={openPanel} ack={ack}/>;
  }

  return (
    <div className={`app`}>
      <Sidebar route={route} onRoute={(id) => { location.hash = "#" + id; }}/>
      <TopBar pageId={route} date={date} onDate={setDate}
              theme={tweaks.theme} onTheme={toggleTheme}
              onNewEvent={newEvent}/>
      <main className="main">
        <div className="main-inner">{pageNode}</div>
      </main>

      {panelEvent && (
        <SidePanel event={panelEvent}
                   onClose={closePanel}
                   onUpdate={onUpdate}
                   onDelete={onDelete}
                   operators={window.HFData.operators}
                   now={window.HFH.liveNowMin()}/>
      )}

      {/* Tweaks panel (self-managing open/close via host protocol) */}
      <TweaksPanel title="Tweaks · HealthFare">
        <TweakSection label="Aparência · Appearance">
          <TweakRadio label="Tema · Theme" value={tweaks.theme} onChange={v => setTweak("theme", v)}
                      options={[{value:"light", label:"Claro"}, {value:"dark", label:"Escuro"}]}/>
          <TweakRadio label="Densidade · Density" value={tweaks.density} onChange={v => setTweak("density", v)}
                      options={[{value:"compact", label:"Compacto"}, {value:"spacious", label:"Espaçoso"}]}/>
        </TweakSection>
        <TweakSection label="Idioma · Language">
          <TweakRadio label="Labels" value={tweaks.language} onChange={v => setTweak("language", v)}
                      options={[{value:"bilingual", label:"PT/EN"}, {value:"pt", label:"PT"}, {value:"en", label:"EN"}]}/>
        </TweakSection>
        <TweakSection label="Estilo · Style">
          <TweakToggle label="Folhas · Leaves" value={tweaks.showLeaves} onChange={v => setTweak("showLeaves", v)}/>
          <TweakRadio label="Tom · Accent"
                      value={tweaks.accentMix} onChange={v => setTweak("accentMix", v)}
                      options={[{value:"navy", label:"Navy"}, {value:"balanced", label:"50/50"}, {value:"leaf", label:"Leaf"}]}/>
        </TweakSection>
      </TweaksPanel>

      {/* Toast */}
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
