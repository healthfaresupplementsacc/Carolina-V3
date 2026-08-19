/* Command Center — a tela "Hoje". E7-refine2:
   - Correio agora é uma NOTIFICAÇÃO attached na timeline a 1PM (deadline real),
     NÃO mais bloco dentro do P&P. Clicável/editável (preview).
   - Notif card: toggle, pending edits preservados, max 5 + scroll.
   - Person expand: gaps clicáveis pra preencher (preview).
   - Painel evento: ACIMA do cursor, ESC/click-outside/toggle, pending edits.
*/
import React from 'react';
import { Icon, Leaf } from '../components/Icons.jsx';
import { KPI, CapBar, FlowDot } from '../components/Primitives.jsx';
import { Timeline } from '../components/Timeline.jsx';
import { CameraGrid } from '../components/CameraGrid.jsx';
import { NotificationsCard } from '../components/NotificationsPanel.jsx';
import { FloatingPopover } from '../components/FloatingPopover.jsx';
import { V4_ALLOW_WRITES } from '../flags.js';
import { apiGet, apiPost, usePoll } from '../adapters/from-api.js';
import nyTime from '../utils/ny-time.cjs';
import dayStats from '../utils/day-stats.cjs';
import './pages-operacao.css';

const NOTIFS_VISIBLE_KEY = 'hf-notifs-visible';

/* ── PONTO (relógio NGTeco) — Bruno 07-22. ADMIN ONLY: os horários do relógio são
   internos (nunca aparecem na página do funcionário/canal dos operadores; aqui é o
   dashboard PIN-admin). Quadrados: entrou / EM PAUSA (Xmin) / saiu. Poll 30s. ── */
function AttendanceStrip({ data, refresh }) {
  const people = (data && data.people) || [];
  const [busy, setBusy] = React.useState(null);
  // Deslogar um operador (Bruno 08-01): login por engano na conta de outra pessoa.
  const logoff = async (p) => {
    if (busy) return;
    if (!window.confirm(
      `Deslogar ${p.name} da estação?\n\n` +
      `Fecha a sessão do kiosk e encerra tarefas ativas (a máquina em background não é afetada). ` +
      `Vou checar se ela bateu a saída no relógio e avisar no admin-orin.`)) return;
    setBusy(p.person_id);
    try {
      const r = await apiPost(`/operator/${p.person_id}/logoff`, { reason: 'admin_dashboard' });
      const d = (r && r.data) || r || {};
      window.alert(`${p.name} deslogado(a).` +
        (d.sessions_closed ? ` Sessões fechadas: ${d.sessions_closed.length}.` : '') +
        (d.tasks_closed && d.tasks_closed.length ? ` Tarefas encerradas: ${d.tasks_closed.length}.` : '') +
        (d.clocked_out === false ? ' ⚠️ Ainda não bateu a saída no relógio.' : ''));
      if (refresh) refresh();
    } catch (e) { window.alert('Falhou deslogar: ' + (e && e.message || e)); }
    finally { setBusy(null); }
  };
  // SAÍDA MANUAL (Bruno 08-03): a pessoa esqueceu de bater a saída → o admin registra.
  const doCheckout = async (p) => {
    if (busy) return;
    const t = window.prompt(
      `Registrar SAÍDA de ${p.name} (esqueceu de bater no relógio).\n\n` +
      `Hora da saída (HH:MM), ou deixe vazio pra usar AGORA:`, '');
    if (t === null) return; // cancelou
    let atIso = null;
    if (t && t.trim()) {
      const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) { window.alert('Hora inválida. Use HH:MM (ex: 17:30).'); return; }
      const d = new Date(); d.setHours(+m[1], +m[2], 0, 0); atIso = d.toISOString();
    }
    setBusy(p.person_id);
    try {
      const r = await apiPost(`/operator/${p.person_id}/checkout`, atIso ? { at: atIso } : {});
      const dd = (r && r.data) || r || {};
      window.alert(`Saída de ${p.name} registrada.` + (dd.tasks_closed && dd.tasks_closed.length ? ` ${dd.tasks_closed.length} tarefa(s) encerrada(s).` : ''));
      if (refresh) refresh();
    } catch (e) { window.alert('Falhou registrar saída: ' + (e && e.message || e)); }
    finally { setBusy(null); }
  };
  if (!people.length) return null;
  const fmtT = (iso) => iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) : null;
  const card = (p) => {
    let dot = 'var(--ink-faint)', txt = 'sem ponto hoje', sub = null;
    if (p.state === 'in') {
      dot = 'var(--green)';
      txt = `entrou ${fmtT(p.checkin_at) || '—'}`;
      if (p.no_clockin) { dot = 'var(--dot-warn)'; txt = 'trabalhando SEM ponto'; sub = `início (tarefa) ${fmtT(p.checkin_at) || '—'}`; }
      else if (p.last_in_at && p.checkin_at && p.last_in_at !== p.checkin_at) sub = `voltou ${fmtT(p.last_in_at)}`;
    } else if (p.state === 'break') {
      dot = 'var(--dot-warn)';
      txt = 'EM PAUSA';
      sub = p.break_sec != null ? `${Math.round(p.break_sec / 60)}min` : null;
    } else if (p.checkout_at) {
      dot = 'var(--ink-faint)';
      txt = `saiu ${fmtT(p.checkout_at)}`;
      sub = p.checkin_at ? `entrou ${fmtT(p.checkin_at)}` : null;
    }
    return (
      <div key={p.person_id} className="opa-att-card"
           title={`relógio #${p.clock_code} · ${p.punches.length} batida(s)`}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flex: '0 0 8px' }}/>
        <div style={{ minWidth: 0 }}>
          <div className="opa-att-name">{p.name}</div>
          <div className="opa-att-sub">{txt}{sub ? <span style={{ marginLeft: 5 }}>· {sub}</span> : null}</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
          {p.logged_in ? (
            <button
              className="kit-btn xs"
              onClick={() => logoff(p)}
              disabled={busy === p.person_id}
              title={`Deslogar ${p.name} do kiosk (fecha a sessão)`}
              style={{ borderColor: 'var(--warn-line)', color: 'var(--warn-deep)', background: 'var(--warn-bg)',
                cursor: busy === p.person_id ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
              {busy === p.person_id ? '…' : 'deslogar'}
            </button>
          ) : null}
          {p.state !== 'out' && !p.checkout_at ? (
            <button
              className="kit-btn xs"
              onClick={() => doCheckout(p)}
              disabled={busy === p.person_id}
              title={`Registrar saída de ${p.name} (esqueceu de bater o ponto)`}
              style={{ cursor: busy === p.person_id ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
              saída
            </button>
          ) : null}
        </div>
      </div>
    );
  };
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
      <span className="kit-mlabel" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <Icon name="clock" size={12}/> Ponto
      </span>
      {people.map(card)}
    </div>
  );
}

/* ── CAIXA URGENTE de incidentes de dados (Bruno 07-23): duplicatas etc, com o
   relatório detalhado (o quê/onde/canal/foi-falta-de-atenção). ── */
function IncidentsBox() {
  const { data, refresh } = usePoll('/incidents', [], 30000);
  const incidents = (data && data.incidents) || [];
  const [expanded, setExpanded] = React.useState(null);
  if (!incidents.length) return null;
  const resolve = async (id, dismiss) => {
    try { await apiGet('/incidents/' + id + '/resolve' + (dismiss ? '?dismiss=1' : ''), { method: 'POST' }); } catch (_) {}
    try {
      await fetch('/api/v3/data/incidents/' + id + '/resolve', { method: 'POST',
        headers: { 'x-admin-pin': sessionStorage.getItem('v3pin') || '', 'content-type': 'application/json' },
        body: JSON.stringify({ dismiss: !!dismiss }) });
    } catch (_) {}
    if (refresh) refresh();
  };
  return (
    <div style={{ marginBottom: 14 }}>
      {incidents.map((inc) => {
        const w = inc.where_json || {};
        const isOpen = expanded === inc.id;
        return (
          <div key={inc.id} className="opa-alertbox">
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ fontSize: 18 }}>🚨</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="opa-alert-title">{inc.title}
                  {inc.auto_fixed && <span className="kit-chip ok" style={{ marginLeft: 8 }}>já corrigido</span>}
                </div>
                <div className="opa-alert-body">{inc.explanation}</div>
                {inc.diagnosis && (
                  <div className="opa-alert-note">{inc.diagnosis}</div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  <button className="kit-btn sm" onClick={() => setExpanded(isOpen ? null : inc.id)}>{isOpen ? 'Ocultar detalhes' : 'Ver onde aconteceu'}</button>
                  <button className="kit-btn sm primary" onClick={() => resolve(inc.id, false)}>Entendi, resolver</button>
                </div>
                {isOpen && (
                  <div style={{ marginTop: 10, fontSize: 12.5, display: 'grid', gap: 6 }}>
                    <div className="opa-alert-note">
                      <b style={{ color: 'var(--ok-deep)' }}>1ª (mantida)</b> · canal: <b>{w.original?.channel || '?'}</b> · pessoa: <b>{w.original?.person || '?'}</b>
                      {w.original?.event_id ? <> · evento <span className="mono">ev{w.original.event_id}</span></> : null}
                      {w.original?.slack_ts ? <> · <span className="mono">Slack</span></> : null}
                    </div>
                    <div className="opa-alert-note">
                      <b style={{ color: 'var(--bad-deep)' }}>2ª (duplicata removida)</b> · canal: <b>{w.duplicate?.channel || '?'}</b> · pessoa: <b>{w.duplicate?.person || '?'}</b>
                      {w.duplicate?.event_id ? <> · evento <span className="mono">ev{w.duplicate.event_id}</span></> : null}
                      {w.duplicate?.slack_ts ? <> · <span className="mono">Slack</span></> : null}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
                      {w.minutes_apart != null ? `As duas entradas foram feitas com ${w.minutes_apart}min de diferença. ` : ''}
                      {w.same_person_same_channel ? 'Mesma pessoa, mesmo canal: foi falta de atenção.' : 'Canais diferentes: registraram no app e no Slack.'}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// TOTAIS DE PRODUÇÃO PENDENTES (Bruno 07-27): linhas fechadas sem total. Enquanto
// o sistema conversa com o operador ficam 'open' (amarelo); se escalou pro admin,
// 'escalated' (vermelho). O admin pode digitar o total aqui → grava + fecha.
function PendingTotalsBox() {
  const { data, refresh } = usePoll('/pending-totals', [], 30000);
  const pending = (data && data.pending) || [];
  const [vals, setVals] = React.useState({});
  if (!pending.length) return null;
  const submit = async (id) => {
    const n = parseInt(vals[id], 10);
    if (!Number.isInteger(n) || n < 0) return;
    try {
      await fetch('/api/v3/data/pending-totals/' + id + '/resolve', { method: 'POST',
        headers: { 'x-admin-pin': sessionStorage.getItem('v3pin') || '', 'content-type': 'application/json' },
        body: JSON.stringify({ bottles: n }) });
    } catch (_) {}
    setVals((v) => ({ ...v, [id]: '' }));
    if (refresh) refresh();
  };
  // DISPENSAR "foi engano" (Bruno 08-03): abertura errada da tarefa, sem produção real.
  const dismiss = async (id) => {
    if (!window.confirm('Dispensar essa cobrança? Use quando a tarefa foi aberta por engano (sem produção real).')) return;
    try {
      await fetch('/api/v3/data/pending-totals/' + id + '/resolve', { method: 'POST',
        headers: { 'x-admin-pin': sessionStorage.getItem('v3pin') || '', 'content-type': 'application/json' },
        body: JSON.stringify({ dismiss: true }) });
    } catch (_) {}
    if (refresh) refresh();
  };
  return (
    <div style={{ marginBottom: 14 }}>
      {pending.map((f) => {
        const escalated = f.status === 'escalated';
        return (
          <div key={f.id} className={`opa-alertbox ${escalated ? '' : 'warn'}`}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ fontSize: 18 }}>{escalated ? '🚨' : '⏳'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="opa-alert-title">
                  Total de produção pendente{escalated ? ' · precisa investigar' : ''}
                </div>
                <div className="opa-alert-body">
                  <b>{f.person_name || '?'}</b> fechou a linha{f.product_name ? <> de <b>{f.product_name}</b></> : null}
                  {f.batch_number ? <> (lote <b>{f.batch_number}</b>)</> : null} sem informar a quantidade final.
                </div>
                {f.close_reason && (
                  <div className="opa-alert-note">
                    Motivo dado: <i>"{f.close_reason}"</i>
                  </div>
                )}
                <div style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 6 }}>
                  {escalated
                    ? 'O sistema não conseguiu o número com o operador. Alguém precisa ir atrás e registrar.'
                    : 'O sistema está conversando com o operador no Slack pra obter o total.'}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input type="number" min="0" placeholder="total de unidades" className="kit-input mono"
                    value={vals[f.id] || ''} onChange={(e) => setVals((v) => ({ ...v, [f.id]: e.target.value }))}
                    style={{ width: 140 }} />
                  <button className="kit-btn sm primary" onClick={() => submit(f.id)}>Registrar total</button>
                  <button className="kit-btn sm" onClick={() => dismiss(f.id)}
                    title="Tarefa aberta por engano, sem produção real. Remove a cobrança">foi engano</button>
                  <span className="kit-mlabel">linha ev{f.event_id}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const GAP_VISIBLE_MIN = 25;    // gaps >= isso aparecem no card; menores só editáveis via expand
const GAP_TRACKED_MIN = 5;     // gaps >= isso entram em allNotifs (mesmo invisíveis)

// Widgets da página Hoje (Bruno 07-01): liga/desliga + reordena; persiste.
// Ordem default põe Câmeras ANTES de Filtros (pedido explícito).
const WIDGET_DEFS = [
  { id: 'kpis',     label: 'Cards (KPIs)' },
  { id: 'cameras',  label: 'Câmeras' },
  { id: 'filtros',  label: 'Filtros' },
  { id: 'timeline', label: 'Linha do Tempo' },
  { id: 'resumo',   label: 'Resumo do dia' },
];
const WIDGETS_KEY = 'hf-widgets-v1';

function CommandCenter({ state, setState, openPanel, ack, loading, error, hfdata, refresh, date, raw,
                          onMerge, onSplit, onCreateInGap, writes,
                          notifOpen, onNotifClose, onNotifInfo }) {
  const now = window.HFH.useNow(true);
  const HFD = hfdata || window.HFData;
  const { operators = [], goals = [], alerts = [], pp = {}, fnsku = null, _gaps = {} } = HFD;
  const { fmtClock, fmtDur } = window.HFH;

  // PONTO (relógio) — busca uma vez, alimenta a faixa E os ícones da timeline (Bruno 07-23)
  const attPoll = usePoll('/attendance', [], 30000);
  // Veeqo do dia (Bruno 08-06): mostrar no card P&P o digitado vs Veeqo + diferença
  const vqToday = usePoll('/veeqo-today', [], 180000);
  const attData = attPoll.data;
  // markers + estado por person_id pra a Timeline (ícones + "saiu" em vez de idle)
  const attMarkersByPerson = React.useMemo(() => {
    const m = {};
    for (const p of (attData && attData.people) || []) m[p.person_id] = p.markers || [];
    return m;
  }, [attData]);
  const attStateByPerson = React.useMemo(() => {
    const m = {};
    for (const p of (attData && attData.people) || []) m[p.person_id] = { state: p.state, checkout_at: p.checkout_at, last_in_at: p.last_in_at, checkin_at: p.checkin_at, no_clockin: p.no_clockin };
    return m;
  }, [attData]);

  // ── State local ──────────────────────────────────────────
  const [filterOps, setFilterOps] = React.useState(new Set());
  const [filterFlows, setFilterFlows] = React.useState(new Set());
  const [hourPx, setHourPx] = React.useState(140); // FASE 4 — zoom da timeline
  const [expandedOpIds, setExpandedOpIds] = React.useState(new Set());
  const toggleExpand = (id) => setExpandedOpIds((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  // gear = { which: 'producao'|'metas'|'pp'|'notifs'|'attention', anchor: {x,y} } | null
  const [gear, setGear] = React.useState(null);
  const gearOpen = gear ? gear.which : null;
  // Helper pra gear buttons: passa o evento do click pra capturar coords.
  const onGearToggle = (which) => (e) => {
    if (gear && gear.which === which) { setGear(null); return; }
    setGear({ which, anchor: { x: e.clientX, y: e.clientY } });
  };
  const closeGear = () => setGear(null);
  // FASE 3 — drill-down dos cards (clicar no VALOR abre painel de taxas).
  // drill = { which: 'producao'|'revisao', anchor:{x,y} } | null
  const [drill, setDrill] = React.useState(null);
  const onDrill = (which) => (e) => {
    if (drill && drill.which === which) { setDrill(null); return; }
    setDrill({ which, anchor: { x: e.clientX, y: e.clientY } });
  };
  const closeDrill = () => setDrill(null);

  // ── Widgets (Bruno 07-01): on/off + ordem, persistidos ───
  const [widgets, setWidgets] = React.useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem(WIDGETS_KEY) || 'null');
      if (s && Array.isArray(s.order)) {
        const known = WIDGET_DEFS.map((d) => d.id);
        const order = s.order.filter((id) => known.includes(id)).concat(known.filter((id) => !s.order.includes(id)));
        return { order, off: Array.isArray(s.off) ? s.off : [] };
      }
    } catch { /* localStorage off */ }
    return { order: WIDGET_DEFS.map((d) => d.id), off: [] };
  });
  const [widgetsOpen, setWidgetsOpen] = React.useState(false);
  const saveWidgets = (w) => { setWidgets(w); try { localStorage.setItem(WIDGETS_KEY, JSON.stringify(w)); } catch {} };
  const wOn = (id) => !widgets.off.includes(id);
  const wOrder = (id) => widgets.order.indexOf(id) + 1;
  const wToggle = (id) => saveWidgets({ ...widgets, off: wOn(id) ? [...widgets.off, id] : widgets.off.filter((x) => x !== id) });
  const wMove = (id, dir) => {
    const o = [...widgets.order]; const i = o.indexOf(id); const j = i + dir;
    if (i < 0 || j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    saveWidgets({ ...widgets, order: o });
  };

  // Stats do filtro no TOPO da seção (sempre visível — Bruno 07-01):
  // eventos + tempo do recorte atual (tudo, quando nenhum chip ativo).
  const filterStats = React.useMemo(() => {
    let list = state.events;
    if (filterFlows.size > 0) list = list.filter((e) => { const a = HFD.activities && HFD.activities[e.activity]; return a && filterFlows.has(a.flow); });
    if (filterOps.size > 0) list = list.filter((e) => filterOps.has(e.op));
    let total = 0;
    for (const e of list) { const end = e.ended_min == null ? now : e.ended_min; total += Math.max(0, end - e.started_min); }
    return { n: list.length, min: Math.round(total), active: filterFlows.size > 0 || filterOps.size > 0 };
  }, [state.events, filterFlows, filterOps, now, HFD.activities]);

  // Notificações (Bruno 06-23): saíram do corpo da página. Quem controla a abertura
  // é o SINO DO TOPO (prop `notifOpen` vinda do App). Aqui só guardamos o modal de
  // EMERGÊNCIA (crítico novo → aviso com OK). A contagem é publicada via onNotifInfo.
  const [emergency, setEmergency] = React.useState(null);

  // E7-refine2 #4: lift notif state pra cá (compartilha com Correio na timeline)
  const [openNotifId, setOpenNotifId] = React.useState(null);
  const [notifDrafts, setNotifDrafts] = React.useState({});
  const onNotifClick = React.useCallback((id) => {
    setOpenNotifId((prev) => (prev === id ? null : id));
  }, []);
  const onNotifDraftChange = React.useCallback((id, d) => {
    setNotifDrafts((p) => ({ ...p, [id]: d }));
  }, []);
  const onNotifDraftClear = React.useCallback((id) => {
    setNotifDrafts((p) => { if (!(id in p)) return p; const c = { ...p }; delete c[id]; return c; });
  }, []);

  // ── Derivações reais ─────────────────────────────────────
  // SINCRONIA: garrafas do dia vêm da fonte CANÔNICA (production_counts via /production),
  // não mais de events.qty (que o /op não grava). Fallback p/ o modelo antigo se vazio.
  const prod = HFD.production || { total_bottles: 0, lotes: [] };
  const legacyQty = state.events
    .filter((ev) => HFD.activities && HFD.activities[ev.activity] && HFD.activities[ev.activity].flow === 'production' && ev.qty)
    .reduce((s, ev) => s + (Number(ev.qty) || 0), 0);
  const liveProd = (prod.total_bottles != null && prod.total_bottles > 0) ? prod.total_bottles : legacyQty;
  // RITMO REAL DA LINHA (Bruno 06-22): antes dividia as garrafas pela SOMA de TODO
  // o tempo de produção (linha + revisão + labeling + ...) em pessoa-hora → ritmo
  // baixo e enganoso. Agora usa só production_line, por RELÓGIO (união de intervalos).
  // Fallback pro modelo antigo se 'line' não vier.
  const ln = prod.line || null;
  const lineWall = ln ? (Number(ln.union_seconds) || Number(ln.span_seconds) || 0) : 0;
  const prodSecsLegacy = (prod.lotes || []).reduce((s, l) => s + (Number(l.total_seconds) || 0), 0);
  const prodPerMin = (ln && ln.bottles_per_min != null) ? ln.bottles_per_min
    : (prodSecsLegacy > 0 ? +(liveProd / (prodSecsLegacy / 60)).toFixed(1) : null);
  const secPerBottle = (ln && ln.sec_per_bottle != null) ? ln.sec_per_bottle
    : (prodSecsLegacy > 0 && liveProd > 0 ? +(prodSecsLegacy / liveProd).toFixed(1) : null);
  // MÉTRICA ANTIGA mantida (Bruno 06-22): garrafas ÷ SOMA de TODO o tempo de
  // produção (linha + revisão + labeling + …), em pessoa-hora. Os 2 lado a lado.
  const ft = prod.flow_total || null;
  const flowSecs = ft ? (Number(ft.person_seconds) || 0) : prodSecsLegacy;
  const flowPerMin = (ft && ft.bottles_per_min != null) ? ft.bottles_per_min
    : (flowSecs > 0 ? +(liveProd / (flowSecs / 60)).toFixed(1) : null);
  const reviewPhase = ft && ft.by_phase ? ft.by_phase.find((p) => p.slug === 'review') : null;
  // SEGUNDOS → "Xh0Y" / "Zmin" (o fmtDur do HFH é em MINUTOS — não confundir).
  const fmtDurSec = (s) => { s = Math.round(Number(s) || 0); const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`; };
  // FASE 3 — REVISÃO: média histórica (30d) de cápsulas/seg + frascos/min +
  // tempo médio de revisão por produto e geral (fonte canônica /review-rate).
  const review = HFD.review || { products: [], runs: [], n: 0, avg_capsules_per_sec: null, avg_bottles_per_min: null, avg_sec_per_bottle: null, range_days: 30 };
  const topLotes = goals.slice().sort((a, b) => (b.done || 0) - (a.done || 0)).slice(0, 3);
  const goalsActive = goals.filter((g) => !g.completed).length;
  const goalsHit = goals.filter((g) => g.completed).length;
  const coworkActive = state.events.filter((e) => e.cowork && e.cowork.length > 0 && e.ended_min == null).length;

  // Gap notifs — TODOS os gaps tracked (>=5min) entram em allNotifs pra Bruno
  // poder clicar/editar via PersonExpansion. O card visivelmente mostra só os
  // >=25min (filtrado client-side no NotificationsCard via `visibleThreshold`).
  const gapNotifs = React.useMemo(() => {
    const out = [];
    const byOp = {};
    for (const e of state.events) (byOp[e.op] = byOp[e.op] || []).push(e);
    for (const op of operators) {
      const evs = (byOp[op.id] || []).slice().sort((a, b) => a.started_min - b.started_min);
      for (let i = 0; i < evs.length - 1; i++) {
        const evEnd = evs[i].ended_min == null ? now : evs[i].ended_min;
        const gap = evs[i + 1].started_min - evEnd;
        if (gap >= GAP_TRACKED_MIN) {
          out.push({
            id: `gap-${op.id}-${i}`,
            _type: 'gap',
            severity: gap >= 60 ? 'warn' : (gap >= GAP_VISIBLE_MIN ? 'info' : 'info'),
            _dur_min: gap,
            title: `Gap em ${op.name}`,
            en: `Gap for ${op.name}`,
            detail: `${fmtClock(evEnd)} → ${fmtClock(evs[i + 1].started_min)} (${fmtDur(gap)})`,
            _op: op.id, _start: evEnd, _end: evs[i + 1].started_min,
          });
        }
      }
    }
    return out;
  }, [state.events, operators, now, fmtClock, fmtDur]);

  // E7-refine2 #2: Correio = notif sintético attached à timeline no horário do deadline real.
  // O id é 'correio' fixo pra preservar pending entre re-renders. Pull do raw.deadlines
  // pra ter o id do row (pra futuramente PATCH /deadlines/:id no E5).
  const correioNotif = React.useMemo(() => {
    const dlList = (raw && raw.deadlines && raw.deadlines.deadlines) || [];
    const primary = dlList
      .filter((d) => d.active !== false && d.time_of_day)
      .sort((a, b) => String(a.time_of_day).localeCompare(String(b.time_of_day)))[0];
    if (!primary) return null;
    const [h, m] = String(primary.time_of_day).split(':').map(Number);
    const minutes = h * 60 + m;
    return {
      id: 'correio',
      _type: 'correio',
      severity: 'info',
      title: primary.label || 'Corte do correio',
      en: 'Mailing cut-off',
      detail: `Corte às ${fmtClock(minutes)} · ${minutes - Math.floor(now)}min até passar`,
      _deadline_id: primary.id,
      _deadline_hhmm: String(primary.time_of_day).slice(0, 5),
      _minutes: minutes,
      _label: primary.label || 'Corte do correio',
    };
  }, [raw, now, fmtClock]);

  // Bug #1 bloco 29/mai: anexa _onOpenInvalid no alert 'inv' pra clicar nos
  // events listados abrir o painel flutuante padrão. Tem que vir DEPOIS do
  // openPanel estar disponível (vem como prop), então criamos uma cópia do
  // alerts enriquecida.
  const enrichedAlerts = React.useMemo(() => alerts.map((a) => {
    if (a.id === 'inv') {
      return { ...a, _onOpenInvalid: (ev, coords) => openPanel(ev, coords) };
    }
    return a;
  }), [alerts, openPanel]);
  const allNotifs = [...enrichedAlerts, ...(correioNotif ? [correioNotif] : []), ...gapNotifs];

  // Bug #1 bloco 29/mai: Set de event ids inválidos pra Timeline marcar.
  const invalidEventIds = React.useMemo(() => {
    const set = new Set();
    for (const a of alerts) {
      if (a.id === 'inv' && Array.isArray(a._invalid_events)) {
        for (const ie of a._invalid_events) if (ie.event_id != null) set.add(ie.event_id);
      }
    }
    return set;
  }, [alerts]);

  // E6 #6: gap click abre form flutuante pra preencher (não só notif lookup)
  const [gapFill, setGapFill] = React.useState(null);  // { opId, gap, coords, form }
  const openGapFill = (opId, gap, coords) => {
    setGapFill({ opId, gap, coords, form: { reasonCat: 'outro', note: '' } });
  };
  const closeGapFill = () => setGapFill(null);
  const saveGapFill = async () => {
    if (!gapFill) return;
    if (!V4_ALLOW_WRITES || !onCreateInGap) { ack('preview · V4_ALLOW_WRITES=0'); closeGapFill(); return; }
    await onCreateInGap(gapFill.opId, gapFill.gap, gapFill.form);
    closeGapFill();
  };

  // E6 #6: gap click → abre form flutuante pra registrar evento naquele intervalo.
  const onGapClick = React.useCallback((opId, gapItem, coords) => {
    openGapFill(opId, gapItem, coords);
  }, []);

  const onCorreioClick = React.useCallback(() => {
    if (correioNotif) setOpenNotifId((p) => (p === 'correio' ? null : 'correio'));
  }, [correioNotif]);
  const warnCount = allNotifs.filter((a) => a.severity === 'warn').length;
  const badCount = allNotifs.filter((a) => a.severity === 'bad').length;
  const infoCount = allNotifs.filter((a) => a.severity === 'info').length;
  // Publica a contagem pro SINO do topo (App → badge do topbar). setNotifInfo é setter
  // estável; só dispara quando total/crítico muda → sem loop.
  React.useEffect(() => { if (onNotifInfo) onNotifInfo({ total: allNotifs.length, bad: badCount }); }, [onNotifInfo, allNotifs.length, badCount]);
  // EMERGÊNCIA: crítico NOVO (após o load) → modal de aviso. Baseline capturado pós-load
  // evita disparar no 0→1 da CHEGADA dos dados (era o bug do auto-abrir). Bruno 06-23.
  const notifBaseline = React.useRef(null);
  React.useEffect(() => {
    if (loading) return;
    if (notifBaseline.current === null) { notifBaseline.current = badCount; return; }
    if (badCount > notifBaseline.current) setEmergency({ items: allNotifs.filter((a) => a.severity === 'bad') });
    notifBaseline.current = badCount;
  }, [loading, badCount, allNotifs]);

  // ── Handlers — E5/E6 #7: drag com CONFIRMAÇÃO DUPLA ──────
  // Drag horizontal/resize NÃO bate mais no banco direto. Acumula em
  // pendingDrags + UI otimista, e só PATCH /events após Bruno confirmar duas
  // vezes via banner no topo da timeline. Cancelar → refresh reverte UI.
  // Drag vertical (mudar lane) já foi BLOQUEADO no Timeline.
  const [pendingDrags, setPendingDrags] = React.useState([]);
  // pendingDrags: [{ id, started_min, ended_min, origStart, origEnd }]

  const updateEvent = (id, patch) => {
    // 1) captura original ANTES da otimista, pra saber o "from" do diff
    const cur = state.events.find((e) => e.id === id);
    const origStart = cur ? cur.started_min : null;
    const origEnd   = cur ? cur.ended_min   : null;
    // 2) atualização otimista local pra UI mostrar onde caiu
    setState((s) => ({ ...s, events: s.events.map((e) => e.id === id ? { ...e, ...patch } : e) }));
    // 3) sem writes ligados → preview puro, não enfileira
    if (!V4_ALLOW_WRITES || !writes) return;
    // 4) enfileira no lote pendente; se já existia, mantém o origStart/origEnd
    setPendingDrags((prev) => {
      const exists = prev.find((p) => p.id === id);
      if (exists) {
        return prev.map((p) => p.id === id ? { ...p, ...patch } : p);
      }
      return [...prev, {
        id,
        origStart, origEnd,
        started_min: patch.started_min != null ? patch.started_min : origStart,
        ended_min:   ('ended_min' in patch) ? patch.ended_min : origEnd,
      }];
    });
  };

  const confirmDrags = async () => {
    if (pendingDrags.length === 0) return;
    const n = pendingDrags.length;
    if (!window.confirm(`Tem certeza que quer aplicar ${n} mudança(s) na linha do tempo? Sim/Não`)) return;
    if (!window.confirm(`Confirme: isso vai mudar a linha do tempo de verdade. Sim/Não`)) return;
    let okCount = 0, errCount = 0;
    for (const pd of pendingDrags) {
      const changes = {
        started_at: nyTime.minutesToNyIso(date, pd.started_min),
        ended_at:   pd.ended_min == null ? null : nyTime.minutesToNyIso(date, pd.ended_min),
      };
      const res = await writes.patchEvent(pd.id, changes, 'drag/resize batch via /dashboard-v4');
      if (res.ok) okCount++;
      else { errCount++; ack(`ev${pd.id} erro: ${res.error.message || res.error}`); }
    }
    setPendingDrags([]);
    if (refresh) refresh();
    ack(`Aplicado ✓ ${okCount} mudança(s)${errCount > 0 ? ` · ${errCount} falha(s)` : ''}`);
  };

  const cancelDrags = () => {
    if (pendingDrags.length === 0) return;
    if (!window.confirm(`Descartar ${pendingDrags.length} mudança(s) pendente(s)? A linha do tempo volta ao estado original.`)) return;
    setPendingDrags([]);
    if (refresh) refresh();   // servidor reverte UI
  };
  // Merge-on-drop: confirmação + chamada onMerge real
  const mergeRequest = (idA, idB) => {
    if (!onMerge) return;
    onMerge([idA, idB]);
  };

  // ── Loading / erro fatal ─────────────────────────────────
  if (loading) {
    return (
      <div data-page-op="hoje">
        <div className="opa-empty">
          <div style={{ fontSize: 14 }}>Carregando dado real do servidor…</div>
          <div className="kit-mlabel" style={{ marginTop: 8 }}>timeline · production · pp · goals · deadlines · catalog</div>
        </div>
      </div>
    );
  }
  if (error && state.events.length === 0) {
    return (
      <div data-page-op="hoje">
        <div className="opa-alertbox">
          <div className="opa-alert-title">Erro carregando dado</div>
          <div className="opa-alert-body">{error.message || String(error)}</div>
          <div style={{ marginTop: 12 }}>
            <button className="kit-btn sm primary" onClick={refresh}>Tentar de novo</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-page-op="hoje" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* ── Cabeçalho do kit ─────────────────────────────────── */}
      <div className="opa-head" style={{ order: -1 }}>
        <div className="opa-head-main">
          <span className="kit-eyebrow">● HEALTHFARE · HOJE</span>
          <h1 className="kit-h1">O dia da <em>fábrica</em> agora</h1>
          <p className="kit-sub">
            Produção, metas, P&amp;P e a linha do tempo de cada pessoa. Os blocos ligam e desligam no botão Widgets.
          </p>
        </div>
        <div className="opa-head-side">
          <button className="kit-btn sm" onClick={() => setWidgetsOpen((v) => !v)}
                  title="Ligar/desligar e reordenar os blocos da página">Widgets</button>
        </div>
      </div>

      {error && state.events.length > 0 && (
        <div className="opa-alertbox warn" style={{ marginBottom: 10 }}>
          <div className="opa-alert-title">Refresh falhou</div>
          <div className="opa-alert-body">{error.message || String(error)}. Mostrando a última leitura.</div>
        </div>
      )}

      {/* ── Widgets: escolher/ordenar os blocos da página (Bruno 07-01) ── */}
      {widgetsOpen && (
        <>
          <div onClick={() => setWidgetsOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 260 }}/>
          <div className="kit-card pad" style={{ position: 'fixed', top: 96, right: 18, zIndex: 270, width: 268, boxShadow: 'var(--shadow-pop)' }}>
            <div className="kit-mlabel" style={{ marginBottom: 8 }}>Widgets da página</div>
            {widgets.order.map((id, i) => {
              const def = WIDGET_DEFS.find((d) => d.id === id); if (!def) return null;
              return (
                <div key={id} className="kit-dotted-row" style={{ padding: '7px 0' }}>
                  <input type="checkbox" checked={wOn(id)} onChange={() => wToggle(id)} style={{ accentColor: 'var(--green-d)' }}/>
                  <span style={{ flex: 1, fontSize: 13 }}>{def.label}</span>
                  <button className="kit-btn xs" onClick={() => wMove(id, -1)} disabled={i === 0}
                          style={{ padding: '0 8px' }} title="Subir">↑</button>
                  <button className="kit-btn xs" onClick={() => wMove(id, +1)} disabled={i === widgets.order.length - 1}
                          style={{ padding: '0 8px' }} title="Descer">↓</button>
                </div>
              );
            })}
            <div className="kit-mlabel" style={{ marginTop: 8 }}>salvo neste navegador</div>
          </div>
        </>
      )}

      {/* ── INCIDENTES DE DADOS (urgente) ──────────────────── */}
      <IncidentsBox/>
      <PendingTotalsBox/>

      {/* ── PONTO (relógio) — admin only ───────────────────── */}
      <AttendanceStrip data={attData} refresh={attPoll.refresh}/>

      {/* ── KPI strip ──────────────────────────────────────── */}
      {wOn('kpis') && (<section style={{ order: wOrder('kpis') }}>
      <div className="kpi-grid">

        {/* PRODUÇÃO HOJE — engrenagem + valor clicável (drill bottle/seg) */}
        <KPI label="Produção hoje" en="Production today"
             value={liveProd.toLocaleString()} suffix="garrafas"
             onValueClick={onDrill('producao')}
             headRight={<div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
               <FlowDot flow="production"/>
               <GearButton onClick={onGearToggle('producao')} active={gearOpen === 'producao'}/>
             </div>}
             foot={<>
               {(prodPerMin != null || lineWall > 0 || flowPerMin != null) && (
                 <div style={{ marginBottom: 4, lineHeight: 1.5 }}>
                   {/* LINHA (só produção, por relógio) — a métrica principal */}
                   {(lineWall > 0 || prodPerMin != null) && (
                     <div className="mono" style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 500 }}>
                       <span className="kit-mlabel" style={{ color: 'var(--green-d)' }}>LINHA </span>
                       {lineWall > 0 && <span title="relógio em que a linha esteve produzindo (sem dupla contagem)">{fmtDurSec(lineWall)}</span>}
                       {prodPerMin != null && <span> · {prodPerMin}/min</span>}
                       {secPerBottle != null && <span> · {secPerBottle}s/un</span>}
                     </div>
                   )}
                   {/* TOTAL (linha + revisão + labeling…, pessoa-hora) — a antiga */}
                   {flowPerMin != null && (
                     <div className="mono" style={{ fontSize: 11.5, color: 'var(--ink-dim)' }}>
                       <span className="kit-mlabel">TOTAL </span>
                       <span title="garrafas ÷ soma de TODO o tempo de produção (linha+revisão+labeling), pessoa-hora">{fmtDurSec(flowSecs)} · {flowPerMin}/min</span>
                       {reviewPhase && Number(reviewPhase.seconds) > 0 && <span> · revisão {fmtDurSec(reviewPhase.seconds)}</span>}
                     </div>
                   )}
                 </div>
               )}
               {topLotes.length ? (
                 <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                   {topLotes.map((g) => (
                     <span key={g.id} className="kit-chip neutral">
                       {g._product_name || g.product || '(?)'} {g.done}
                     </span>
                   ))}
                 </div>
               ) : <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>sem contagens hoje</div>}
               <EditPopover open={gearOpen === 'producao'} anchor={gear?.anchor} onClose={closeGear}
                            title="Editar produção · contagens">
                 <EditList items={topLotes.map((g) => ({
                              id: g.id,
                              label: `${g._product_name || '(?)'} · ${g.done} ${g.unit}`,
                            }))}
                          emptyMsg="Sem contagens registradas hoje"
                          onAdd={() => ack('Counts são geradas pela captura; não é possível adicionar manualmente')}
                          onEdit={async (it) => {
                            const cur = topLotes.find((g) => g.id === it.id);
                            const v = window.prompt(`Novo total de garrafas pra ${cur?._product_name || '?'}:`, String(cur?.done || 0));
                            if (v == null) return;
                            const n = Number(v);
                            if (!Number.isFinite(n) || n < 0) { ack('Valor inválido'); return; }
                            if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
                            const res = await writes.patchCount(it.id, n);
                            if (!res.ok) { ack(`Erro: ${res.error.message || res.error}`); return; }
                            if (refresh) refresh();
                            ack(`Salvo ✓ contagem ev${it.id} = ${n}`);
                          }}
                          onDelete={async (it) => {
                            if (!window.confirm(`Apagar contagem ${it.label}?`)) return;
                            if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
                            const res = await writes.deleteCount(it.id, 'apagado via /dashboard-v4');
                            if (!res.ok) { ack(`Erro: ${res.error.message || res.error}`); return; }
                            if (refresh) refresh();
                            ack(`Apagado ✓ contagem ${it.id}`);
                          }}/>
               </EditPopover>
             </>}/>

        {/* REVISÃO DO DIA — FASE 3: cáps/seg + frascos/min + POR PESSOA, clicável */}
        <KPI label="Revisão (dia)" en="Review · day"
             value={review.avg_capsules_per_sec != null ? review.avg_capsules_per_sec : '—'}
             suffix={review.avg_capsules_per_sec != null ? 'cáps/seg' : ''}
             onValueClick={onDrill('revisao')}
             headRight={<FlowDot flow="production"/>}
             foot={<>
               {review.avg_bottles_per_min != null ? (
                 <div className="mono" style={{ fontSize: 12, color: 'var(--primary)', marginBottom: 6 }}>
                   {review.avg_bottles_per_min}/min · {review.avg_sec_per_bottle != null ? `${review.avg_sec_per_bottle}s/frasco` : '—'}
                 </div>
               ) : <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>sem revisão com lote neste dia</div>}
               {(review.operators || []).length > 0 ? (
                 <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                   {(review.operators || []).slice(0, 4).map((o, i) => (
                     <span key={i} className="kit-chip neutral" title={`${o.n} revisão(ões)`}>
                       {o.operator || '(?)'} {o.avg_capsules_per_sec}/s
                     </span>
                   ))}
                 </div>
               ) : null}
               <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 6 }}>
                 {review.n || 0} revisão(ões) no dia · clique pra ver 30d, custom ou por pessoa
               </div>
             </>}/>

        {/* METAS — engrenagem */}
        <KPI label="Metas em curso" en="Goals in progress"
             value={goalsActive} suffix={`/ ${goalsActive + goalsHit}`}
             headRight={<div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
               <Icon name="target" size={14}/>
               <GearButton onClick={onGearToggle('metas')} active={gearOpen === 'metas'}/>
             </div>}
             foot={<>
               {goals.length ? (
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
               ) : <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>sem metas registradas</div>}
             </>}/>

        {/* P&P — engrenagem (E6 #2: edita correio) */}
        <KPI label="P&P do dia" en="Pick & Pack"
             value={pp.total_minutes ? fmtDur(pp.total_minutes) : '—'}
             headRight={<div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
               <Icon name="pp" size={14}/>
               <GearButton onClick={onGearToggle('pp')} active={gearOpen === 'pp'}/>
             </div>}
             foot={<>
               <div style={{ display: 'flex', gap: 16, marginTop: 4, flexWrap: 'wrap' }}>
                 <div>
                   <div className="kit-mlabel">ordens</div>
                   {pp.orders_reset ? (
                     // reajustado por operador: total antigo riscado + novo em vermelho
                     <span title={`Reajustado por ${pp.orders_reset.by || 'operador'}${pp.orders_reset.at ? ' às ' + pp.orders_reset.at : ''}`}>
                       <b className="mono" style={{ textDecoration: 'line-through', color: 'var(--ink-faint)', fontWeight: 500 }}>{pp.orders_reset.old_total}</b>
                       <b className="mono" style={{ color: 'var(--bad-deep)', marginLeft: 6 }}>{pp.orders}</b>
                       <span className="kit-mlabel" style={{ color: 'var(--bad-deep)', marginLeft: 4 }}>editado</span>
                     </span>
                   ) : <b className="mono">{pp.orders || 0}</b>}
                 </div>
                 {/* Veeqo do dia + diferença vs digitado (Bruno 08-06) */}
                 {vqToday.data && vqToday.data.total_orders != null && (() => {
                   const v = vqToday.data.total_orders; const d = (pp.orders || 0) - v;
                   return (
                     <div><div className="kit-mlabel">Veeqo</div>
                       <b className="mono">{v}</b>
                       <span className="mono" title="digitado menos Veeqo (positivo = TikTok/clínica ou sobra; negativo = faltou digitar)"
                         style={{ marginLeft: 5, fontSize: 11.5, fontWeight: 500,
                           color: d === 0 ? 'var(--ok-deep)' : (d > 0 ? 'var(--warn-deep)' : 'var(--bad-deep)') }}>
                         {d === 0 ? 'ok' : (d > 0 ? '+' + d : d)}
                       </span>
                     </div>
                   );
                 })()}
                 <div><div className="kit-mlabel">seg/ordem</div><b className="mono">{pp.seconds_per_order ? pp.seconds_per_order + 's' : '—'}</b></div>
                 {correioNotif && (
                   <div><div className="kit-mlabel">corte</div>
                        <b className="mono" style={{ color: (correioNotif._minutes != null && window.HFH.liveNowMin() > correioNotif._minutes) ? 'var(--bad-deep)' : 'var(--ok-deep)' }}>
                          {fmtClock(correioNotif._minutes)}{(correioNotif._minutes != null && window.HFH.liveNowMin() > correioNotif._minutes) ? ' vencido' : ''}</b></div>
                 )}
               </div>
               {/* TEMPO POR PESSOA (Bruno 06-22): cada pessoa no P&P + soma + média/pacote */}
               {pp.person_seconds && pp.person_seconds.length > 0 && (
                 <div style={{ marginTop: 10, borderTop: '1px dotted var(--dotline)', paddingTop: 8 }}>
                   <div className="kit-mlabel" style={{ marginBottom: 5 }}>
                     Tempo por pessoa · pessoa-hora
                   </div>
                   <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                     {pp.person_seconds.map((p) => (
                       <span key={p.person} className="kit-chip info">
                         {p.person}: {fmtDurSec(p.seconds)}
                       </span>
                     ))}
                   </div>
                   <div style={{ fontSize: 11.5, color: 'var(--ink-dim)' }}>
                     Soma: <b className="mono">{fmtDurSec(pp.person_seconds_total)}</b>
                     {pp.person_seconds_per_order != null && (
                       <span title="soma do tempo de todas as pessoas dividida pelo nº de pacotes"> · média <b className="mono" style={{ color: 'var(--kit-info)' }}>{pp.person_seconds_per_order}s</b>/pacote{pp.orders ? ` (${pp.orders} pacotes)` : ''}</span>
                     )}
                   </div>
                 </div>
               )}
               <EditPopover open={gearOpen === 'pp'} anchor={gear?.anchor} onClose={closeGear}
                            title="Editar P&P · correio">
                 {correioNotif ? (
                   <div>
                     <div style={{ fontSize: 12.5, color: 'var(--ink-dim)', marginBottom: 10 }}>
                       Corte do correio atual: <b>{fmtClock(correioNotif._minutes)}</b> · deadline #{correioNotif._deadline_id}
                     </div>
                     <button className="kit-btn sm primary" style={{ width: '100%' }}
                             onClick={async () => {
                               const t = window.prompt('Novo horário do corte (HH:MM 24h NY):', correioNotif._deadline_hhmm || '13:00');
                               if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return;
                               if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
                               const res = await writes.patchDeadline(correioNotif._deadline_id, { time_of_day: t + ':00' });
                               if (!res.ok) { ack(`Erro: ${res.error.message || res.error}`); return; }
                               if (refresh) refresh();
                               ack(`Correio atualizado ✓ ${t}`);
                               closeGear();
                             }}>
                       Editar horário do corte
                     </button>
                   </div>
                 ) : (
                   <div style={{ fontSize: 12.5, color: 'var(--ink-faint)' }}>
                     Sem deadline ativa configurada. Vai em Config pra criar um deadline novo.
                   </div>
                 )}
               </EditPopover>
             </>}/>

        {/* PEDIDOS HOJE (Veeqo · Fase ① Bruno 07-08) — read-only: pedidos com
            etiqueta impressa (shipped) hoje + unidades por suplemento e canal.
            Só aparece quando a Veeqo está configurada e há dado. */}
        {(() => {
          const vq = (raw && raw.veeqo) || null;
          if (!vq || vq.configured === false) return null;
          const shortName = (s) => String(s || '?').split('|')[0].replace(/^HealthFare\s*/i, '').replace(/^Healthfare\s*/i, '').trim() || '?';
          const chans = vq.by_channel || [];
          const prods = (vq.by_product || []).slice(0, 8);
          return (
            <KPI label="Pedidos hoje" en="Orders shipped · Veeqo"
                 value={(Number(vq.total_orders) || 0).toLocaleString()} suffix="pedidos"
                 headRight={<span className="kit-chip info" title="Veeqo · pedidos com etiqueta impressa hoje (multi-canal)">VEEQO</span>}
                 foot={<>
                   <div style={{ fontSize: 12.5, color: 'var(--ink-dim)', marginBottom: 6 }}>
                     <b className="mono" style={{ color: 'var(--kit-info)' }}>{(Number(vq.total_units) || 0).toLocaleString()}</b> unidades a produzir ou enviar
                   </div>
                   {vq.error ? (
                     <div style={{ fontSize: 11.5, color: 'var(--bad-deep)' }}>Veeqo indisponível ({vq.error}), mostrando 0</div>
                   ) : (<>
                     {chans.length > 0 && (
                       <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                         {chans.map((c) => (
                           <span key={c.channel} className="kit-chip neutral">
                             {c.channel}: {c.orders}
                           </span>
                         ))}
                       </div>
                     )}
                     {prods.length > 0 && (
                       <div style={{ borderTop: '1px dotted var(--dotline)', paddingTop: 7 }}>
                         <div className="kit-mlabel" style={{ marginBottom: 4 }}>
                           Unidades por suplemento
                         </div>
                         {prods.map((p) => (
                           <div key={(p.sku || '') + p.product} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, lineHeight: 1.7 }}>
                             <span style={{ color: 'var(--ink-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.product}>{shortName(p.product)}</span>
                             <b className="mono" style={{ color: 'var(--kit-info)' }}>{p.units}</b>
                           </div>
                         ))}
                         {(vq.by_product || []).length > prods.length && (
                           <div className="kit-mlabel" style={{ marginTop: 4 }}>
                             +{(vq.by_product || []).length - prods.length} outros suplementos
                           </div>
                         )}
                       </div>
                     )}
                   </>)}
                 </>}/>
          );
        })()}

        {/* FNSKU — labels colados, tempo, labels/min + por pessoa (Bruno 06-23) */}
        {fnsku && (Number(fnsku.total_labels) > 0 || (fnsku.person_seconds || []).length > 0) && (
          <KPI label="FNSKU hoje" en="FNSKU labels"
               value={(Number(fnsku.total_labels) || 0).toLocaleString()} suffix="labels"
               headRight={<FlowDot flow="production"/>}
               foot={<>
                 <div className="mono" style={{ fontSize: 12, color: 'var(--primary)', lineHeight: 1.6 }}>
                   {Number(fnsku.wall_seconds) > 0 && <span title="tempo de relógio colando FNSKU (união)">{fmtDurSec(fnsku.wall_seconds)}</span>}
                   {fnsku.labels_per_min != null && <span>{Number(fnsku.wall_seconds) > 0 ? ' · ' : ''}{fnsku.labels_per_min}/min</span>}
                   {fnsku.sec_per_label != null && <span> · {fnsku.sec_per_label}s/label</span>}
                 </div>
                 {(fnsku.person_seconds || []).length > 0 && (
                   <div style={{ marginTop: 8, borderTop: '1px dotted var(--dotline)', paddingTop: 8 }}>
                     <div className="kit-mlabel" style={{ marginBottom: 5 }}>
                       Tempo por pessoa · pessoa-hora
                     </div>
                     <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                       {fnsku.person_seconds.map((p) => (
                         <span key={p.person} className="kit-chip neutral">
                           {p.person}: {fmtDurSec(p.seconds)}
                         </span>
                       ))}
                     </div>
                     <div style={{ fontSize: 11.5, color: 'var(--ink-dim)' }}>
                       Soma: <b className="mono">{fmtDurSec(fnsku.person_seconds_total)}</b>
                       {fnsku.person_seconds_per_label != null && (
                         <span title="soma do tempo de todos dividida pelo nº de labels"> · média <b className="mono" style={{ color: 'var(--primary)' }}>{fnsku.person_seconds_per_label}s</b>/label</span>
                       )}
                     </div>
                   </div>
                 )}
               </>}/>
        )}

        {/* ATENÇÃO saiu do corpo da página (Bruno 06-23) — virou o SINO do topo:
            a contagem + a lista de notificações moram no dropdown do sino, e
            emergência (crítico novo) abre um modal de aviso. Ver dropdown + modal
            no fim do componente; publica a contagem pro sino via onNotifInfo. */}
      </div>
      </section>)}

      {/* Editor de metas — modal (Bruno 06-23): tela cheia centralizada (não fica
          mais atrás do card de P&P) + seletor de produto/lote estilo página dos op. */}
      <GoalsEditorModal
        open={gearOpen === 'metas'}
        onClose={closeGear}
        goals={goals}
        products={(raw && raw.products && (raw.products.products || raw.products)) || []}
        writes={writes}
        refresh={refresh}
        ack={ack}/>

      {/* ── DROPDOWN do SINO do topo (Bruno 06-23) — controlado por `notifOpen` (App).
          As notificações vivem AQUI, abaixo do sino, fora do corpo da página. ── */}
      {notifOpen && (
        <>
          <div onClick={onNotifClose} style={{ position: 'fixed', inset: 0, zIndex: 240, background: 'transparent' }}/>
          <div style={{ position: 'fixed', top: 58, right: 12, width: 'min(440px, 94vw)', maxHeight: '82vh', overflowY: 'auto', zIndex: 250 }}>
            <NotificationsCard
              notifs={allNotifs}
              visibleThreshold={GAP_VISIBLE_MIN}
              openNotifId={openNotifId}
              onNotifClick={onNotifClick}
              pendingDrafts={notifDrafts}
              onDraftChange={onNotifDraftChange}
              onDraftClear={onNotifDraftClear}
              gearOpen={gearOpen === 'notifs'}
              gearAnchor={gear?.anchor}
              onGear={onGearToggle('notifs')}
              onCloseGear={closeGear}
              ack={ack}
              operators={operators}
              events={state.events}
              GearButton={GearButton}
              EditPopover={EditPopover}
              EditList={EditList}
              V4_ALLOW_WRITES={V4_ALLOW_WRITES}
              onCreateInGap={onCreateInGap}
              writes={writes}
            />
          </div>
        </>
      )}

      {/* ── EMERGÊNCIA: crítico NOVO → modal de aviso (OK), no lugar do card fixo ── */}
      {emergency && (
        <div onClick={() => setEmergency(null)} className="kit-modal-back" style={{ zIndex: 320 }}>
          <div onClick={(e) => e.stopPropagation()} className="kit-modal" style={{ width: 'min(460px, 94vw)', borderTop: '3px solid var(--bad-deep)' }}>
            <div className="kit-mlabel">Atenção</div>
            <div className="title">Emergência na <em style={{ color: 'var(--green-d)', fontStyle: 'italic' }}>linha</em></div>
            <div className="preview">
              {(emergency.items || []).slice(0, 6).map((a, i) => (
                <div key={i} style={{ marginBottom: 4 }}>{a.title || a.label || a.msg || 'Crítico'}{a.detail ? ` · ${a.detail}` : ''}</div>
              ))}
              {(emergency.items || []).length === 0 && <div>Há uma notificação crítica nova. Veja no sino.</div>}
            </div>
            <div className="foot">
              <button className="kit-btn primary" onClick={() => setEmergency(null)}>OK</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Câmeras (widget, default antes de Filtros — Bruno 07-01) ── */}
      {wOn('cameras') && (<section style={{ order: wOrder('cameras') }}>
        <div className="opa-section">
          <span className="kit-mlabel">Câmeras ao vivo</span>
          <div className="rule"/>
        </div>
        <CameraGrid compact/>
      </section>)}

      {/* ── Filters ─────────────────────────────────────────── */}
      {wOn('filtros') && (<section style={{ order: wOrder('filtros') }}>
      <div className="opa-section">
        <span className="kit-mlabel">Filtros</span>
        <span className={`kit-chip ${filterStats.active ? 'neutral' : ''}`} title="Stats do recorte atual (tudo, se nenhum filtro ativo)"
              style={filterStats.active ? undefined : { background: 'var(--kit-surface-2)', color: 'var(--ink-faint)', boxShadow: 'inset 0 0 0 1px var(--line)' }}>
          {filterStats.active ? 'filtro ativo' : 'tudo'} · {filterStats.n} evento{filterStats.n === 1 ? '' : 's'} · {fmtDur(filterStats.min)}
        </span>
        <div className="rule"/>
      </div>
      <div className="filters">
        <span className="kit-mlabel" style={{ marginRight: 4 }}>Fluxo</span>
        {['production', 'pnp', 'support'].map((f) => {
          const on = filterFlows.has(f);
          return (
            <button key={f} className={`filter-chip flow-${f} ${on ? 'on' : ''}`}
                    onClick={() => setFilterFlows((s) => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; })}>
              <span className="dot"/>{(HFD.FLOWS && HFD.FLOWS[f] && HFD.FLOWS[f].label) || f}
            </button>
          );
        })}
        <span style={{ width: 16 }}/>
        <span className="kit-mlabel" style={{ marginRight: 4 }}>Pessoa</span>
        {operators.map((o) => {
          const on = filterOps.has(o.id);
          return (
            <button key={o.id} className={`filter-chip ${on ? 'on' : ''}`}
                    onClick={() => setFilterOps((s) => { const n = new Set(s); n.has(o.id) ? n.delete(o.id) : n.add(o.id); return n; })}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: o.c1, display: 'inline-block' }}/>
              {o.short}
            </button>
          );
        })}
        {(filterOps.size > 0 || filterFlows.size > 0) && (
          <button className="kit-btn sm" onClick={() => { setFilterOps(new Set()); setFilterFlows(new Set()); }}>
            Limpar
          </button>
        )}
      </div>

      {/* E6 #5 — TOTAIS calculados pelos filtros ativos */}
      {(filterFlows.size > 0 || filterOps.size > 0) && (() => {
        // Filtra eventos pelo cruzamento (interseção) dos chips ativos
        let filtered = state.events;
        if (filterFlows.size > 0) {
          filtered = filtered.filter((e) => {
            const a = HFD.activities && HFD.activities[e.activity];
            return a && filterFlows.has(a.flow);
          });
        }
        if (filterOps.size > 0) {
          filtered = filtered.filter((e) => filterOps.has(e.op));
        }
        // Total time wall (não soma duplicada cowork — usa union nas mesmas pessoas)
        // Simples por enquanto: soma cada event individualmente (pessoa-hora).
        let totalMin = 0;
        const byFlow = {};
        const byPerson = {};
        for (const e of filtered) {
          const end = e.ended_min == null ? now : e.ended_min;
          const dur = Math.max(0, end - e.started_min);
          totalMin += dur;
          const a = HFD.activities && HFD.activities[e.activity];
          const f = a ? a.flow : 'unknown';
          byFlow[f] = (byFlow[f] || 0) + dur;
          byPerson[e.op] = (byPerson[e.op] || 0) + dur;
        }
        return (
          <div className="kit-card pad" style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <div className="kit-mlabel">Tempo total filtrado</div>
                <div className="kit-kpi" style={{ fontSize: 26, marginTop: 3 }}>{fmtDur(totalMin)}</div>
              </div>
              <div style={{ flex: 1, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="kit-mlabel">{filtered.length} evento(s)</span>
                {Object.entries(byFlow).sort((a, b) => b[1] - a[1]).map(([f, mins]) => (
                  <span key={f} className="kit-chip neutral">
                    {(HFD.FLOWS && HFD.FLOWS[f] && HFD.FLOWS[f].label) || f}: {fmtDur(mins)}
                  </span>
                ))}
                {filterOps.size > 0 && Object.entries(byPerson).sort((a, b) => b[1] - a[1]).map(([opId, mins]) => {
                  const o = operators.find((x) => x.id === opId);
                  if (!o) return null;
                  return (
                    <span key={opId} className="kit-chip info" style={{ gap: 5 }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: o.c1, display: 'inline-block' }}/>
                      {o.short}: {fmtDur(mins)}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      </section>)}

      {/* ── Timeline ────────────────────────────────────────── */}
      {wOn('timeline') && (<section style={{ order: wOrder('timeline') }}>
      <div style={{ marginTop: 12 }}>
        {operators.length === 0 ? (
          <div className="opa-empty">
            Sem operadores postando hoje · (admins filtrados, sem eventos em {date})
          </div>
        ) : (
          <Timeline
            operators={operators}
            events={state.events}
            attMarkers={attMarkersByPerson}
            attState={attStateByPerson}
            now={now}
            hourPx={hourPx}
            setHourPx={setHourPx}
            filterOps={filterOps}
            filterFlows={filterFlows}
            onUpdateEvent={updateEvent}
            onMergeRequest={mergeRequest}
            onSelectEvent={(id, coords) => openPanel(state.events.find((e) => e.id === id), coords)}
            selectedId={state.selectedEventId}
            expandedOpIds={expandedOpIds}
            onToggleExpand={toggleExpand}
            gaps={_gaps}
            correio={correioNotif ? { minutes: correioNotif._minutes, label: correioNotif._label } : null}
            onCorreioClick={onCorreioClick}
            onGapClick={onGapClick}
            pendingDrags={pendingDrags}
            onConfirmDrags={confirmDrags}
            onCancelDrags={cancelDrags}
            fmtClock={fmtClock}
            invalidIds={invalidEventIds}
          />
        )}
      </div>
      </section>)}

      {/* ── Resumo do dia ─ Bloco 28/mai noite (Leva A): refatorado pra
           conceitos do negócio. Tudo derivado via util/day-stats.cjs com
           UNIÃO de intervalos (wall-clock), sem dupla-contagem. ──────── */}
      {wOn('resumo') && (<section style={{ order: wOrder('resumo') }}>
      <div className="opa-section" style={{ marginTop: 26 }}>
        <span className="kit-mlabel">Resumo do dia</span>
        <div className="rule"/>
      </div>
      {(() => {
        const prodT = dayStats.productionTime(state.events, now, HFD.activities || {});
        const supB  = dayStats.supportBreakdown(state.events, now, HFD.activities || {});
        const idleR = dayStats.idleRanking(state.events, now, operators, GAP_VISIBLE_MIN);
        const openT = dayStats.openTasksByOp(state.events, operators);
        const cowS  = dayStats.coworkStats(state.events);
        const lotes = dayStats.lotesEnriched((raw && raw.production && raw.production.lotes) || [], state.events);
        const goalsDone = goals.filter((g) => g.completed).length;
        return (
        <div className="day-summary-grid" style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12 }}>
          <div className="kit-card pad">
            <div className="kit-mlabel" style={{ marginBottom: 6 }}>Números do dia</div>
            <Row label="Data"                value={date}/>
            <Row label="Operadores hoje"     value={`${operators.length} pessoa(s)`}/>
            <Row label="Eventos hoje"        value={`${state.events.length}`}/>
            <Row label="Produção efetiva"    value={fmtDur(prodT.effectiveMin)}/>
            <Row label="Tempo parado"        value={fmtDur(prodT.stoppageMin)}/>
            <Row label="Suporte (limpeza)"   value={fmtDur(supB.cleaningTotal)}/>
            <Row label="Tempo médio/ordem"   value={pp.seconds_per_order ? `${pp.seconds_per_order}s` : '—'}/>
            <Row label="Corte do correio"    value={correioNotif ? fmtClock(correioNotif._minutes) : 'sem deadline'}/>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            {/* 1. PESSOAS · presença / ativo / break — wall-clock real */}
            <ScrollStrip title="Pessoas · presença e ativo">
              {operators.slice().map((op) => {
                const p = dayStats.personPresence(op.id, state.events, now);
                if (p.firstMin == null) return null;
                return (
                  <div key={op.id} className="opa-strip-item" style={{ minWidth: 208 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: op.c1 }}/>
                      <b style={{ fontSize: 12.5, fontWeight: 600 }}>{op.name}</b>
                    </div>
                    <div className="opa-strip-num">
                      {fmtDur(p.activeMin)} <span className="kit-mlabel">ativo</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--ink-dim)', marginTop: 4 }}>
                      <span title="janela da primeira à última atividade">presente {fmtDur(p.presenceMin)}</span>
                      {p.breakMin > 0 && <span title="lunch/break"> · break {fmtDur(p.breakMin)}</span>}
                    </div>
                    <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)', marginTop: 2 }}>
                      {fmtClock(p.firstMin)} → {p.lastMin >= now - 1 ? 'agora' : fmtClock(p.lastMin)}
                    </div>
                  </div>
                );
              }).filter(Boolean)}
            </ScrollStrip>

            {/* 2. LOTES — produto, fase atual, qty, cowork */}
            <ScrollStrip title="Lotes em produção">
              {lotes.length === 0
                ? <EmptyStrip msg="Sem lotes produzidos hoje"/>
                : lotes.slice().sort((a, b) => (b.total_seconds || 0) - (a.total_seconds || 0)).map((lote) => {
                  const dur = Math.round((lote.total_seconds || 0) / 60);
                  const phaseName = lote.current_phase_slug && HFD.activities && HFD.activities[lote.current_phase_slug]
                    ? HFD.activities[lote.current_phase_slug].name : (lote.current_phase_slug || '');
                  return (
                    <div key={lote.batch_id} className="opa-strip-item" style={{ minWidth: 236 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <b style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {lote.product_name}
                        </b>
                        {lote.is_live && <span title="rodando" style={{ color: 'var(--green)', fontSize: 11 }}>●</span>}
                      </div>
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>{lote.batch_number || '—'}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--ink-dim)', marginTop: 3 }}>
                        {phaseName || <span style={{ color: 'var(--ink-faint)', fontStyle: 'italic' }}>—</span>}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <div className="opa-strip-num" style={{ fontSize: 19 }}>{fmtDur(dur)}</div>
                        {lote.qty > 0 && (
                          <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-dim)' }}>{lote.qty}</span>
                        )}
                      </div>
                      {lote.people_ops.length > 0 && (
                        <div style={{ display: 'flex', gap: 3, marginTop: 6, flexWrap: 'wrap' }}>
                          {lote.people_ops.map((opId) => {
                            const o = operators.find((x) => x.id === opId);
                            if (!o) return null;
                            return (
                              <span key={opId} title={o.name} style={{
                                font: '500 10px var(--font-mono)', padding: '2px 7px', borderRadius: 'var(--r-pill)',
                                background: o.c1, color: '#fff',
                              }}>{o.short}</span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
            </ScrollStrip>

            {/* 3. PRODUÇÃO real vs paradas */}
            <div className="kit-card pad">
              <div className="kit-mlabel">Produção · efetivo vs parado</div>
              <div style={{ display: 'flex', gap: 22, alignItems: 'baseline', marginTop: 8, flexWrap: 'wrap' }}>
                <div>
                  <div className="kit-mlabel">efetivo</div>
                  <div className="kit-kpi" style={{ fontSize: 26 }}>{fmtDur(prodT.effectiveMin)}</div>
                </div>
                <div>
                  <div className="kit-mlabel">relógio total</div>
                  <div className="kit-kpi" style={{ fontSize: 20 }}>{fmtDur(prodT.wallClockMin)}</div>
                </div>
                <div>
                  <div className="kit-mlabel">parado (sobre prod)</div>
                  <div className="kit-kpi" style={{ fontSize: 20, color: 'var(--warn-deep)' }}>{fmtDur(prodT.stoppageMin)}</div>
                </div>
                {Object.entries(prodT.stoppageBySlug).length > 0 && (
                  <div style={{ flex: 1, minWidth: 200, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    {Object.entries(prodT.stoppageBySlug).sort((a, b) => b[1] - a[1]).map(([slug, mins]) => (
                      <span key={slug} className="kit-chip warn">
                        {HFD.activities && HFD.activities[slug] ? HFD.activities[slug].name : slug}: {fmtDur(mins)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 4. SUPORTE breakdown */}
            <ScrollStrip title="Suporte · breakdown">
              {(() => {
                const cards = [
                  { key: 'cleaning_day',  label: 'Limpeza · dia',       val: supB.cleaningDay,    color: 'var(--primary)' },
                  { key: 'cleaning_eod',  label: 'Limpeza · fim do dia', val: supB.cleaningEod,    color: 'var(--primary-deep)' },
                  { key: 'cleaning_tot',  label: 'Limpeza · total',     val: supB.cleaningTotal,  color: 'var(--primary)' },
                  { key: 'organization',  label: 'Organização',         val: supB.organization,   color: 'var(--kit-info)' },
                  { key: 'maintenance',   label: 'Manutenção',          val: supB.maintenance,    color: 'var(--kit-warn)' },
                  { key: 'downtime',      label: 'Downtime (máquina)',  val: supB.downtime,       color: 'var(--kit-bad)' },
                  { key: 'material',      label: 'Recebimento/Entrega', val: supB.materialHandling, color: 'var(--dispute)' },
                  { key: 'clinic',        label: 'Clínica · injeções',  val: supB.clinic,         color: 'var(--green-d)' },
                  { key: 'meeting',       label: 'Reuniões',            val: supB.meeting,        color: 'var(--ink-faint)' },
                  { key: 'training',      label: 'Treinamento',         val: supB.training,       color: 'var(--ink-dim)' },
                ].filter((c) => c.val > 0);
                if (cards.length === 0) return <EmptyStrip msg="Sem suporte registrado hoje"/>;
                return cards.map((c) => (
                  <div key={c.key} className="opa-strip-item" style={{ minWidth: 142, borderLeft: `3px solid ${c.color}` }}>
                    <div className="kit-mlabel">{c.label}</div>
                    <div className="opa-strip-num" style={{ fontSize: 19 }}>{fmtDur(c.val)}</div>
                  </div>
                ));
              })()}
            </ScrollStrip>

            {/* 5. IDLE ranking — quem ficou mais parado */}
            <ScrollStrip title={`Idle ranking · gaps de ${GAP_VISIBLE_MIN}min ou mais`}>
              {idleR.filter((r) => r.idleMin > 0).length === 0
                ? <EmptyStrip msg="Sem gaps significativos"/>
                : idleR.filter((r) => r.idleMin > 0).map((r, i) => (
                  <div key={r.opId} className="opa-strip-item" style={{ minWidth: 168 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="kit-mlabel">{i + 1}</span>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: r.opC1 }}/>
                      <b style={{ fontSize: 12.5, fontWeight: 600 }}>{r.opName}</b>
                    </div>
                    <div className="opa-strip-num warn">{fmtDur(r.idleMin)}</div>
                    <div className="kit-mlabel" style={{ marginTop: 2 }}>{r.gapsCount} gap(s)</div>
                  </div>
                ))}
            </ScrollStrip>

            {/* 6a. TAREFAS ABERTAS (LIVE sem F, exceto end_of_day) */}
            <ScrollStrip title="Tarefas abertas (ao vivo sem fechar)">
              {openT.length === 0
                ? <EmptyStrip msg="Tudo fechado"/>
                : openT.map((t) => (
                  <div key={t.opId} className="opa-strip-item" style={{ minWidth: 148 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.opC1 }}/>
                      <b style={{ fontSize: 12.5, fontWeight: 600 }}>{t.opName}</b>
                    </div>
                    <div className="opa-strip-num warn">{t.count}</div>
                    <div className="kit-mlabel" style={{ marginTop: 2 }}>aberta(s)</div>
                  </div>
                ))}
            </ScrollStrip>

            {/* 6c+d+f. COWORK / PRODUTOS / ALERTAS — strip resumida */}
            <ScrollStrip title="Métricas do dia">
              <MetricCard label="Cowork" value={cowS.total} sub="evento(s) colaborativo(s)" color="var(--dispute)"/>
              <MetricCard label="Lotes completados" value={goalsDone} sub={`de ${goals.length} meta(s)`} color="var(--green)" tone="ok"/>
              <MetricCard label="Alertas" value={allNotifs.length}
                          sub={`${badCount} crítico · ${warnCount} atenção · ${infoCount} info`}
                          color={badCount > 0 ? 'var(--kit-bad)' : warnCount > 0 ? 'var(--kit-warn)' : 'var(--ink-faint)'}
                          tone={badCount > 0 ? 'bad' : warnCount > 0 ? 'warn' : null}/>
              <MetricCard label="Backgrounds ativos"
                          value={state.events.filter((e) => e._is_background && e.ended_min == null).length}
                          sub="rodando agora" color="var(--kit-info)"/>
              <MetricCard label="Eventos em andamento"
                          value={state.events.filter((e) => e.ended_min == null).length}
                          sub="ao vivo no total" color="var(--green-d)" tone="ok"/>
            </ScrollStrip>
          </div>
        </div>
        );
      })()}
      </section>)}

      {/* E6 #6 — FloatingPopover pra preencher gap */}
      <FloatingPopover
        open={!!gapFill}
        anchor={gapFill?.coords}
        width={400}
        draggable={true}
        onClose={closeGapFill}
        anchorSelector=".tl-gap-zone, .exp-row-gap"
        header={gapFill && (() => {
          const op = operators.find((x) => x.id === gapFill.opId);
          return (
            <>
              <span style={{ color: 'var(--ink-faint)', fontSize: 14 }}>⋮⋮</span>
              <Icon name="plus" size={14}/>
              <b style={{ fontSize: 13, flex: 1, fontWeight: 600 }}>
                Preencher gap · {op?.name || '?'} · {fmtClock(gapFill.gap.start)}→{fmtClock(gapFill.gap.end)} ({fmtDur(gapFill.gap.dur)})
              </b>
              <button className="kit-btn xs" onClick={closeGapFill} style={{ padding: '0 8px' }}><Icon name="x" size={11}/></button>
            </>
          );
        })()}>
        {gapFill && (
          <>
            <div style={{ marginBottom: 12 }}>
              <label className="kit-mlabel" style={{ display: 'block', marginBottom: 5 }}>
                Tipo de atividade
              </label>
              <select className="kit-input" style={{ width: '100%' }} value={gapFill.form.reasonCat}
                      onChange={(e) => setGapFill((g) => ({ ...g, form: { ...g.form, reasonCat: e.target.value } }))}>
                <option value="almoco">Almoço (lunch)</option>
                <option value="pausa">Pausa curta (break)</option>
                <option value="limpeza">Limpeza (cleaning)</option>
                <option value="transicao">Transição ou organização</option>
                <option value="outro">Outro motivo</option>
              </select>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label className="kit-mlabel" style={{ display: 'block', marginBottom: 5 }}>
                Descrição livre
              </label>
              <textarea className="kit-input" style={{ width: '100%' }} rows={3} value={gapFill.form.note}
                        onChange={(e) => setGapFill((g) => ({ ...g, form: { ...g.form, note: e.target.value } }))}
                        placeholder="ex.: foi limpar a linha 2 depois do encapsulamento"/>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="kit-btn sm primary" onClick={saveGapFill}>Criar evento no gap</button>
              <button className="kit-btn sm" onClick={closeGapFill}>Cancelar</button>
              <span style={{ flex: 1 }}/>
              <span className="kit-mlabel">
                {V4_ALLOW_WRITES ? 'persiste em prod' : 'preview · writes off'}
              </span>
            </div>
          </>
        )}
      </FloatingPopover>

      {/* FASE 3 — drill-down de taxas (Produção bottle/seg · Revisão cápsula/seg por produto) */}
      <FloatingPopover
        open={!!drill}
        anchor={drill?.anchor}
        width={420}
        onClose={closeDrill}
        anchorSelector=".kpi-value-btn"
        header={
          <>
            <Icon name={drill?.which === 'revisao' ? 'search' : 'factory'} size={14}/>
            <b style={{ fontSize: 13, flex: 1, fontWeight: 600 }}>
              {drill?.which === 'revisao' ? 'Taxa de revisão · por produto' : 'Produção · taxa por lote'}
            </b>
            <button className="kit-btn xs" onClick={closeDrill} style={{ padding: '0 8px' }}><Icon name="x" size={11}/></button>
          </>
        }>
        {drill?.which === 'producao' && (
          <div>
            {/* Quantidade — topo, destaque */}
            <div style={{ marginBottom: 12 }}>
              <DrillStat label="Quantidade total" value={liveProd.toLocaleString()} unit="garrafas"/>
            </div>

            {/* BLOCO 1 — só a LINHA, por relógio (métrica principal) */}
            <div style={{ borderTop: '1px dotted var(--dotline)', paddingTop: 10, marginBottom: 12 }}>
              <div className="kit-mlabel" style={{ color: 'var(--green-d)', marginBottom: 7 }}>
                Linha de produção · só a linha, por relógio
              </div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <DrillStat label="Tempo de linha (relógio)" value={lineWall > 0 ? fmtDurSec(lineWall) : '—'} unit="produzindo"/>
                <DrillStat label="Garrafas / min" value={prodPerMin != null ? prodPerMin : '—'} unit="/min"/>
                <DrillStat label="Tempo / garrafa" value={secPerBottle != null ? secPerBottle : '—'} unit="seg"/>
                {ln && Number(ln.person_seconds) > 0 && (
                  <DrillStat label="Trabalho (pessoa-hora)" value={fmtDurSec(ln.person_seconds)} unit={`${ln.event_count || 0} eventos`}/>
                )}
                {ln && Number(ln.span_seconds) > 0 && (
                  <DrillStat label="Janela (início→fim)" value={fmtDurSec(ln.span_seconds)} unit="1º ao último"/>
                )}
              </div>
            </div>

            {/* BLOCO 2 — PRODUÇÃO TOTAL (linha+revisão+labeling…), pessoa-hora (a antiga) */}
            {ft && Number(ft.person_seconds) > 0 && (
              <div style={{ borderTop: '1px dotted var(--dotline)', paddingTop: 10, marginBottom: 12 }}>
                <div className="kit-mlabel" style={{ marginBottom: 7 }}>
                  Produção total · linha + revisão + labeling, pessoa-hora
                </div>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 8 }}>
                  <DrillStat label="Tempo total (pessoa-hora)" value={fmtDurSec(ft.person_seconds)} unit="todo o fluxo"/>
                  <DrillStat label="Garrafas / min" value={flowPerMin != null ? flowPerMin : '—'} unit="/min"/>
                  <DrillStat label="Tempo / garrafa" value={ft.sec_per_bottle != null ? ft.sec_per_bottle : '—'} unit="seg"/>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(ft.by_phase || []).filter((p) => p.seconds > 0).map((p) => (
                    <span key={p.slug} className="kit-chip neutral">
                      {p.name}: {fmtDurSec(p.seconds)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div style={{ fontSize: 12, color: 'var(--ink-dim)', marginBottom: 12, lineHeight: 1.55 }}>
              <b>Linha (relógio)</b> = tempo real em que a linha esteve produzindo, sem contar duas vezes quando tem gente junto. É o ritmo de verdade.
              <b> Produção total (pessoa-hora)</b> = soma do tempo de todos (linha + revisão + labeling). Maior porque empilha as pessoas e inclui as outras fases.
            </div>
            {(prod.lotes || []).filter((l) => (l.bottles || 0) > 0).length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--ink-faint)', padding: '8px 0' }}>
                Sem garrafas contadas hoje. Quando os operadores informarem as bottles, a taxa por lote aparece aqui.
              </div>
            ) : (
              <table className="kit-table">
                <thead>
                  <tr>
                    <th>Lote</th>
                    <th className="num">Garrafas</th>
                    <th className="num">/min</th>
                    <th className="num">/seg</th>
                  </tr>
                </thead>
                <tbody>
                  {(prod.lotes || []).filter((l) => (l.bottles || 0) > 0)
                    .sort((a, b) => (b.bottles || 0) - (a.bottles || 0)).map((l, i) => (
                    <tr key={i}>
                      <td>
                        <b style={{ fontWeight: 600 }}>{l.product}</b>
                        <span className="mono" style={{ color: 'var(--ink-faint)', marginLeft: 5 }}>{l.batch_number || ''}</span>
                      </td>
                      <td className="num">{l.bottles}</td>
                      <td className="num" style={{ color: 'var(--primary)' }}>{l.bottles_per_min != null ? l.bottles_per_min : '—'}</td>
                      <td className="num" style={{ color: 'var(--primary)' }}>{l.bottles_per_sec != null ? l.bottles_per_sec : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="kit-mlabel" style={{ marginTop: 10 }}>
              Taxa = garrafas dividido pelo tempo efetivo de produção do lote, descontando paradas.
            </div>
          </div>
        )}
        {drill?.which === 'revisao' && <ReviewDetail date={date} today={review}/>}
      </FloatingPopover>
    </div>
  );
}

/* FASE 3 — detalhe da Revisão: escopo (Hoje/7d/30d/custom) + por pessoa + por produto.
   Busca /review-rate sob demanda. `today` = snapshot do dia (escopo inicial). */
function ReviewDetail({ date, today }) {
  const [scope, setScope] = React.useState('today'); // today | 7d | 30d | custom
  const [from, setFrom] = React.useState(date);
  const [to, setTo] = React.useState(date);
  const [data, setData] = React.useState(today || null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState(null);

  const query = React.useMemo(() => {
    if (scope === 'today') return `from=${date}&to=${date}`;
    if (scope === '7d') return 'range=7d';
    if (scope === '30d') return 'range=30d';
    return `from=${from}&to=${to}`; // custom
  }, [scope, date, from, to]);

  React.useEffect(() => {
    if (scope === 'today' && today) { setData(today); return undefined; }
    let alive = true; setLoading(true); setErr(null);
    apiGet('/review-rate?' + query).then(
      (j) => { if (alive) { setData(j.data); setLoading(false); } },
      (e) => { if (alive) { setErr(e); setLoading(false); } },
    );
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const d = data || {};
  const Tbl = ({ rows, firstLabel, firstKey }) => (
    (!rows || rows.length === 0) ? <div style={{ fontSize: 12.5, color: 'var(--ink-faint)', padding: '6px 0' }}>—</div> : (
      <table className="kit-table">
        <thead><tr>
          <th>{firstLabel}</th>
          <th className="num">n</th>
          <th className="num">cáps/seg</th>
          <th className="num">frasco/min</th>
          <th className="num">seg/frasco</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><b style={{ fontWeight: 600 }}>{r[firstKey] || '(?)'}</b></td>
              <td className="num" style={{ color: 'var(--ink-faint)' }}>{r.n}</td>
              <td className="num" style={{ color: 'var(--primary)' }}>{r.avg_capsules_per_sec != null ? r.avg_capsules_per_sec : '—'}</td>
              <td className="num" style={{ color: 'var(--primary)' }}>{r.avg_bottles_per_min != null ? r.avg_bottles_per_min : '—'}</td>
              <td className="num">{r.avg_sec_per_bottle != null ? r.avg_sec_per_bottle : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  );

  return (
    <div>
      <div className="kit-seg" style={{ marginBottom: 12 }}>
        {[['today', 'Hoje'], ['7d', '7d'], ['30d', '30d'], ['custom', 'Custom']].map(([id, label]) => (
          <button key={id} className={scope === id ? 'on' : ''} onClick={() => setScope(id)}>{label}</button>
        ))}
      </div>
      {scope === 'custom' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="kit-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }}/>
          <span style={{ color: 'var(--ink-faint)' }}>→</span>
          <input className="kit-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }}/>
        </div>
      )}
      {loading ? <div style={{ fontSize: 12.5, color: 'var(--ink-faint)', padding: '8px 0' }}>Carregando…</div>
        : err ? <div style={{ fontSize: 12.5, color: 'var(--bad-deep)', padding: '8px 0' }}>Erro: {err.message}</div>
        : (
        <>
          <div style={{ display: 'flex', gap: 18, marginBottom: 12, flexWrap: 'wrap' }}>
            <DrillStat label="Cápsulas/seg" value={d.avg_capsules_per_sec != null ? d.avg_capsules_per_sec : '—'} unit="média"/>
            <DrillStat label="Frascos/min" value={d.avg_bottles_per_min != null ? d.avg_bottles_per_min : '—'} unit="média"/>
            <DrillStat label="Tempo/frasco" value={d.avg_sec_per_bottle != null ? d.avg_sec_per_bottle : '—'} unit="seg médio"/>
            <DrillStat label="Revisões" value={d.n || 0} unit={scope === 'today' ? 'no dia' : (d.scope || '')}/>
          </div>
          <div className="kit-mlabel" style={{ margin: '6px 0' }}>Por pessoa</div>
          <Tbl rows={d.operators} firstLabel="Operador" firstKey="operator"/>
          <div className="kit-mlabel" style={{ margin: '14px 0 6px' }}>Por produto</div>
          <Tbl rows={d.products} firstLabel="Produto" firstKey="product"/>
        </>
      )}
      <div className="kit-mlabel" style={{ marginTop: 10 }}>
        Cápsulas = garrafas vezes cápsulas por frasco do lote. O tempo desconta pausas.
      </div>
    </div>
  );
}

/* FASE 3 — mini-stat do drill-down (taxa em destaque). */
function DrillStat({ label, value, unit, color }) {
  return (
    <div>
      <div className="kit-mlabel">{label}</div>
      <div className="kit-kpi" style={{ fontSize: 24, color: color || 'var(--primary-deep)', marginTop: 3 }}>
        {value}{unit && <span className="kit-mlabel" style={{ marginLeft: 5 }}>{unit}</span>}
      </div>
    </div>
  );
}

/* Bloco 28/mai noite — placeholder pra strip sem dados. */
function EmptyStrip({ msg }) {
  return <div className="opa-strip-empty">{msg}</div>;
}

/* Bloco 28/mai noite — card genérico pra strip "Métricas do dia". */
function MetricCard({ label, value, sub, color = 'var(--ink-faint)', tone }) {
  return (
    <div className="opa-strip-item" style={{ minWidth: 158, borderLeft: `3px solid ${color}` }}>
      <div className="kit-mlabel">{label}</div>
      <div className={`opa-strip-num ${tone || ''}`}>{value}</div>
      {sub && <div className="kit-mlabel" style={{ marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

/* E6 #8 — barra horizontal scrollável p/ tirinhas de info. */
function ScrollStrip({ title, children }) {
  return (
    <div className="kit-card pad" style={{ padding: '14px 16px' }}>
      <div className="kit-mlabel" style={{ marginBottom: 8 }}>{title}</div>
      <div style={{
        display: 'flex', gap: 8, overflowX: 'auto', overflowY: 'hidden',
        paddingBottom: 4,
      }}>
        {children}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Subcomponentes inline
// ────────────────────────────────────────────────────────────

const Row = ({ label, value }) => (
  <div className="kit-dotted-row" style={{ justifyContent: 'space-between', fontSize: 13.5 }}>
    <span style={{ color: 'var(--ink-dim)' }}>{label}</span>
    <b className="mono tabnum" style={{ color: 'var(--primary-deep)', fontWeight: 500 }}>{value}</b>
  </div>
);

function GearButton({ onClick, active }) {
  return (
    <button onClick={onClick}
            className="gear-btn"
            style={{
              width: 22, height: 22, fontSize: 13, padding: 0, borderRadius: 'var(--r-pill)',
              background: active ? 'var(--primary-soft)' : 'transparent',
              border: 'none', cursor: 'pointer', color: active ? 'var(--primary)' : 'var(--ink-faint)',
            }}
            title="Editar">
      ⚙
    </button>
  );
}

/* E6 #1 — EditPopover usa FloatingPopover (position:fixed → não corta no
   overflow do card). Coords vêm do clique na engrenagem. */
function EditPopover({ open, anchor, onClose, title, children }) {
  return (
    <FloatingPopover
      open={open}
      anchor={anchor}
      width={360}
      onClose={onClose}
      anchorSelector=".gear-btn"
      header={
        <>
          <span className="kit-mlabel" style={{ flex: 1 }}>{title}</span>
          <button className="kit-btn xs" onClick={onClose} style={{ padding: '0 8px' }}><Icon name="x" size={11}/></button>
        </>
      }>
      {children}
      <div className="kit-mlabel" style={{
        marginTop: 12, padding: '7px 9px',
        background: 'var(--kit-surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-xs)',
      }}>
        {V4_ALLOW_WRITES ? 'Edições persistem em prod, auditadas via PIN' : 'V4_ALLOW_WRITES=0 · salvar só toasta preview'}
      </div>
    </FloatingPopover>
  );
}

function EditList({ items, emptyMsg, onAdd, onEdit, onDelete }) {
  return (
    <div>
      {items.length === 0
        ? <div style={{ fontSize: 12.5, color: 'var(--ink-faint)', padding: '8px 0' }}>{emptyMsg}</div>
        : items.map((it) => (
          <div key={it.id} className="kit-dotted-row" style={{ padding: '8px 0' }}>
            <span style={{ flex: 1, fontSize: 12.5 }}>{it.label}</span>
            <button className="kit-btn xs" onClick={() => onEdit(it)} title="Editar" style={{ padding: '0 8px' }}>
              <Icon name="edit" size={12}/>
            </button>
            <button className="kit-btn xs" onClick={() => onDelete(it)} title="Apagar" style={{ padding: '0 8px' }}>
              <Icon name="trash" size={12}/>
            </button>
          </div>
        ))}
      <button className="kit-btn sm primary" onClick={onAdd} style={{ marginTop: 10, width: '100%' }}>
        + Adicionar
      </button>
    </div>
  );
}

// (E7-refine2) CorreioBlock removido — agora é notif attached na timeline.

// EDITOR DE METAS (Bruno 06-23) — modal centralizado (acima de tudo, sem ficar
// atrás dos cards) com seletor de PRODUTO + LOTE no estilo da página dos operadores:
// busca o produto na lista; escolhe um lote já existente (chips) OU digita o lote,
// OU deixa sem lote. Resolve product_id de verdade (a meta deixa de aparecer "(?)").
function GoalsEditorModal({ open, onClose, goals, products, writes, refresh, ack }) {
  const [batches, setBatches] = React.useState([]);
  const [q, setQ] = React.useState('');
  const [sel, setSel] = React.useState(null);   // { product_id, product_name }
  const [lotText, setLotText] = React.useState('');
  const [qty, setQty] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!open) return undefined;
    setQ(''); setSel(null); setLotText(''); setQty('');
    let alive = true;
    apiGet('/batches').then((j) => {
      if (!alive) return;
      const arr = (j && j.data && j.data.active) || [];
      setBatches(arr.map((b) => ({ batch_number: b.batch_number, product_id: b.product && b.product.id, product_name: b.product && b.product.canonical_name })));
    }).catch(() => { if (alive) setBatches([]); });
    return () => { alive = false; };
  }, [open]);
  if (!open) return null;
  const INPUT = { width: '100%', padding: '11px 13px', fontSize: 14.5, border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', background: 'var(--kit-surface-2)', color: 'var(--ink)', outline: 'none', fontFamily: 'var(--font)' };
  const ROW = { display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', fontSize: 13.5, border: 'none', borderBottom: '1px dotted var(--dotline)', background: 'transparent', color: 'var(--ink)', cursor: 'pointer', fontFamily: 'var(--font)' };
  const ql = q.trim().toLowerCase();
  const prodList = (products || []).filter((p) => p && p.id != null && (!ql || String(p.canonical_name || '').toLowerCase().includes(ql))).slice(0, 50);
  const lotsForSel = sel ? batches.filter((b) => b.product_id === sel.product_id) : [];
  const errMsg = (e) => (e && (e.message || (e.body && e.body.error))) || e || 'erro';
  const add = async () => {
    if (!sel) { ack('Escolhe um produto primeiro'); return; }
    const n = parseInt(qty, 10);
    if (!Number.isFinite(n) || n <= 0) { ack('Informe a quantidade de bottles'); return; }
    const batch = lotText.trim() || null;
    if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
    setBusy(true);
    const res = await writes.createGoal({ product_id: sel.product_id, batch_number: batch, expected_quantity: n, unit: 'bottle' });
    setBusy(false);
    if (!res.ok) { ack(`Erro: ${errMsg(res.error)}`); return; }
    setSel(null); setLotText(''); setQty(''); setQ('');
    if (refresh) refresh();
    ack(`Meta criada ✓ ${sel.product_name}${batch ? ' · ' + batch : ' (sem lote)'} = ${n}`);
  };
  const editQty = async (g) => {
    const v = window.prompt(`Nova meta (bottles) pra ${g._product_name || g.product || '?'}:`, String(g.target || 0));
    if (v == null) return;
    const nn = Number(v);
    if (!Number.isFinite(nn) || nn <= 0) { ack('Valor inválido'); return; }
    if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
    const res = await writes.patchGoal(g.id, { expected_quantity: nn });
    if (!res.ok) { ack(`Erro: ${errMsg(res.error)}`); return; }
    if (refresh) refresh(); ack('Salvo ✓');
  };
  const del = async (g) => {
    if (!window.confirm(`Apagar meta ${g._product_name || g.product || ''} (${g.target})?`)) return;
    if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
    const res = await writes.deleteGoal(g.id, 'apagado via /dashboard-v4');
    if (!res.ok) { ack(`Erro: ${errMsg(res.error)}`); return; }
    if (refresh) refresh(); ack('Apagado ✓');
  };
  return (
    <div onClick={onClose} className="opa-modal-back" style={{ alignItems: 'flex-start' }}>
      <div onClick={(e) => e.stopPropagation()} className="opa-modal">
        <div className="opa-modal-head">
          <Icon name="target" size={16}/>
          <span className="opa-modal-title">Editar metas do dia</span>
          <button className="kit-btn xs" onClick={onClose} style={{ padding: '0 8px' }}><Icon name="x" size={12}/></button>
        </div>
        <div style={{ padding: 18, overflowY: 'auto' }}>
          <div className="kit-mlabel" style={{ marginBottom: 8 }}>Adicionar meta</div>
          {!sel ? (
            <>
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar produto…" style={INPUT}/>
              <div style={{ maxHeight: 240, overflowY: 'auto', marginTop: 8, border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
                {prodList.length === 0
                  ? <div style={{ padding: 12, fontSize: 12.5, color: 'var(--ink-faint)' }}>{q ? 'Nenhum produto com esse nome.' : 'Carregando catálogo…'}</div>
                  : prodList.map((p) => (
                    <button key={p.id} onClick={() => { setSel({ product_id: p.id, product_name: p.canonical_name }); setQ(''); }} style={ROW}>
                      {p.canonical_name}
                    </button>
                  ))}
              </div>
            </>
          ) : (
            <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 14, background: 'var(--kit-surface-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <b style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{sel.product_name}</b>
                <button className="kit-btn xs" onClick={() => { setSel(null); setLotText(''); }}>trocar</button>
              </div>
              <div className="kit-mlabel" style={{ marginBottom: 7 }}>Lote (opcional, vazio = sem lote)</div>
              {lotsForSel.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {lotsForSel.map((b) => (
                    <button key={b.batch_number} onClick={() => setLotText(b.batch_number)}
                            className={`kit-chip ${lotText === b.batch_number ? 'solid' : 'neutral'}`} style={{ cursor: 'pointer', border: 'none' }}>{b.batch_number}</button>
                  ))}
                  <button onClick={() => setLotText('')}
                          className={`kit-chip ${!lotText ? 'solid' : 'neutral'}`} style={{ cursor: 'pointer', border: 'none' }}>sem lote</button>
                </div>
              )}
              <input value={lotText} onChange={(e) => setLotText(e.target.value)} placeholder="ou digite o lote (ex: BR-2026-0231)" style={INPUT}/>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" placeholder="bottles (ex: 500)" style={{ ...INPUT, flex: 1 }}/>
                <button className="kit-btn primary" disabled={busy} onClick={add}>{busy ? '…' : 'Adicionar'}</button>
              </div>
            </div>
          )}
          <div className="kit-mlabel" style={{ margin: '20px 0 6px' }}>Metas de hoje</div>
          {(goals || []).length === 0
            ? <div style={{ fontSize: 12.5, color: 'var(--ink-faint)' }}>Sem metas registradas.</div>
            : (goals || []).map((g) => (
              <div key={g.id} className="kit-dotted-row">
                <span style={{ flex: 1, fontSize: 13 }}>
                  {g._product_name || g.product || '(?)'}{g.batch ? ' · ' + g.batch : ''}
                  <span style={{ color: 'var(--ink-dim)' }}> · {g.target} bottles (feito {g.done})</span>
                </span>
                <button className="kit-btn xs" onClick={() => editQty(g)} title="Editar quantidade" style={{ padding: '0 8px' }}><Icon name="edit" size={12}/></button>
                <button className="kit-btn xs" onClick={() => del(g)} title="Apagar" style={{ padding: '0 8px' }}><Icon name="trash" size={12}/></button>
              </div>
            ))}
          {!V4_ALLOW_WRITES && <div className="kit-mlabel" style={{ marginTop: 12 }}>V4_ALLOW_WRITES=0 · preview, não grava.</div>}
        </div>
      </div>
    </div>
  );
}

window.CommandCenter = CommandCenter;

export { CommandCenter };
