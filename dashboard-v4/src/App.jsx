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
// E5 — wrapper de writes (PATCH/POST/DELETE) auditados via PIN
import * as writes from './adapters/writes.js';

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

/** Worker status pill + banner de billing alert.
 *  Polla /api/v3/data/health a cada 12s. Quando worker tem worker_alert
 *  (billing/rate-limit nos últimos 5min), renderiza banner vermelho fixo
 *  no header com link pro console.anthropic.com.  (bloco 29/mai-noite #3) */
function WorkerPill() {
  const { data } = useFetch('/health', []);
  if (!data) return null;
  const w = data.worker || {};
  const ok = !!w.alive;
  const alert = data.worker_alert || null;
  return (
    <>
      {alert && (
        <div title={alert.text} style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
          background: 'var(--bad, #dc2626)', color: '#fff',
          padding: '8px 14px', fontSize: 12.5, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        }}>
          <span>⚠ {alert.text}</span>
          {alert.kind === 'credit_balance' && (
            <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noreferrer"
               style={{ color: '#fff', textDecoration: 'underline', marginLeft: 6 }}>
              Topar agora →
            </a>
          )}
          <span style={{ marginLeft: 12, fontSize: 11, opacity: 0.85 }}>
            ({alert.error_count} erros nos últimos 5min)
          </span>
        </div>
      )}
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
    </>
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

// Strip abaixo do topbar: link da página dos operadores (pros admins acharem
// fácil + mandar). NÃO mostra PINs (não hardcodar credencial no bundle commitado;
// PINs são hash, não recuperáveis — gerencie na aba Operadores do /admin/).
function OperatorLinkBar() {
  const opUrl = window.location.origin + '/op/';
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(opUrl); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch (_) { window.prompt('Copia o link:', opUrl); }
  };
  return (
    <div className="op-link-bar">
      <span>👷 Página dos operadores:</span>
      <code>{opUrl}</code>
      <button className="btn" onClick={copy}>{copied ? '✅ Copiado' : '📋 Copiar'}</button>
      <a className="btn" href={opUrl} target="_blank" rel="noreferrer">Abrir ↗</a>
      <span className="op-link-hint">Entram com PIN de 4 dígitos · esqueceu o PIN de alguém? Redefina na aba Operadores do <a href="/admin/" target="_blank" rel="noreferrer">/admin/</a></span>
    </div>
  );
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

  // Side panel — flutuante, ACIMA do cursor, toggle, ESC, click-outside,
  // pending edits (E7-refine2 #1).
  const [panelEvent, setPanelEvent] = React.useState(null);
  const [panelPos, setPanelPos] = React.useState(null);
  // pendingEdits = { [eventId]: formState }  — drafts não-salvos preservados
  // entre close+reopen do painel. Local apenas (não persistido em sessionStorage —
  // some no F5; livra do risco de "esqueci uma alteração velha guardada").
  const [pendingEdits, setPendingEdits] = React.useState({});
  const draftRef = React.useRef(null);    // forma atual aberta no painel

  const openPanel = (ev, coords) => {
    // Toggle: clicar no mesmo evento de novo fecha o painel
    if (ev && panelEvent && panelEvent.id === ev.id) {
      closePanelInternal();
      return;
    }
    setPanelEvent(ev);
    setPanelPos(coords && coords.x != null ? coords : null);
    setState((s) => ({ ...s, selectedEventId: ev?.id || null }));
  };

  // Fecha — se há draft em edição diferente do original, salva como pending.
  function closePanelInternal() {
    const cur = panelEvent;
    const draft = draftRef.current;
    if (cur && draft && draft._dirty) {
      setPendingEdits((p) => ({ ...p, [cur.id]: { ...draft, _dirty: false } }));
    }
    draftRef.current = null;
    setPanelEvent(null);
    setPanelPos(null);
    setState((s) => ({ ...s, selectedEventId: null }));
  }
  const closePanel = closePanelInternal;

  // Quando salvar, limpa o pending desse evento.
  const clearPending = (eventId) => {
    setPendingEdits((p) => {
      if (!(eventId in p)) return p;
      const c = { ...p }; delete c[eventId]; return c;
    });
  };

  // ESC + click-outside fecham o painel.
  React.useEffect(() => {
    if (!panelEvent) return;
    const onKey = (e) => { if (e.key === 'Escape') closePanelInternal(); };
    const onMouseDown = (e) => {
      // ignora clicks dentro do painel ou em blocos da timeline (toggle no openPanel)
      if (e.target.closest('.float-panel')) return;
      if (e.target.closest('[data-block-id]')) return;
      if (e.target.closest('.tl-bg-tab')) return;
      if (e.target.closest('.tl-correio-tab')) return;
      if (e.target.closest('.exp-row-event')) return;
      closePanelInternal();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [panelEvent?.id]);

  // Toast — pode ser string (one-shot 2.6s) OU objeto { message, undo, ttlMs }.
  const [toast, setToast] = React.useState(null);
  const toastTimerRef = React.useRef(null);
  const ack = React.useCallback((msg) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    const isObj = msg && typeof msg === 'object';
    const ttl = isObj && msg.ttlMs ? msg.ttlMs : 2600;
    toastTimerRef.current = setTimeout(() => setToast(null), ttl);
  }, []);
  // Expoõe ack como global pra componentes profundos (ex: Timeline drag cancel)
  React.useEffect(() => { window.HFV4_ack = ack; }, [ack]);

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

  // E5 — handlers que CHAMAM API REAL (PATCH/POST/DELETE).
  // Auditado via PIN. Reversível (restore pra delete; reverter PATCH usa
  // before_data do v3.audit_log; undo do toast usa restore endpoint).
  const onUpdate = async (next) => {
    if (!V4_ALLOW_WRITES) {
      // Fallback: preview local (caso a flag seja revertida)
      setState((s) => ({ ...s, events: s.events.map((e) => e.id === next.id ? next : e) }));
      clearPending(next.id); draftRef.current = null;
      setPanelEvent(null); setPanelPos(null);
      ack(`preview ev${next.id} (V4_ALLOW_WRITES=0)`);
      return;
    }
    // CREATE (id começa com "new-")
    if (typeof next.id === 'string' && next.id.startsWith('new-')) {
      const res = await writes.createEventFromV4(next, snapshot.hfdata, date);
      if (!res.ok) { ack(`Erro ao criar: ${res.error.message || res.error}`); return; }
      clearPending(next.id); draftRef.current = null;
      setPanelEvent(null); setPanelPos(null);
      setState((s) => ({ ...s, selectedEventId: null }));
      snapshot.refresh();
      ack(`Salvo ✓ — ev${res.data.id} criado`);
      return;
    }
    // PATCH
    const original = state.events.find((e) => e.id === next.id);
    if (!original) { ack(`Evento ev${next.id} sumiu do estado — refresh`); snapshot.refresh(); return; }
    const res = await writes.patchEventFromV4(next, original, snapshot.hfdata, date);
    if (!res.ok) { ack(`Erro ao salvar: ${res.error.message || res.error}`); return; }
    clearPending(next.id); draftRef.current = null;
    setPanelEvent(null); setPanelPos(null);
    setState((s) => ({ ...s, selectedEventId: null }));
    if (res.data && res.data._noop) {
      ack(`Sem mudanças em ev${next.id}`);
    } else {
      snapshot.refresh();
      ack(`Salvo ✓ — ev${next.id}`);
    }
  };

  const onDelete = async (ev) => {
    if (!V4_ALLOW_WRITES) {
      setState((s) => ({ ...s, events: s.events.filter((e) => e.id !== ev.id) }));
      clearPending(ev.id); draftRef.current = null;
      setPanelEvent(null); setPanelPos(null);
      ack(`preview ev${ev.id} oculto (V4_ALLOW_WRITES=0)`);
      return;
    }
    if (!window.confirm(`Apagar ev${ev.id}? (reversível pelo botão Desfazer no toast)`)) return;
    const res = await writes.deleteEvent(ev.id, 'apagado pelo admin via /dashboard-v4', null);
    if (!res.ok) { ack(`Erro ao apagar: ${res.error.message || res.error}`); return; }
    clearPending(ev.id); draftRef.current = null;
    setPanelEvent(null); setPanelPos(null);
    setState((s) => ({ ...s, selectedEventId: null }));
    snapshot.refresh();
    // Toast com Desfazer (6s) — POST /events/:id/restore
    ack({
      message: `Apagado ev${ev.id}`,
      undo: async () => {
        const r = await writes.restoreEvent(ev.id, null);
        if (r.ok) { snapshot.refresh(); ack(`Restaurado ev${ev.id} ✓`); }
        else ack(`Erro ao restaurar: ${r.error.message || r.error}`);
      },
      ttlMs: 6000,
    });
  };

  // Merge — chamado pelo CommandCenter (drag-on-block ou ação manual)
  const onMerge = async (eventIds) => {
    if (!V4_ALLOW_WRITES) { ack('merge preview (V4_ALLOW_WRITES=0)'); return; }
    if (!Array.isArray(eventIds) || eventIds.length < 2) { ack('merge: precisa de ≥ 2 events'); return; }
    if (!window.confirm(`Juntar events [${eventIds.join(', ')}]? Permanente após confirmação (audit grava).`)) return;
    const res = await writes.mergeEvents(eventIds, null);
    if (!res.ok) { ack(`Erro merge: ${res.error.message || res.error}`); return; }
    snapshot.refresh();
    ack(`Merge ✓ — events [${eventIds.join(', ')}] fundidos`);
  };

  // Split — chamado pelo CommandCenter (modal datetime-local)
  const onSplit = async (id, splitAtIso) => {
    if (!V4_ALLOW_WRITES) { ack('split preview (V4_ALLOW_WRITES=0)'); return; }
    const res = await writes.splitEvent(id, splitAtIso, null);
    if (!res.ok) { ack(`Erro split: ${res.error.message || res.error}`); return; }
    snapshot.refresh();
    ack(`Split ✓ — ev${id} dividido em ${splitAtIso}`);
  };

  // Cria event num gap (regra E5 #4: justificar gap = criar tarefa retroativa)
  const onCreateInGap = async (opId, gap, formOpts) => {
    if (!V4_ALLOW_WRITES) { ack('gap preview (V4_ALLOW_WRITES=0)'); return; }
    const res = await writes.createEventInGap(gap, opId, snapshot.hfdata, date, formOpts || {});
    if (!res.ok) { ack(`Erro criar event no gap: ${res.error.message || res.error}`); return; }
    snapshot.refresh();
    ack(`Salvo ✓ — gap virou ev${res.data.id}`);
  };

  const toggleTheme = () => setTweak("theme", tweaks.theme === "dark" ? "light" : "dark");

  // Page routing
  let pageNode;
  const pageProps = {
    state, setState, openPanel, ack,
    loading: snapshot.loading, error: snapshot.error,
    hfdata: snapshot.hfdata, refresh: snapshot.refresh,
    raw: snapshot.raw,        // E7-refine2: usado pra acessar deadlines raw (correio)
    date,
    V4_ALLOW_WRITES,          // E7-resto Leva 3: ConfigPage usa pra disclaimer
    // E5 — writes reais (todos auditados via PIN, reversíveis)
    onMerge, onSplit, onCreateInGap,
    writes,                   // exposição direta pra pages com edição (Goals, Config, Counts)
  };
  switch (route) {
    case "hoje":          pageNode = <CommandCenter {...pageProps}/>; break;
    // E7-resto: todas as páginas operacionais recebem pageProps (hfdata real,
    // raw snapshot, openPanel, ack). Antes só `state` era passado → mock-only.
    case "producao":      pageNode = <ProductionPage {...pageProps}/>; break;
    case "metas":         pageNode = <GoalsPage {...pageProps}/>; break;
    case "pessoas":       pageNode = <PeoplePage {...pageProps}/>; break;
    case "floor":         pageNode = <FloorDisplay {...pageProps}/>; break;
    case "pp":            pageNode = <PickPackPage {...pageProps}/>; break;
    case "suporte":       pageNode = <SupportPage {...pageProps}/>; break;
    case "produto":       pageNode = <ProductPage {...pageProps}/>; break;
    case "falar":         pageNode = <FalarPage ack={ack}/>; break;
    case "planejamento":  pageNode = <PlanPage/>; break;
    case "carolina":      pageNode = <CarolinaPage/>; break;
    case "config":        pageNode = <ConfigPage {...pageProps}/>; break;
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
        ack={ack}
      />
      <OperatorLinkBar/>
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
          pendingForm={pendingEdits[panelEvent.id] || null}
          onDraftChange={(draft) => { draftRef.current = draft; }}
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
          display: "flex", alignItems: "center", gap: 10, animation: "slidein 0.18s ease" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--hf-leaf-400)" }}/>
          <span>{typeof toast === 'string' ? toast : toast.message}</span>
          {typeof toast === 'object' && toast.undo && (
            <button onClick={() => { const u = toast.undo; setToast(null); u(); }}
                    style={{ marginLeft: 4, padding: '4px 10px', borderRadius: 8,
                             background: 'var(--hf-leaf-500)', color: '#fff', border: 'none',
                             fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>
              Desfazer
            </button>
          )}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App/>);
