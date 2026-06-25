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
import { NotificationsCard } from '../components/NotificationsPanel.jsx';
import { FloatingPopover } from '../components/FloatingPopover.jsx';
import { V4_ALLOW_WRITES } from '../flags.js';
import { apiGet } from '../adapters/from-api.js';
import nyTime from '../utils/ny-time.cjs';
import dayStats from '../utils/day-stats.cjs';

const NOTIFS_VISIBLE_KEY = 'hf-notifs-visible';

const GAP_VISIBLE_MIN = 25;    // gaps >= isso aparecem no card; menores só editáveis via expand
const GAP_TRACKED_MIN = 5;     // gaps >= isso entram em allNotifs (mesmo invisíveis)

function CommandCenter({ state, setState, openPanel, ack, loading, error, hfdata, refresh, date, raw,
                          onMerge, onSplit, onCreateInGap, writes,
                          notifOpen, onNotifClose, onNotifInfo }) {
  const now = window.HFH.useNow(true);
  const HFD = hfdata || window.HFData;
  const { operators = [], goals = [], alerts = [], pp = {}, fnsku = null, _gaps = {} } = HFD;
  const { fmtClock, fmtDur } = window.HFH;

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
    if (!window.confirm(`Confirme — isso vai mudar a linha do tempo de verdade. Sim/Não`)) return;
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
    ack(`Aplicado ✓ — ${okCount} mudança(s)${errCount > 0 ? ` · ${errCount} falha(s)` : ''}`);
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
      {error && state.events.length > 0 && (
        <div className="alert-row warn" style={{ marginBottom: 10 }}>
          <div className="ico"><Icon name="bell" size={14}/></div>
          <div><b>Refresh falhou:</b> {error.message || String(error)}. Mostrando última leitura.</div>
        </div>
      )}

      {/* ── KPI strip ──────────────────────────────────────── */}
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
                     <div style={{ fontSize: 12, color: 'var(--flow-prod)', fontWeight: 700 }}>
                       <span style={{ fontSize: 9.5, opacity: 0.7, fontWeight: 800, letterSpacing: 0.3 }}>LINHA </span>
                       {lineWall > 0 && <span title="relógio em que a linha esteve produzindo (sem dupla contagem)">{fmtDurSec(lineWall)}</span>}
                       {prodPerMin != null && <span> · {prodPerMin}/min</span>}
                       {secPerBottle != null && <span> · {secPerBottle}s/un</span>}
                     </div>
                   )}
                   {/* TOTAL (linha + revisão + labeling…, pessoa-hora) — a antiga */}
                   {flowPerMin != null && (
                     <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600 }}>
                       <span style={{ fontSize: 9.5, opacity: 0.8, fontWeight: 800, letterSpacing: 0.3 }}>TOTAL </span>
                       <span title="garrafas ÷ soma de TODO o tempo de produção (linha+revisão+labeling), pessoa-hora">{fmtDurSec(flowSecs)} · {flowPerMin}/min</span>
                       {reviewPhase && Number(reviewPhase.seconds) > 0 && <span> · revisão {fmtDurSec(reviewPhase.seconds)}</span>}
                     </div>
                   )}
                 </div>
               )}
               {topLotes.length ? (
                 <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                   {topLotes.map((g) => (
                     <span key={g.id} className="pill prod">
                       <span className="dot"/>{g._product_name || g.product || '(?)'} {g.done}
                     </span>
                   ))}
                 </div>
               ) : <div style={{ fontSize: 12, color: 'var(--text-3)' }}>sem contagens hoje</div>}
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
                            ack(`Salvo ✓ — contagem ev${it.id} = ${n}`);
                          }}
                          onDelete={async (it) => {
                            if (!window.confirm(`Apagar contagem ${it.label}?`)) return;
                            if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
                            const res = await writes.deleteCount(it.id, 'apagado via /dashboard-v4');
                            if (!res.ok) { ack(`Erro: ${res.error.message || res.error}`); return; }
                            if (refresh) refresh();
                            ack(`Apagado ✓ — contagem ${it.id}`);
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
                 <div style={{ fontSize: 12, color: 'var(--flow-prod)', fontWeight: 700, marginBottom: 4 }}>
                   {review.avg_bottles_per_min}/min · {review.avg_sec_per_bottle != null ? `${review.avg_sec_per_bottle}s/frasco` : '—'}
                 </div>
               ) : <div style={{ fontSize: 12, color: 'var(--text-3)' }}>sem revisão com lote neste dia</div>}
               {(review.operators || []).length > 0 ? (
                 <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                   {(review.operators || []).slice(0, 4).map((o, i) => (
                     <span key={i} className="pill prod" title={`${o.n} revisão(ões)`}>
                       <span className="dot"/>{o.operator || '(?)'} {o.avg_capsules_per_sec}/s
                     </span>
                   ))}
                 </div>
               ) : null}
               <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
                 {review.n || 0} revisão(ões) no dia · clique p/ detalhe (30d / custom / por pessoa)
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
               ) : <div style={{ fontSize: 12, color: 'var(--text-3)' }}>sem metas registradas</div>}
             </>}/>

        {/* P&P — engrenagem (E6 #2: edita correio) */}
        <KPI label="P&P do dia" en="Pick & Pack"
             value={pp.total_minutes ? fmtDur(pp.total_minutes) : '—'}
             headRight={<div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
               <Icon name="pp" size={14}/>
               <GearButton onClick={onGearToggle('pp')} active={gearOpen === 'pp'}/>
             </div>}
             foot={<>
               <div style={{ display: 'flex', gap: 14, marginTop: 4 }}>
                 <div>
                   <div style={{ fontSize: 11, color: 'var(--text-3)' }}>ordens</div>
                   {pp.orders_reset ? (
                     // reajustado por operador: total antigo riscado + novo em vermelho
                     <span title={`Reajustado por ${pp.orders_reset.by || 'operador'}${pp.orders_reset.at ? ' às ' + pp.orders_reset.at : ''}`}>
                       <b className="mono" style={{ textDecoration: 'line-through', color: 'var(--text-3)', fontWeight: 500 }}>{pp.orders_reset.old_total}</b>
                       <b className="mono" style={{ color: '#c0352b', marginLeft: 6 }}>{pp.orders}</b>
                       <span style={{ fontSize: 9.5, color: '#c0352b', marginLeft: 4 }}>editado</span>
                     </span>
                   ) : <b className="mono">{pp.orders || 0}</b>}
                 </div>
                 <div><div style={{ fontSize: 11, color: 'var(--text-3)' }}>seg/ordem</div><b className="mono">{pp.seconds_per_order ? pp.seconds_per_order + 's' : '—'}</b></div>
                 {correioNotif && (
                   <div><div style={{ fontSize: 11, color: 'var(--text-3)' }}>corte</div>
                        <b className="mono" style={{ color: 'var(--hf-leaf-600)' }}>{fmtClock(correioNotif._minutes)}</b></div>
                 )}
               </div>
               {/* TEMPO POR PESSOA (Bruno 06-22): cada pessoa no P&P + soma + média/pacote */}
               {pp.person_seconds && pp.person_seconds.length > 0 && (
                 <div style={{ marginTop: 8, borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: 6 }}>
                   <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, color: 'var(--flow-pnp)', textTransform: 'uppercase', marginBottom: 4 }}>
                     Tempo por pessoa · pessoa-hora
                   </div>
                   <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 5 }}>
                     {pp.person_seconds.map((p) => (
                       <span key={p.person} className="pill" style={{ fontSize: 11, background: 'var(--surface-2, #f3f4f6)', color: 'var(--text-2, #4b5563)' }}>
                         {p.person}: <b>{fmtDurSec(p.seconds)}</b>
                       </span>
                     ))}
                   </div>
                   <div style={{ fontSize: 11, color: 'var(--text-2, #4b5563)', fontWeight: 600 }}>
                     Soma: <b className="mono">{fmtDurSec(pp.person_seconds_total)}</b>
                     {pp.person_seconds_per_order != null && (
                       <span title="soma do tempo de todas as pessoas ÷ nº de pacotes"> · média <b className="mono" style={{ color: 'var(--flow-pnp)' }}>{pp.person_seconds_per_order}s</b>/pacote{pp.orders ? ` (${pp.orders} pacotes)` : ''}</span>
                     )}
                   </div>
                 </div>
               )}
               <EditPopover open={gearOpen === 'pp'} anchor={gear?.anchor} onClose={closeGear}
                            title="Editar P&P · correio">
                 {correioNotif ? (
                   <div>
                     <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
                       Corte do correio atual: <b>{fmtClock(correioNotif._minutes)}</b> · deadline #{correioNotif._deadline_id}
                     </div>
                     <button className="btn sm primary" style={{ width: '100%' }}
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
                   <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                     Sem deadline ativa configurada. Vai em Config pra criar um deadline novo.
                   </div>
                 )}
               </EditPopover>
             </>}/>

        {/* FNSKU — labels colados, tempo, labels/min + por pessoa (Bruno 06-23) */}
        {fnsku && (Number(fnsku.total_labels) > 0 || (fnsku.person_seconds || []).length > 0) && (
          <KPI label="FNSKU hoje" en="FNSKU labels"
               value={(Number(fnsku.total_labels) || 0).toLocaleString()} suffix="labels"
               headRight={<FlowDot flow="production"/>}
               foot={<>
                 <div style={{ fontSize: 12, color: 'var(--flow-prod)', fontWeight: 700, lineHeight: 1.5 }}>
                   {Number(fnsku.wall_seconds) > 0 && <span title="tempo de relógio colando FNSKU (união)">⏱ {fmtDurSec(fnsku.wall_seconds)}</span>}
                   {fnsku.labels_per_min != null && <span>{Number(fnsku.wall_seconds) > 0 ? ' · ' : ''}{fnsku.labels_per_min}/min</span>}
                   {fnsku.sec_per_label != null && <span> · {fnsku.sec_per_label}s/label</span>}
                 </div>
                 {(fnsku.person_seconds || []).length > 0 && (
                   <div style={{ marginTop: 6, borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: 6 }}>
                     <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, color: 'var(--flow-prod)', textTransform: 'uppercase', marginBottom: 4 }}>
                       Tempo por pessoa · pessoa-hora
                     </div>
                     <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 5 }}>
                       {fnsku.person_seconds.map((p) => (
                         <span key={p.person} className="pill" style={{ fontSize: 11, background: 'var(--surface-2, #f3f4f6)', color: 'var(--text-2, #4b5563)' }}>
                           {p.person}: <b>{fmtDurSec(p.seconds)}</b>
                         </span>
                       ))}
                     </div>
                     <div style={{ fontSize: 11, color: 'var(--text-2, #4b5563)', fontWeight: 600 }}>
                       Soma: <b className="mono">{fmtDurSec(fnsku.person_seconds_total)}</b>
                       {fnsku.person_seconds_per_label != null && (
                         <span title="soma do tempo de todos ÷ nº de labels"> · média <b className="mono" style={{ color: 'var(--flow-prod)' }}>{fnsku.person_seconds_per_label}s</b>/label</span>
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
        <div onClick={() => setEmergency(null)} style={{ position: 'fixed', inset: 0, zIndex: 320, background: 'rgba(120,10,10,0.35)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--surface)', borderRadius: 16, boxShadow: 'var(--shadow-lg)', width: 'min(440px, 94vw)', borderTop: '4px solid var(--bad)', overflow: 'hidden' }}>
            <div style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ flex: 'none', width: 38, height: 38, borderRadius: 11, background: 'rgba(220,38,38,0.14)', color: 'var(--bad)', display: 'grid', placeItems: 'center' }}><Icon name="bell" size={20}/></span>
              <b style={{ fontSize: 16 }}>Atenção — emergência</b>
            </div>
            <div style={{ padding: '0 18px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(emergency.items || []).slice(0, 6).map((a, i) => (
                <div key={i} style={{ fontSize: 13, color: 'var(--text-2)' }}>• {a.title || a.label || a.msg || 'Crítico'}{a.detail ? ` — ${a.detail}` : ''}</div>
              ))}
              {(emergency.items || []).length === 0 && <div style={{ fontSize: 13, color: 'var(--text-2)' }}>Há uma notificação crítica nova. Veja no sino.</div>}
            </div>
            <div style={{ padding: 14, display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn primary" onClick={() => setEmergency(null)}>OK</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Filters ─────────────────────────────────────────── */}
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Filtros</h2><span className="en">· Filter view</span>
        <div className="rule"/>
      </div>
      <div className="filters">
        <span style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: 0.05, textTransform: 'uppercase', fontWeight: 700, marginRight: 4 }}>Fluxo:</span>
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
        <span style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: 0.05, textTransform: 'uppercase', fontWeight: 700, marginRight: 4 }}>Pessoa:</span>
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
          <button className="btn sm ghost" onClick={() => { setFilterOps(new Set()); setFilterFlows(new Set()); }}>
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
          <div className="card" style={{ marginTop: 8, padding: 12, background: 'var(--surface-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.08, fontWeight: 700 }}>
                  Tempo total filtrado
                </div>
                <b className="mono" style={{ fontSize: 18, color: 'var(--hf-navy-700)' }}>{fmtDur(totalMin)}</b>
              </div>
              <div style={{ flex: 1, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
                <span style={{ color: 'var(--text-3)' }}>{filtered.length} event(s)</span>
                {Object.entries(byFlow).sort((a, b) => b[1] - a[1]).map(([f, mins]) => (
                  <span key={f} className={`pill ${f}`}>
                    <span className="dot"/>{(HFD.FLOWS && HFD.FLOWS[f] && HFD.FLOWS[f].label) || f}: {fmtDur(mins)}
                  </span>
                ))}
                {filterOps.size > 0 && Object.entries(byPerson).sort((a, b) => b[1] - a[1]).map(([opId, mins]) => {
                  const o = operators.find((x) => x.id === opId);
                  if (!o) return null;
                  return (
                    <span key={opId} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: 11, padding: '2px 8px', borderRadius: 999,
                      background: 'var(--surface)', border: '1px solid var(--border)',
                    }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: o.c1, display: 'inline-block' }}/>
                      {o.short}: <b className="mono">{fmtDur(mins)}</b>
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Timeline ────────────────────────────────────────── */}
      <div style={{ marginTop: 12 }}>
        {operators.length === 0 ? (
          <div className="card" style={{ padding: 30, color: 'var(--text-3)', textAlign: 'center' }}>
            Sem operadores postando hoje · (admins filtrados, /timeline?date={date} sem eventos)
          </div>
        ) : (
          <Timeline
            operators={operators}
            events={state.events}
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

      {/* ── Resumo do dia ─ Bloco 28/mai noite (Leva A): refatorado pra
           conceitos do negócio. Tudo derivado via util/day-stats.cjs com
           UNIÃO de intervalos (wall-clock), sem dupla-contagem. ──────── */}
      <div className="section-title" style={{ marginTop: 24 }}>
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Resumo do dia</h2><span className="en">· Day summary</span>
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
          <div className="card" style={{ padding: 16 }}>
            <Row label="Data"                value={date}/>
            <Row label="Operadores hoje"     value={`${operators.length} pessoa(s)`}/>
            <Row label="Eventos hoje"        value={`${state.events.length}`}/>
            <Row label="Produção efetiva"    value={fmtDur(prodT.effectiveMin)}/>
            <Row label="Tempo parado"        value={fmtDur(prodT.stoppageMin)}/>
            <Row label="Suporte (limpeza)"   value={fmtDur(supB.cleaningTotal)}/>
            <Row label="Tempo médio/ordem"   value={pp.seconds_per_order ? `${pp.seconds_per_order}s` : '—'}/>
            <Row label="Corte do correio"    value={correioNotif ? fmtClock(correioNotif._minutes) : '— sem deadline'}/>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            {/* 1. PESSOAS · presença / ativo / break — wall-clock real */}
            <ScrollStrip title="Pessoas · presença e ativo" en="People · presence & active">
              {operators.slice().map((op) => {
                const p = dayStats.personPresence(op.id, state.events, now);
                if (p.firstMin == null) return null;
                return (
                  <div key={op.id} className="strip-item" style={{
                    minWidth: 200, padding: 10, borderRadius: 8,
                    background: 'var(--surface-2)', border: '1px solid var(--border)', flex: '0 0 auto',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: op.c1 }}/>
                      <b style={{ fontSize: 12.5 }}>{op.name}</b>
                    </div>
                    <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--hf-navy-700)', marginTop: 4 }}>
                      {fmtDur(p.activeMin)} <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 500 }}>ativo</span>
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>
                      <span title="janela primeira→última atividade">presente {fmtDur(p.presenceMin)}</span>
                      {p.breakMin > 0 && <span title="lunch/break"> · break {fmtDur(p.breakMin)}</span>}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                      {fmtClock(p.firstMin)} → {p.lastMin >= now - 1 ? 'agora' : fmtClock(p.lastMin)}
                    </div>
                  </div>
                );
              }).filter(Boolean)}
            </ScrollStrip>

            {/* 2. LOTES — produto, fase atual, qty, cowork */}
            <ScrollStrip title="Lotes em produção" en="Batches in production">
              {lotes.length === 0
                ? <EmptyStrip msg="Sem lotes produzidos hoje"/>
                : lotes.slice().sort((a, b) => (b.total_seconds || 0) - (a.total_seconds || 0)).map((lote) => {
                  const dur = Math.round((lote.total_seconds || 0) / 60);
                  const phaseName = lote.current_phase_slug && HFD.activities && HFD.activities[lote.current_phase_slug]
                    ? HFD.activities[lote.current_phase_slug].name : (lote.current_phase_slug || '');
                  return (
                    <div key={lote.batch_id} className="strip-item" style={{
                      minWidth: 230, padding: 10, borderRadius: 8,
                      background: 'var(--surface-2)', border: '1px solid var(--border)', flex: '0 0 auto',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <b style={{ fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {lote.product_name}
                        </b>
                        {lote.is_live && <span title="rodando" style={{ color: 'var(--hf-leaf-600)', fontSize: 11 }}>●</span>}
                      </div>
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{lote.batch_number || '—'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>
                        {phaseName || <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>—</span>}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 }}>
                        <b className="mono" style={{ fontSize: 14, color: 'var(--flow-prod)' }}>{fmtDur(dur)}</b>
                        {lote.qty > 0 && (
                          <span className="mono" style={{ fontSize: 11, fontWeight: 700 }}>{lote.qty}</span>
                        )}
                      </div>
                      {lote.people_ops.length > 0 && (
                        <div style={{ display: 'flex', gap: 2, marginTop: 4, flexWrap: 'wrap' }}>
                          {lote.people_ops.map((opId) => {
                            const o = operators.find((x) => x.id === opId);
                            if (!o) return null;
                            return (
                              <span key={opId} title={o.name} style={{
                                fontSize: 9, padding: '1px 5px', borderRadius: 999, fontWeight: 700,
                                background: o.c1, color: 'white',
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
            <div className="card" style={{ padding: 12, background: 'var(--surface-2)' }}>
              <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.08, fontWeight: 700 }}>
                Produção · efetivo vs parado <span style={{ marginLeft: 4, opacity: 0.7, textTransform: 'none', fontWeight: 500 }}>· Production effective vs stoppage</span>
              </div>
              <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', marginTop: 6, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>efetivo</div>
                  <b className="mono" style={{ fontSize: 20, color: 'var(--flow-prod)' }}>{fmtDur(prodT.effectiveMin)}</b>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>wall-clock total</div>
                  <b className="mono" style={{ fontSize: 14 }}>{fmtDur(prodT.wallClockMin)}</b>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>parado (sobre prod)</div>
                  <b className="mono" style={{ fontSize: 14, color: 'var(--warn, #d97706)' }}>{fmtDur(prodT.stoppageMin)}</b>
                </div>
                {Object.entries(prodT.stoppageBySlug).length > 0 && (
                  <div style={{ flex: 1, minWidth: 200, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    {Object.entries(prodT.stoppageBySlug).sort((a, b) => b[1] - a[1]).map(([slug, mins]) => (
                      <span key={slug} style={{
                        fontSize: 10.5, padding: '2px 8px', borderRadius: 999,
                        background: 'var(--surface)', border: '1px solid var(--border)',
                      }}>
                        {HFD.activities && HFD.activities[slug] ? HFD.activities[slug].name : slug}: <b className="mono">{fmtDur(mins)}</b>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 4. SUPORTE breakdown */}
            <ScrollStrip title="Suporte · breakdown" en="Support breakdown">
              {(() => {
                const cards = [
                  { key: 'cleaning_day',  label: 'Limpeza · dia',       val: supB.cleaningDay,    color: '#3b82f6' },
                  { key: 'cleaning_eod',  label: 'Limpeza · fim do dia', val: supB.cleaningEod,    color: '#1e40af' },
                  { key: 'cleaning_tot',  label: 'Limpeza · total',     val: supB.cleaningTotal,  color: '#2563eb' },
                  { key: 'organization',  label: 'Organização',         val: supB.organization,   color: '#0ea5e9' },
                  { key: 'maintenance',   label: 'Manutenção',          val: supB.maintenance,    color: '#d97706' },
                  { key: 'downtime',      label: 'Downtime (máquina)',  val: supB.downtime,       color: '#dc2626' },
                  { key: 'material',      label: 'Recebimento/Entrega', val: supB.materialHandling, color: '#7c5cd6' },
                  { key: 'clinic',        label: 'Clínica · injeções',  val: supB.clinic,         color: '#16a34a' },
                  { key: 'meeting',       label: 'Reuniões',            val: supB.meeting,        color: '#64748b' },
                  { key: 'training',      label: 'Treinamento',         val: supB.training,       color: '#475569' },
                ].filter((c) => c.val > 0);
                if (cards.length === 0) return <EmptyStrip msg="Sem suporte registrado hoje"/>;
                return cards.map((c) => (
                  <div key={c.key} className="strip-item" style={{
                    minWidth: 130, padding: 10, borderRadius: 8,
                    background: 'var(--surface-2)', border: `1px solid var(--border)`, flex: '0 0 auto',
                    borderLeft: `4px solid ${c.color}`,
                  }}>
                    <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{c.label}</div>
                    <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--hf-navy-700)', marginTop: 2 }}>{fmtDur(c.val)}</div>
                  </div>
                ));
              })()}
            </ScrollStrip>

            {/* 5. IDLE ranking — quem ficou mais parado */}
            <ScrollStrip title={`Idle ranking · gaps ≥${GAP_VISIBLE_MIN}min`} en="Most idle">
              {idleR.filter((r) => r.idleMin > 0).length === 0
                ? <EmptyStrip msg="Sem gaps significativos"/>
                : idleR.filter((r) => r.idleMin > 0).map((r, i) => (
                  <div key={r.opId} className="strip-item" style={{
                    minWidth: 160, padding: 10, borderRadius: 8,
                    background: 'var(--surface-2)', border: '1px solid var(--border)', flex: '0 0 auto',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 700 }}>{i + 1}.</span>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: r.opC1 }}/>
                      <b style={{ fontSize: 12.5 }}>{r.opName}</b>
                    </div>
                    <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--warn, #d97706)', marginTop: 4 }}>{fmtDur(r.idleMin)}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{r.gapsCount} gap(s)</div>
                  </div>
                ))}
            </ScrollStrip>

            {/* 6a. TAREFAS ABERTAS (LIVE sem F, exceto end_of_day) */}
            <ScrollStrip title="Tarefas abertas (LIVE sem F)" en="Open tasks">
              {openT.length === 0
                ? <EmptyStrip msg="Tudo fechado ✓"/>
                : openT.map((t) => (
                  <div key={t.opId} className="strip-item" style={{
                    minWidth: 140, padding: 10, borderRadius: 8,
                    background: 'var(--surface-2)', border: '1px solid var(--border)', flex: '0 0 auto',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.opC1 }}/>
                      <b style={{ fontSize: 12.5 }}>{t.opName}</b>
                    </div>
                    <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--warn, #d97706)', marginTop: 4 }}>{t.count}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-3)' }}>aberta(s)</div>
                  </div>
                ))}
            </ScrollStrip>

            {/* 6c+d+f. COWORK / PRODUTOS / ALERTAS — strip resumida */}
            <ScrollStrip title="Métricas do dia" en="Day metrics">
              <MetricCard label="Cowork" value={cowS.total} sub="event(s) colaborativo(s)" color="#7c5cd6"/>
              <MetricCard label="Lotes completados" value={goalsDone} sub={`/ ${goals.length} meta(s)`} color="#22b35d"/>
              <MetricCard label="Alertas" value={allNotifs.length}
                          sub={`${badCount} crítico · ${warnCount} warn · ${infoCount} info`}
                          color={badCount > 0 ? '#dc2626' : warnCount > 0 ? '#d97706' : '#64748b'}/>
              <MetricCard label="Backgrounds ativos"
                          value={state.events.filter((e) => e._is_background && e.ended_min == null).length}
                          sub="rodando agora" color="#0ea5e9"/>
              <MetricCard label="Eventos em andamento"
                          value={state.events.filter((e) => e.ended_min == null).length}
                          sub="LIVE total" color="#16a34a"/>
            </ScrollStrip>
          </div>
        </div>
        );
      })()}

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
              <span style={{ color: 'var(--text-3)', fontSize: 14, fontWeight: 700 }}>⋮⋮</span>
              <Icon name="plus" size={14}/>
              <b style={{ fontSize: 13, flex: 1 }}>
                Preencher gap · {op?.name || '?'} · {fmtClock(gapFill.gap.start)}→{fmtClock(gapFill.gap.end)} ({fmtDur(gapFill.gap.dur)})
              </b>
              <button className="icon-btn" onClick={closeGapFill} style={{ padding: 4 }}><Icon name="x" size={11}/></button>
            </>
          );
        })()}>
        {gapFill && (
          <>
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 }}>
                Tipo de atividade
              </label>
              <select className="input" value={gapFill.form.reasonCat}
                      onChange={(e) => setGapFill((g) => ({ ...g, form: { ...g.form, reasonCat: e.target.value } }))}>
                <option value="almoco">Almoço (lunch)</option>
                <option value="pausa">Pausa curta (break)</option>
                <option value="limpeza">Limpeza (cleaning)</option>
                <option value="transicao">Transição/organização</option>
                <option value="outro">Outro motivo</option>
              </select>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 }}>
                Descrição livre
              </label>
              <textarea className="input" rows={3} value={gapFill.form.note}
                        onChange={(e) => setGapFill((g) => ({ ...g, form: { ...g.form, note: e.target.value } }))}
                        placeholder="ex.: foi limpar a linha 2 depois do encapsulamento"/>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn primary" onClick={saveGapFill}>Criar event no gap</button>
              <button className="btn ghost" onClick={closeGapFill}>Cancelar</button>
              <span style={{ flex: 1 }}/>
              <span style={{ fontSize: 10.5, color: 'var(--text-3)', fontStyle: 'italic', alignSelf: 'center' }}>
                {V4_ALLOW_WRITES ? 'persiste em prod (audit)' : 'preview · V4_ALLOW_WRITES=0'}
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
            <b style={{ fontSize: 13, flex: 1 }}>
              {drill?.which === 'revisao' ? 'Taxa de revisão · por produto' : 'Produção · taxa por lote'}
            </b>
            <button className="icon-btn" onClick={closeDrill} style={{ padding: 4 }}><Icon name="x" size={11}/></button>
          </>
        }>
        {drill?.which === 'producao' && (
          <div>
            {/* Quantidade — topo, destaque */}
            <div style={{ marginBottom: 12 }}>
              <DrillStat label="Quantidade total" value={liveProd.toLocaleString()} unit="garrafas"/>
            </div>

            {/* BLOCO 1 — só a LINHA, por relógio (métrica principal) */}
            <div style={{ borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: 8, marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, color: 'var(--flow-prod)', textTransform: 'uppercase', marginBottom: 6 }}>
                Linha de produção <span style={{ fontWeight: 600, opacity: 0.7, textTransform: 'none' }}>· só a linha, por relógio</span>
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <DrillStat label="Tempo de linha (relógio)" value={lineWall > 0 ? fmtDurSec(lineWall) : '—'} unit="produzindo" color="var(--flow-prod)"/>
                <DrillStat label="Garrafas / min" value={prodPerMin != null ? prodPerMin : '—'} unit="/min" color="var(--flow-prod)"/>
                <DrillStat label="Tempo / garrafa" value={secPerBottle != null ? secPerBottle : '—'} unit="seg" color="var(--flow-prod)"/>
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
              <div style={{ borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: 8, marginBottom: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, color: 'var(--text-2, #4b5563)', textTransform: 'uppercase', marginBottom: 6 }}>
                  Produção total <span style={{ fontWeight: 600, opacity: 0.7, textTransform: 'none' }}>· linha + revisão + labeling…, pessoa-hora</span>
                </div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 6 }}>
                  <DrillStat label="Tempo total (pessoa-hora)" value={fmtDurSec(ft.person_seconds)} unit="todo o fluxo"/>
                  <DrillStat label="Garrafas / min" value={flowPerMin != null ? flowPerMin : '—'} unit="/min"/>
                  <DrillStat label="Tempo / garrafa" value={ft.sec_per_bottle != null ? ft.sec_per_bottle : '—'} unit="seg"/>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(ft.by_phase || []).filter((p) => p.seconds > 0).map((p) => (
                    <span key={p.slug} className="pill" style={{ fontSize: 11, background: 'var(--surface-2, #f3f4f6)', color: 'var(--text-2, #4b5563)' }}>
                      {p.name}: <b>{fmtDurSec(p.seconds)}</b>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
              <b>Linha (relógio)</b> = tempo real em que a linha esteve produzindo (sem contar 2× quando juntos) — é o ritmo de verdade.
              <b> Produção total (pessoa-hora)</b> = soma do tempo de TODOS (linha + revisão + labeling…); maior porque empilha as pessoas e inclui as outras fases.
            </div>
            {(prod.lotes || []).filter((l) => (l.bottles || 0) > 0).length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>
                Sem garrafas contadas hoje. Quando os operadores informarem as bottles, a taxa por lote aparece aqui.
              </div>
            ) : (
              <table className="drill-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-3)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.05 }}>
                    <th style={{ padding: '4px 6px 4px 0' }}>Lote</th>
                    <th style={{ padding: '4px 6px', textAlign: 'right' }}>Garrafas</th>
                    <th style={{ padding: '4px 6px', textAlign: 'right' }}>/min</th>
                    <th style={{ padding: '4px 0 4px 6px', textAlign: 'right' }}>/seg</th>
                  </tr>
                </thead>
                <tbody>
                  {(prod.lotes || []).filter((l) => (l.bottles || 0) > 0)
                    .sort((a, b) => (b.bottles || 0) - (a.bottles || 0)).map((l, i) => (
                    <tr key={i} style={{ borderTop: '1px dashed var(--border)' }}>
                      <td style={{ padding: '5px 6px 5px 0' }}>
                        <b>{l.product}</b>
                        <span className="mono" style={{ color: 'var(--text-3)', marginLeft: 4 }}>{l.batch_number || ''}</span>
                      </td>
                      <td className="mono" style={{ padding: '5px 6px', textAlign: 'right', fontWeight: 700 }}>{l.bottles}</td>
                      <td className="mono" style={{ padding: '5px 6px', textAlign: 'right', color: 'var(--flow-prod)' }}>{l.bottles_per_min != null ? l.bottles_per_min : '—'}</td>
                      <td className="mono" style={{ padding: '5px 0 5px 6px', textAlign: 'right', color: 'var(--flow-prod)' }}>{l.bottles_per_sec != null ? l.bottles_per_sec : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 8, fontStyle: 'italic' }}>
              Taxa = garrafas ÷ tempo efetivo de produção do lote (descontando paradas).
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
    (!rows || rows.length === 0) ? <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '6px 0' }}>—</div> : (
      <table className="drill-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr style={{ textAlign: 'left', color: 'var(--text-3)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.05 }}>
          <th style={{ padding: '4px 6px 4px 0' }}>{firstLabel}</th>
          <th style={{ padding: '4px 6px', textAlign: 'right' }}>n</th>
          <th style={{ padding: '4px 6px', textAlign: 'right' }}>cáps/seg</th>
          <th style={{ padding: '4px 6px', textAlign: 'right' }}>frasco/min</th>
          <th style={{ padding: '4px 0 4px 6px', textAlign: 'right' }}>seg/frasco</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: '1px dashed var(--border)' }}>
              <td style={{ padding: '5px 6px 5px 0' }}><b>{r[firstKey] || '(?)'}</b></td>
              <td className="mono" style={{ padding: '5px 6px', textAlign: 'right', color: 'var(--text-3)' }}>{r.n}</td>
              <td className="mono" style={{ padding: '5px 6px', textAlign: 'right', fontWeight: 700, color: 'var(--flow-prod)' }}>{r.avg_capsules_per_sec != null ? r.avg_capsules_per_sec : '—'}</td>
              <td className="mono" style={{ padding: '5px 6px', textAlign: 'right', color: 'var(--flow-prod)' }}>{r.avg_bottles_per_min != null ? r.avg_bottles_per_min : '—'}</td>
              <td className="mono" style={{ padding: '5px 0 5px 6px', textAlign: 'right' }}>{r.avg_sec_per_bottle != null ? r.avg_sec_per_bottle : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  );

  return (
    <div>
      <div className="filters" style={{ marginBottom: 10 }}>
        {[['today', 'Hoje'], ['7d', '7d'], ['30d', '30d'], ['custom', 'Custom']].map(([id, label]) => (
          <button key={id} className={`filter-chip ${scope === id ? 'on' : ''}`} onClick={() => setScope(id)}>{label}</button>
        ))}
      </div>
      {scope === 'custom' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }}/>
          <span style={{ color: 'var(--text-3)' }}>→</span>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }}/>
        </div>
      )}
      {loading ? <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>Carregando…</div>
        : err ? <div style={{ fontSize: 12, color: 'var(--bad)', padding: '8px 0' }}>Erro: {err.message}</div>
        : (
        <>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10, flexWrap: 'wrap' }}>
            <DrillStat label="Cápsulas/seg" value={d.avg_capsules_per_sec != null ? d.avg_capsules_per_sec : '—'} unit="média" color="var(--flow-prod)"/>
            <DrillStat label="Frascos/min" value={d.avg_bottles_per_min != null ? d.avg_bottles_per_min : '—'} unit="média" color="var(--flow-prod)"/>
            <DrillStat label="Tempo/frasco" value={d.avg_sec_per_bottle != null ? d.avg_sec_per_bottle : '—'} unit="seg médio"/>
            <DrillStat label="Revisões" value={d.n || 0} unit={scope === 'today' ? 'no dia' : (d.scope || '')}/>
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.06, fontWeight: 700, margin: '4px 0' }}>Por pessoa</div>
          <Tbl rows={d.operators} firstLabel="Operador" firstKey="operator"/>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.06, fontWeight: 700, margin: '10px 0 4px' }}>Por produto</div>
          <Tbl rows={d.products} firstLabel="Produto" firstKey="product"/>
        </>
      )}
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 8, fontStyle: 'italic' }}>
        Cápsulas = garrafas × cápsulas-por-frasco do lote; tempo desconta pausas. Card mostra o dia; aqui dá pra ver 30d ou datas custom.
      </div>
    </div>
  );
}

/* FASE 3 — mini-stat do drill-down (taxa em destaque). */
function DrillStat({ label, value, unit, color }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.06, fontWeight: 700 }}>{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: color || 'var(--hf-navy-700)', marginTop: 2 }}>
        {value}{unit && <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500, marginLeft: 4 }}>{unit}</span>}
      </div>
    </div>
  );
}

/* Bloco 28/mai noite — placeholder pra strip sem dados. */
function EmptyStrip({ msg }) {
  return (
    <div className="strip-item" style={{
      minWidth: 200, padding: 12, borderRadius: 8,
      background: 'var(--surface-2)', border: '1px dashed var(--border)', flex: '0 0 auto',
      color: 'var(--text-3)', fontSize: 11, fontStyle: 'italic',
    }}>{msg}</div>
  );
}

/* Bloco 28/mai noite — card genérico pra strip "Métricas do dia". */
function MetricCard({ label, value, sub, color = '#64748b' }) {
  return (
    <div className="strip-item" style={{
      minWidth: 150, padding: 10, borderRadius: 8,
      background: 'var(--surface-2)', border: '1px solid var(--border)', flex: '0 0 auto',
      borderLeft: `4px solid ${color}`,
    }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.06, fontWeight: 700 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--hf-navy-700)', marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/* E6 #8 — barra horizontal scrollável p/ tirinhas de info. */
function ScrollStrip({ title, en, children }) {
  return (
    <div className="card" style={{ padding: 10 }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.08, fontWeight: 700, marginBottom: 6 }}>
        {title}{en && <span style={{ marginLeft: 6, opacity: 0.7, textTransform: 'none', fontWeight: 500 }}>· {en}</span>}
      </div>
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
  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px dashed var(--border)', fontSize: 13 }}>
    <span style={{ color: 'var(--text-2)', fontWeight: 600 }}>{label}</span>
    <b className="mono tabnum">{value}</b>
  </div>
);

function GearButton({ onClick, active }) {
  return (
    <button onClick={onClick}
            className="icon-btn gear-btn"
            style={{
              width: 22, height: 22, fontSize: 14, padding: 0,
              background: active ? 'var(--surface-2)' : 'transparent',
              border: 'none', cursor: 'pointer', color: 'var(--text-3)',
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
          <b style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', flex: 1 }}>{title}</b>
          <button className="icon-btn" onClick={onClose} style={{ padding: 4 }}><Icon name="x" size={11}/></button>
        </>
      }>
      {children}
      <div style={{
        fontSize: 10.5, color: 'var(--text-3)', marginTop: 10, padding: '6px 8px',
        background: 'var(--surface-2)', borderRadius: 6, fontStyle: 'italic',
      }}>
        {V4_ALLOW_WRITES ? 'Edits persistem em prod (auditados via PIN)' : 'V4_ALLOW_WRITES=0 — save toasta preview'}
      </div>
    </FloatingPopover>
  );
}

function EditList({ items, emptyMsg, onAdd, onEdit, onDelete }) {
  return (
    <div>
      {items.length === 0
        ? <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>{emptyMsg}</div>
        : items.map((it) => (
          <div key={it.id} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0',
            borderBottom: '1px dashed var(--border)',
          }}>
            <span style={{ flex: 1, fontSize: 12 }}>{it.label}</span>
            <button className="icon-btn" onClick={() => onEdit(it)} title="Editar" style={{ padding: 4 }}>
              <Icon name="edit" size={12}/>
            </button>
            <button className="icon-btn" onClick={() => onDelete(it)} title="Apagar" style={{ padding: 4 }}>
              <Icon name="trash" size={12}/>
            </button>
          </div>
        ))}
      <button className="btn sm primary" onClick={onAdd} style={{ marginTop: 8, width: '100%' }}>
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
  const INPUT = { width: '100%', padding: '11px 13px', fontSize: 15, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)', color: 'var(--text)', outline: 'none' };
  const ROW = { display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', fontSize: 13.5, border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' };
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
    ack(`Meta criada ✓ — ${sel.product_name}${batch ? ' · ' + batch : ' (sem lote)'} = ${n}`);
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
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(8,15,38,0.5)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 12px', overflowY: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--surface)', borderRadius: 16, boxShadow: 'var(--shadow-lg)', width: 'min(520px, 96vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <Icon name="target" size={16}/>
          <b style={{ flex: 1, fontSize: 14 }}>Editar metas do dia</b>
          <button className="icon-btn" onClick={onClose} style={{ padding: 4 }}><Icon name="x" size={13}/></button>
        </div>
        <div style={{ padding: 16, overflowY: 'auto' }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 8 }}>Adicionar meta</div>
          {!sel ? (
            <>
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar produto…" style={INPUT}/>
              <div style={{ maxHeight: 240, overflowY: 'auto', marginTop: 8, border: '1px solid var(--border)', borderRadius: 10 }}>
                {prodList.length === 0
                  ? <div style={{ padding: 12, fontSize: 12.5, color: 'var(--text-3)' }}>{q ? 'Nenhum produto com esse nome.' : 'Carregando catálogo…'}</div>
                  : prodList.map((p) => (
                    <button key={p.id} onClick={() => { setSel({ product_id: p.id, product_name: p.canonical_name }); setQ(''); }} style={ROW}>
                      {p.canonical_name}
                    </button>
                  ))}
              </div>
            </>
          ) : (
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <b style={{ flex: 1, fontSize: 14 }}>{sel.product_name}</b>
                <button className="btn sm ghost" onClick={() => { setSel(null); setLotText(''); }}>trocar</button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>Lote (opcional — vazio = sem lote):</div>
              {lotsForSel.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {lotsForSel.map((b) => (
                    <button key={b.batch_number} onClick={() => setLotText(b.batch_number)} className="pill" style={{ cursor: 'pointer', border: lotText === b.batch_number ? '1px solid var(--flow-prod)' : '1px solid var(--border)' }}>{b.batch_number}</button>
                  ))}
                  <button onClick={() => setLotText('')} className="pill" style={{ cursor: 'pointer', border: !lotText ? '1px solid var(--flow-prod)' : '1px solid var(--border)' }}>sem lote</button>
                </div>
              )}
              <input value={lotText} onChange={(e) => setLotText(e.target.value)} placeholder="ou digite o lote (ex: BR-2026-0231)" style={INPUT}/>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" placeholder="bottles (ex: 500)" style={{ ...INPUT, flex: 1 }}/>
                <button className="btn primary" disabled={busy} onClick={add}>{busy ? '…' : 'Adicionar'}</button>
              </div>
            </div>
          )}
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-3)', margin: '18px 0 8px' }}>Metas de hoje</div>
          {(goals || []).length === 0
            ? <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Sem metas registradas.</div>
            : (goals || []).map((g) => (
              <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 0', borderBottom: '1px dashed var(--border)' }}>
                <span style={{ flex: 1, fontSize: 13 }}>
                  {g._product_name || g.product || '(?)'}{g.batch ? ' · ' + g.batch : ''}
                  <span style={{ color: 'var(--text-3)' }}> — {g.target} bottles (feito {g.done})</span>
                </span>
                <button className="icon-btn" onClick={() => editQty(g)} title="Editar quantidade" style={{ padding: 4 }}><Icon name="edit" size={12}/></button>
                <button className="icon-btn" onClick={() => del(g)} title="Apagar" style={{ padding: 4 }}><Icon name="trash" size={12}/></button>
              </div>
            ))}
          {!V4_ALLOW_WRITES && <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 10, fontStyle: 'italic' }}>V4_ALLOW_WRITES=0 — preview, não grava.</div>}
        </div>
      </div>
    </div>
  );
}

window.CommandCenter = CommandCenter;

export { CommandCenter };
