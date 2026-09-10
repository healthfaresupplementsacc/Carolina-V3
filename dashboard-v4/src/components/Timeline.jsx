import React from 'react';
import { Icon } from './Icons.jsx';
import { OperatorAvatar } from './Primitives.jsx';
import timelinePause from './timeline-pause.cjs';
import L from './timeline-layout.cjs';

/* Timeline — a linha do tempo do Hoje, redesenhada (Bruno 09-10, estudo
   docs/architecture/study/S03-TIMELINE-REDESIGN-STUDY.md).

   O QUE MUDOU e por quê (o que o Bruno pediu):
   - Uma faixa por pessoa, altura fixa. Máquina/lote acompanhado (encapsulação,
     pesagem, mix, separação, impressão de labels) = ABA fina com nome · lote ·
     duração em cima da faixa. O "SIMULTÂNEO" rosa sumiu: 9 de 11 no dia 09-09
     eram Linha + Labels, isto é, a pessoa cuidando de uma máquina.
   - NOME e TEMPO em todo registro, de relance: a letra encolhe (11.5 → 9.5 px),
     quebra em duas linhas, e se ainda não cabe o rótulo sai do bloco pra uma
     calha acima (timeline-layout.cjs decide).
   - Só 3 cores (fluxo) + neutro hachurado (almoço, pausa, fora do turno).
   - Batida do relógio = limite (faixa cinza antes do check-in e depois do
     check-out; triângulo no topo), não um bloco brigando com as tarefas.
   - Correio saiu daqui (vive no card P&P).
   - Clique no VAZIO = menu curto: Registrar aqui · Finalizou às…? · Ajustar
     horário de … · Estender até o próximo. Clique no BLOCO = barra de ações
     (ajustar, finalizou, mover pra outra pessoa, juntar, dividir, duplicado,
     apagar, lote, detalhes). "+ Novo registro" fica AQUI, no cabeçalho.
   - Lote clicável dentro do bloco → jornada do lote (BatchJourney).

   O QUE FICOU: pausa na mesma faixa (08-20, timeline-pause.cjs); drag pra
   horário com confirmação dupla (pendingDrags); drag entre pessoas bloqueado
   (troca pela barra "Mover para"); ao vivo nunca ganha fim por drag; DAY_END
   estica pra caber saída de noite; "saiu HH:MM" em vez de idle; expansão da
   pessoa (PersonExpansion) intacta. */

function snap(min) { return Math.round(min / 5) * 5; }

class TimelineErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error, info) { console.error('TimelineErrorBoundary capturou um erro:', error, info); }
  render() {
    if (this.state.hasError) {
      return (<div className="tl-error-fallback" style={{ padding: 16, margin: 10, borderRadius: 10, border: '1px solid var(--bad, #dc2626)', background: 'rgba(220,38,38,.06)', color: 'var(--text-2)', fontSize: 13 }}>Algo quebrou nesta linha do tempo. Recarregue a página.</div>);
    }
    return this.props.children;
  }
}

/* medidor de texto (canvas) com as fontes do dashboard */
let _cv = null;
function measure(txt, px, kind) {
  if (!_cv) { try { _cv = document.createElement('canvas').getContext('2d'); } catch (_) { _cv = null; } }
  if (!_cv) return String(txt).length * px * 0.55;
  _cv.font = kind === 'mono' ? `500 ${px}px "JetBrains Mono", ui-monospace, monospace` : `600 ${px}px "Plus Jakarta Sans", system-ui, sans-serif`;
  return _cv.measureText(String(txt)).width;
}
const PUNCH_TIP = { checkin: 'Chegou', checkout: 'Saiu', lunch_out: 'Saiu p/ almoço', lunch_in: 'Voltou do almoço', break_out: 'Pausa', break_in: 'Voltou' };

function TimelineInner({ operators, events, attMarkers, attState, now, hourPx, setHourPx, filterOps, filterFlows,
                    onUpdateEvent, onMergeRequest, onSelectEvent, selectedId,
                    expandedOpIds, onToggleExpand, gaps, onGapClick,
                    pendingDrags, onConfirmDrags, onCancelDrags,
                    fmtClock: fmtClockProp, invalidIds,
                    // redesenho 09-10
                    onQuickCreate,      // ({op, activity, started_min, ended_min, cowork}) => void
                    onQuickPatch,       // (id, {started_min?, ended_min?}) => void  (grava na hora, com confirmação simples)
                    onMoveEvent,        // (id, opId) => void
                    onDeleteEvent,      // (ev) => void
                    onOpenBatch,        // (productKey) => void
                    onOpenFullForm,     // (draft) => void  ("Mais opções…" → painel completo)
                    onDedupe,           // (keepId, removeIds) => void
                    onSplitRequest,     // (id, minute) => void
                    isToday = true,     // dia passado: sem AGORA, sem 'ao vivo', sem 'sem registro há'
}) {
  const { DAY_START, DAY_END: DAY_END_BASE, activities, products } = window.HFData;
  const { fmtClock, fmtCron, fmtDur } = window.HFH;
  const fmt = fmtClockProp || fmtClock;

  const isoToDayMin = (iso) => {
    if (!iso) return null;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
    const h = parseInt((parts.find((p) => p.type === 'hour') || {}).value, 10);
    const m = parseInt((parts.find((p) => p.type === 'minute') || {}).value, 10);
    return h * 60 + m;
  };
  // DAY_END efetivo: estica pra caber saídas de noite (Bruno 07-23) e eventos tardios
  let latest = 0;
  if (attMarkers) for (const k of Object.keys(attMarkers)) for (const mk of (attMarkers[k] || [])) { const mm = isoToDayMin(mk.at); if (mm != null && mm > latest) latest = mm; }
  for (const e of events) { const ee = e.ended_min == null ? Math.floor(now) : e.ended_min; if (ee > latest) latest = ee; }
  const DAY_END = Math.max(DAY_END_BASE, latest > 0 ? Math.ceil((latest + 10) / 60) * 60 : 0);
  const trackW = ((DAY_END - DAY_START) / 60) * hourPx;
  const X = (m) => ((Math.max(DAY_START, Math.min(DAY_END, m)) - DAY_START) / 60) * hourPx;
  const nowMin = Math.floor(now);
  const showNow = isToday && now >= DAY_START && now <= DAY_END;
  const NAME_W = 224;

  // ── UI flutuante local: menu do vazio, mini-forms, barra do bloco, registro rápido ──
  const wrapRef = React.useRef(null);
  const [menu, setMenu] = React.useState(null);   // {op, m, prev, next, x, y}
  const [mini, setMini] = React.useState(null);   // {kind:'adjust'|'finish'|'quick', ...}
  const [bar, setBar] = React.useState(null);     // {ev, op, x, y}
  const [moveOpen, setMoveOpen] = React.useState(false);
  const closeAll = () => { setMenu(null); setMini(null); setBar(null); setMoveOpen(false); };
  React.useEffect(() => {
    const onDoc = (e) => { if (!e.target.closest('.tl-menu, .tl-mini, .tl-abar, .tl-block, .tl-rail, .tl-tick, .tl-pause-inline')) closeAll(); };
    const onKey = (e) => { if (e.key === 'Escape') closeAll(); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);
  const localPos = (clientX, clientY) => {
    const r = wrapRef.current ? wrapRef.current.getBoundingClientRect() : { left: 0, top: 0, width: 1200 };
    return { x: clientX - r.left, y: clientY - r.top, w: r.width };
  };

  // ── Drag (horário) — mesma disciplina de antes: acumula em pendingDrags ──
  const [drag, setDrag] = React.useState(null);
  const dragRef = React.useRef(null); dragRef.current = drag;
  React.useEffect(() => {
    if (!drag) return;
    function onMove(e) {
      const d = dragRef.current; if (!d) return;
      const dx = e.clientX - d.startX; const deltaMin = (dx / hourPx) * 60;
      let newStart = d.origStart, newEnd = d.origEnd;
      if (d.mode === 'body') { const dur = d.origEnd - d.origStart; newStart = snap(Math.max(DAY_START, Math.min(DAY_END - dur, d.origStart + deltaMin))); newEnd = newStart + dur; }
      else if (d.mode === 'left') newStart = snap(Math.max(DAY_START, Math.min(d.origEnd - 5, d.origStart + deltaMin)));
      else if (d.mode === 'right') newEnd = snap(Math.max(d.origStart + 5, Math.min(DAY_END, d.origEnd + deltaMin)));
      let hoveredEventId = null;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el && el.closest) { const blk = el.closest('[data-block-id]'); if (blk && Number(blk.dataset.blockId) !== d.id) hoveredEventId = Number(blk.dataset.blockId); }
      setDrag({ ...d, newStart, newEnd, hoveredEventId, tooltipX: e.clientX + 12, tooltipY: e.clientY + 14, moved: d.moved || Math.abs(dx) > 4 || Math.abs(e.clientY - d.startY) > 4 });
    }
    function onUp(e) {
      const d = dragRef.current; if (!d) { setDrag(null); return; }
      const moved = Math.abs(e.clientX - d.startX) > 4 || Math.abs(e.clientY - d.startY) > 4;
      setDrag(null);
      if (!moved) { d.onClick && d.onClick(e); return; }
      if (d.mode === 'body' && d.hoveredEventId != null) { onMergeRequest && onMergeRequest(d.id, d.hoveredEventId); return; }
      let patch;
      if (d.live) patch = { started_min: d.newStart };
      else if (d.newEnd >= nowMin - 3) patch = { started_min: d.newStart, ended_min: null };
      else patch = { started_min: d.newStart, ended_min: d.newEnd };
      onUpdateEvent && onUpdateEvent(d.id, patch);
    }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp); };
  }, [drag != null]);
  const startDrag = (e, ev, mode, onClick) => {
    e.preventDefault(); e.stopPropagation();
    const endMin = ev.ended_min ?? Math.max(ev.started_min + 5, nowMin);
    setDrag({ id: ev.id, mode, startX: e.clientX, startY: e.clientY, origStart: ev.started_min, origEnd: endMin, newStart: ev.started_min, newEnd: endMin, hoveredEventId: null, tooltipX: e.clientX + 12, tooltipY: e.clientY + 14, live: ev.ended_min == null, onClick });
  };

  // ── ações ──
  const openBar = (clientX, clientY, ev, op) => { const p = localPos(clientX, clientY); setMenu(null); setMini(null); setMoveOpen(false); setBar({ ev, op, x: Math.max(8, Math.min(p.w - 660, p.x - 20)), y: Math.max(44, p.y - 52) }); };
  const openMenu = (clientX, clientY, op, m, real) => {
    const p = localPos(clientX, clientY);
    const prev = real.filter((e) => e.started_min <= m).sort((a, b) => b.started_min - a.started_min)[0] || null;
    const next = real.filter((e) => e.started_min > m).sort((a, b) => a.started_min - b.started_min)[0] || null;
    setBar(null); setMini(null); setMenu({ op, m, prev, next, x: Math.max(8, Math.min(p.w - 270, p.x - 30)), y: Math.max(44, p.y - 10) });
  };
  const openMini = (kind, extra, at) => { const p = at ? localPos(at.x, at.y) : { x: (menu || bar || {}).x || 40, y: (menu || bar || {}).y || 60, w: 1200 }; setMenu(null); setBar(null); setMini({ kind, ...extra, x: Math.max(8, Math.min(p.w - 400, p.x)), y: Math.max(44, p.y) }); };
  const effEndOf = (e) => (e.ended_min == null ? Math.min(nowMin, DAY_END) : e.ended_min);

  const hoursMarks = []; for (let h = DAY_START; h <= DAY_END; h += 60) hoursMarks.push(h);
  const nowX = X(now);
  const byOp = {}; for (const ev of events) (byOp[ev.op] = byOp[ev.op] || []).push(ev);

  return (
    <div className="tl-wrap" ref={wrapRef} style={{ '--name-w': `${NAME_W}px`, '--hour-px': `${hourPx}px` }}>
      <div className="tl-header">
        <h2>Linha do tempo</h2>
        <span className="en">{operators.length} pessoas</span>
        <div className="legend">
          <span className="legend-item"><span className="sw" style={{ '--c': 'var(--flow-prod)', '--t': 'var(--tl-prod-tint)' }}/>Produção</span>
          <span className="legend-item"><span className="sw" style={{ '--c': 'var(--flow-pnp)', '--t': 'var(--tl-pnp-tint)' }}/>P&amp;P</span>
          <span className="legend-item"><span className="sw" style={{ '--c': 'var(--flow-support)', '--t': 'var(--tl-sup-tint)' }}/>Suporte</span>
          <span className="legend-item"><span className="sw rail" style={{ '--c': 'var(--flow-prod)', '--t': 'var(--tl-prod-tint)' }}/>máquina · lote acompanhado</span>
          <span className="legend-item"><span className="sw hatch"/>almoço · pausa · fora do turno</span>
        </div>
        {setHourPx && (
          <div className="tl-seg" role="group" aria-label="Densidade">
            <button className={hourPx < 150 ? 'on' : ''} onClick={() => setHourPx(110)}>Compacto</button>
            <button className={hourPx >= 150 ? 'on' : ''} onClick={() => setHourPx(160)}>Confortável</button>
          </div>
        )}
        {onQuickCreate && (
          <button className="btn sm primary tl-newbtn" data-action="novo-registro"
                  onClick={(e) => { e.stopPropagation(); openMini('quick', { op: null, start: Math.max(DAY_START, snap(nowMin) - 60), end: snap(nowMin), pickPerson: true }, { x: e.clientX, y: e.clientY }); }}>
            <Icon name="plus" size={14}/> Novo registro
          </button>
        )}
      </div>

      {pendingDrags && pendingDrags.length > 0 && (
        <div className="tl-pending-bar">
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--warn, #b45309)' }}>{pendingDrags.length} mudança(s) pendente(s) na linha do tempo</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              {pendingDrags.slice(0, 3).map((pd) => { const ev = events.find((e) => e.id === pd.id); const act = ev && activities[ev.activity]; return (<span key={pd.id} style={{ marginRight: 10 }}>{act ? act.name : 'ev' + pd.id}: <b className="mono">{fmt(pd.origStart)}→{pd.origEnd == null ? 'live' : fmt(pd.origEnd)}</b> → <b className="mono">{fmt(pd.started_min)}→{pd.ended_min == null ? 'live' : fmt(pd.ended_min)}</b></span>); })}
              {pendingDrags.length > 3 && <span> · +{pendingDrags.length - 3} outro(s)</span>}
            </div>
          </div>
          <button className="btn sm primary" onClick={onConfirmDrags} style={{ background: 'var(--warn, #f59e0b)', borderColor: 'var(--warn, #f59e0b)' }}>✓ Aplicar mudanças</button>
          <button className="btn sm ghost" onClick={onCancelDrags}>✕ Cancelar</button>
        </div>
      )}

      <div className="tl-scroller">
        <div className="tl-grid" style={{ width: NAME_W + trackW }}>
          <div className="tl-axis" style={{ width: NAME_W + trackW }}>
            <div className="tl-axis-name"><Icon name="clock" size={13}/>{operators.length} pessoas</div>
            <div className="tl-axis-hours" style={{ width: trackW }}>
              {hoursMarks.map((h) => (<div key={h} className="tl-axis-tick" style={{ left: X(h) }}>{fmt(h).replace(':00 ', ' ')}</div>))}
              {showNow && <div className="tl-now-tag" style={{ left: nowX }}>AGORA · {fmt(now)}</div>}
            </div>
          </div>

          {operators.map((op) => {
            const opEvents = byOp[op.id] || [];
            const opPid = op._person_id != null ? op._person_id : (typeof op.id === 'string' ? parseInt(op.id.replace(/^p/, ''), 10) : op.id);
            const dimmed = filterOps && filterOps.size > 0 && !filterOps.has(op.id);
            // PAUSA NA MESMA FAIXA (08-20): pausa inline vira chip no buraco da tarefa que ela congelou
            const handsAll = opEvents.filter((e) => !L.isRail(e));
            const split = timelinePause.splitByPauses(handsAll, { now, dayEnd: DAY_END });
            const segsByEvent = timelinePause.segmentsByEvent(split);
            const inlinePauseIds = new Set(split.pauses.filter((p) => p.inline).map((p) => p.event_id));
            const lay = L.layoutPerson(opEvents.filter((e) => !inlinePauseIds.has(e.id)), { now, dayEnd: DAY_END });
            const M = L.rowMetrics({ railLanes: lay.railLanes, hourPx });
            const markers = (attMarkers && (attMarkers[opPid] || attMarkers[op.id])) || [];
            const mk = (kind) => markers.filter((m) => m.kind === kind).map((m) => isoToDayMin(m.at)).filter((m) => m != null);
            const cin = mk('checkin')[0], couts = mk('checkout'), cout = couts.length ? couts[couts.length - 1] : null;
            const lo = mk('lunch_out')[0], li = mk('lunch_in')[0];
            const att = attState && (attState[opPid] || attState[op.id]);
            const clockedOut = att && att.state === 'out' && att.checkout_at;
            const checkoutMin = clockedOut ? isoToDayMin(att.checkout_at) : null;
            const last = lay.real.length ? lay.real.slice().sort((a, b) => effEndOf(b) - effEndOf(a))[0] : null;
            const liveEv = lay.real.filter((e) => e.ended_min == null && !L.isNeutral(e))[0] || null;
            const total = lay.real.filter((e) => !L.isNeutral(e)).reduce((a, e) => a + (effEndOf(e) - e.started_min), 0);
            let idleSince = (!liveEv && last && !clockedOut) ? Math.max(0, now - effEndOf(last)) : 0;
            const clockedInIdle = att && att.state === 'in' && !liveEv && att.last_in_at;
            if (clockedInIdle) { const inMin = isoToDayMin(att.last_in_at); idleSince = Math.max(idleSince, inMin != null ? Math.max(0, now - inMin) : 0); }
            const expanded = expandedOpIds && expandedOpIds.has(op.id);
            const personGap = gaps && gaps[op.id];
            const hasLunchEv = lay.neutral.some((e) => e.activity === 'lunch' && lo != null && li != null && e.started_min < li && effEndOf(e) > lo);
            let lastOutRight = -1e9;

            const totalsMeta = <div className="meta" style={{ color: 'var(--text-3)' }}>{lay.real.filter((e) => !L.isNeutral(e)).length} reg. · {L.fmtDurShort(total)}{clockedOut ? ' · saiu ' + fmt(checkoutMin) : ''}</div>;
            const status = !isToday
              ? totalsMeta
              : clockedOut
              ? <div className="meta" style={{ color: 'var(--text-3)' }}>saiu {fmt(checkoutMin)}</div>
              : liveEv
                ? <div className="meta" style={{ color: 'var(--hf-leaf-600)' }}>● {L.shortName(liveEv.activity, activities[liveEv.activity]?.name)} · {fmtCron(now - liveEv.started_min)}</div>
                : (clockedInIdle && !last && idleSince > 10)
                  ? <div className="meta" style={{ color: 'var(--bad)' }}>bateu o ponto e não iniciou tarefa · {fmtDur(idleSince)}</div>
                  : idleSince > 30
                    ? <div className="meta" style={{ color: 'var(--warn)' }}>sem registro há {fmtDur(idleSince)}</div>
                    : <div className="meta" style={{ color: 'var(--text-3)' }}>{lay.real.filter((e) => !L.isNeutral(e)).length} reg. · {L.fmtDurShort(total)}</div>;

            const renderBlock = (e, c, laneCount, laneIdx) => {
              const act = activities[e.activity]; if (!act) return null;
              const flow = L.RAIL_SLUGS.has(e.activity) && act.flow !== 'pnp' ? 'production' : (act.flow || 'support');
              const neutral = L.isNeutral(e);
              const isLiveEv = e.ended_min == null;
              const isDragging = drag && drag.id === e.id;
              const start = isDragging ? drag.newStart : e.started_min;
              const end = isDragging ? drag.newEnd : effEndOf(e);
              const pieces = (isDragging || !segsByEvent[e.id]) ? [{ start, end, index: 0, total: 1, is_first: true, is_last: true, is_continuation: false, zero_width: false }] : segsByEvent[e.id].filter((s) => !s.zero_width);
              if (!pieces.length) return null;
              const h = laneCount > 1 ? (M.LANE_H - 2) / laneCount : M.LANE_H;
              const top = M.laneTop + (laneCount > 1 ? laneIdx * (h + 2) : 0);
              const productName = e.product ? products[e.product]?.name : null;
              const durTxt = isLiveEv ? (isToday ? '● ' + L.fmtDurShort(now - e.started_min) : 'sem fim') : L.fmtDurShort(end - start);
              const isSelected = selectedId === e.id || (bar && bar.ev.id === e.id);
              const isMergeTarget = drag && drag.hoveredEventId === e.id;
              const isInvalid = invalidIds && invalidIds.has(e.id);
              const flowDimmed = filterFlows && filterFlows.size > 0 && !filterFlows.has(flow);
              const totalW = X(end) - X(start);
              const tip = `${act.name}${productName ? ' · ' + productName : ''}\n${fmt(start)} → ${isLiveEv ? 'agora' : fmt(end)} · ${L.fmtDurShort(end - start)}` + (e.cowork && e.cowork.length ? '\ncom ' + e.cowork.map((cw) => (operators.find((o) => o.id === cw) || {}).name).filter(Boolean).join(', ') : '') + (e.dupes ? `\n${e.dupes} registros iguais no mesmo horário` : '') + '\nclique: corrigir · arraste: horário';
              const out = [];
              pieces.forEach((seg) => {
                const left = X(seg.start); const w = Math.max(6, X(seg.end) - X(seg.start));
                const head = seg.is_first;
                const fitW = (head ? totalW : w) - 12;
                const fitRes = neutral ? null : L.fitLabel({ name: act.name, short: L.shortName(e.activity, act.name), w: fitW, h, durTxt, prodName: productName, measure });
                if (!neutral && head && fitRes && !fitRes.inside) {
                  // rótulo fora, na calha acima: nome curto + tempo; empurra se colide com o anterior
                  const ow = measure(fitRes.name, 10, 'sans') + measure(durTxt, 10, 'mono') + 12;
                  let ol = left; if (ol < lastOutRight + 4) ol = lastOutRight + 4; lastOutRight = ol + ow;
                  out.push(<div key={`ol-${e.id}`} className="tl-olbl" style={{ left: ol, top: M.gutterTop, '--c': `var(--flow-${flow === 'production' ? 'prod' : flow})` }}>{fitRes.name}<small>{durTxt}</small></div>);
                }
                out.push(
                  <div key={`${e.id}-s${seg.index}`} data-block-id={e.id} data-seg-index={seg.index}
                       className={`tl-block flow-${flow} ${neutral ? 'neutral' : ''} ${isLiveEv && seg.is_last ? 'live' : ''} ${isDragging ? 'dragging' : ''} ${isSelected ? 'selected' : ''} ${isMergeTarget ? 'merge-target' : ''} ${flowDimmed ? 'dim' : ''} ${isInvalid ? 'tl-block-invalid' : ''} ${seg.is_continuation ? 'tl-block-cont' : ''} ${e.overrun && head ? 'overrun' : ''}`}
                       style={{ left, width: w, top, height: h }}
                       onPointerDown={(ev) => startDrag(ev, e, 'body', (up) => openBar(up.clientX, up.clientY, e, op))}
                       title={tip}>
                    {!isLiveEv && !seg.is_continuation && <div className="tl-handle left" onPointerDown={(ev) => startDrag(ev, e, 'left')}/>}
                    {!isLiveEv && seg.is_last && <div className="tl-handle right" onPointerDown={(ev) => startDrag(ev, e, 'right')}/>}
                    {neutral
                      ? <div className="l1" style={{ fontSize: 10.5 }}>{w >= 64 ? `${L.shortName(e.activity, act.name)} ${durTxt}` : (w >= 30 ? durTxt : '')}</div>
                      : (head && fitRes.inside ? (
                        <>
                          <div className={`l1 ${fitRes.wrap ? 'wrap' : ''}`} style={{ fontSize: fitRes.px }}>{fitRes.name}</div>
                          {fitRes.line2 && (
                            <div className="l2">
                              {fitRes.prod && productName && (<><u onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); onOpenBatch && onOpenBatch(e.product); }} title={`Jornada do lote ${products[e.product]?.batch || ''}`}>{productName}</u> · </>)}
                              {durTxt}
                            </div>
                          )}
                        </>
                      ) : (seg.is_continuation ? <div className="l1 cont" style={{ fontSize: 10.5 }}>{seg.is_last ? durTxt : ''}</div> : null))}
                    {e.cowork && e.cowork.length > 0 && head && !neutral && <span className="cwd" title={'com ' + e.cowork.map((cw) => (operators.find((o) => o.id === cw) || {}).short).join(', ')}/>}
                    {e.dupes && head && <span className="dup">×{e.dupes}</span>}
                    {e.overrun && head && <span className="bk-overrun" title="passou do esperado">⏰</span>}
                  </div>
                );
              });
              return out;
            };

            return (
              <React.Fragment key={op.id}>
              <div className={`tl-row ${dimmed ? 'dim' : ''} ${expanded ? 'expanded' : ''}`} style={{ height: M.rowH, '--lane-top': `${M.laneTop}px`, '--lane-h': `${M.LANE_H}px` }}>
                <div className="tl-name tl-name-clickable" onClick={() => onToggleExpand && onToggleExpand(op.id)} title={expanded ? 'Recolher detalhes' : 'Expandir detalhes'}>
                  <OperatorAvatar op={op}/>
                  <div className="tl-name-info">
                    <div className="nm">{op.name}<span className="tl-expand-caret" style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-3)', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block', transition: 'transform 0.18s ease' }}>▶</span></div>
                    {status}
                  </div>
                </div>
                <div className="tl-track" style={{ width: trackW }}
                     onClick={(ev) => { if (ev.target !== ev.currentTarget && !ev.target.classList.contains('tl-gap-zone') && !ev.target.classList.contains('tl-off') && !ev.target.classList.contains('halfhour')) return; const rect = ev.currentTarget.getBoundingClientRect(); const m = snap((ev.clientX - rect.left) / hourPx * 60 + DAY_START); openMenu(ev.clientX, ev.clientY, op, m, lay.real); }}>
                  {hoursMarks.slice(0, -1).map((h) => (<div key={h} className="halfhour" style={{ left: X(h + 30) }}/>))}
                  {/* fora do turno */}
                  {cin != null && <div className="tl-off" style={{ left: 0, width: X(cin) }}/>}
                  {cout != null && <div className="tl-off" style={{ left: X(cout), width: Math.max(0, trackW - X(cout)) }}/>}
                  {/* batidas = triângulos no topo, texto no hover */}
                  {markers.map((m, mi) => { const min = isoToDayMin(m.at); if (min == null) return null; const bad = m.type === 'unjustified' || m.incomplete; return (<div key={'mk' + mi} className={`tl-punch ${m.kind === 'checkin' || m.kind === 'lunch_in' || m.kind === 'break_in' ? 'in' : ''} ${bad ? 'bad' : ''}`} style={{ left: X(min) }} data-tip={`${PUNCH_TIP[m.kind] || m.label} ${fmt(min)}${m.incomplete ? ' · sem volta registrada' : ''}`}/>); })}
                  {lo != null && li != null && !hasLunchEv && <div className="tl-band" style={{ left: X(lo), width: Math.max(4, X(li) - X(lo)) }}>almoço {L.fmtDurShort(li - lo)}</div>}
                  {showNow && <div className="tl-now" style={{ left: nowX }}/>}

                  {/* ABAS: máquina / lote acompanhado */}
                  {lay.rails.map((e) => {
                    const act = activities[e.activity]; if (!act) return null;
                    const flow = act.flow === 'pnp' ? 'pnp' : 'production';
                    const isLiveEv = e.ended_min == null; const end = effEndOf(e);
                    const w = Math.max(8, X(end) - X(e.started_min));
                    const productName = e.product ? products[e.product]?.name : null;
                    const durTxt = L.fmtDurShort(end - e.started_min) + (e.dupes ? ' ×' + e.dupes : '');
                    const nxt = lay.rails.filter((o) => o._lane === e._lane && o.started_min >= end && o !== e).sort((a, b) => a.started_min - b.started_min)[0];
                    const room = (nxt ? X(nxt.started_min) : trackW) - (X(e.started_min) + w);
                    const lbl = L.railLabel({ name: act.name, short: L.shortName(e.activity, act.name), w, durTxt, prodName: productName, room, measure });
                    const top = M.railsTop + e._lane * (M.RAIL_H + M.RAIL_GAP);
                    const tip = `${act.name}${productName ? ' · ' + productName + ' (' + (products[e.product]?.batch || '') + ')' : ''}\n${fmt(e.started_min)} → ${isLiveEv ? 'agora' : fmt(end)} · ${L.fmtDurShort(end - e.started_min)}${e.dupes ? `\n${e.dupes} registros iguais (juntar?)` : ''}\nclique: corrigir · lote`;
                    return (
                      <React.Fragment key={'rail-' + e.id}>
                        <div className={`tl-rail flow-${flow} ${isLiveEv ? 'live' : ''} ${bar && bar.ev.id === e.id ? 'selected' : ''}`} data-block-id={e.id}
                             style={{ left: X(e.started_min), width: w, top, height: M.RAIL_H }} title={tip}
                             onPointerDown={(ev) => startDrag(ev, e, 'body', (up) => openBar(up.clientX, up.clientY, e, op))}>
                          {(lbl.mode === 'full' || lbl.mode === 'short_dur' || lbl.mode === 'short') && <b>{lbl.name}</b>}
                          {(lbl.mode === 'full' || lbl.mode === 'short_dur') && <span className="mono">{lbl.extra}</span>}
                        </div>
                        {lbl.mode === 'outside' && <div className={`tl-rlbl flow-${flow}`} style={{ left: X(e.started_min) + w + 4, top, height: M.RAIL_H }}>{lbl.name}</div>}
                      </React.Fragment>
                    );
                  })}

                  {/* TAREFAS DE MÃO: clusters → lanes só dentro do cluster */}
                  {lay.clusters.map((c) => c.items.map((e) => renderBlock(e, c, c.count, c.laneOf[e.id] || 0)))}
                  {lay.neutral.map((e) => renderBlock(e, null, 1, 0))}

                  {/* CHIP DA PAUSA dentro da faixa (08-20) */}
                  {split.pauses.filter((p) => p.inline).map((p) => {
                    const pauseEv = handsAll.find((e) => e.id === p.event_id);
                    const left = X(p.start); const width = Math.max(16, X(p.end) - X(p.start)); const mins = Math.max(0, Math.round(p.end - p.start));
                    const noteShort = p.note && p.note.length > 26 ? p.note.slice(0, 26) + '…' : (p.note || '');
                    return (
                      <div key={`pause-${p.event_id}`} data-pause-id={p.event_id} data-block-id={p.event_id}
                           className={`tl-pause-inline ${p.live ? 'live' : ''} ${selectedId === p.event_id ? 'selected' : ''}`}
                           style={{ left, width, top: M.laneTop, height: M.LANE_H }}
                           onPointerDown={(e) => { if (pauseEv) startDrag(e, pauseEv, 'body', (up) => openBar(up.clientX, up.clientY, pauseEv, op)); }}
                           title={`PAUSA · ${fmt(p.start)} → ${p.live ? 'agora' : fmt(p.end)} (${L.fmtDurShort(mins)})${p.note ? '\n' + p.note : ''}\nA tarefa continua depois.`}>
                        <span className="tl-pause-ico" aria-hidden="true">⏸</span>
                        {width >= 60 && <span className="tl-pause-txt"><b>Pausa</b>{noteShort && <span className="tl-pause-note"> {noteShort}</span>}</span>}
                        {width >= 40 && <span className="tl-pause-dur mono">{p.live ? '…' : L.fmtDurShort(mins)}</span>}
                      </div>
                    );
                  })}

                  {/* TIQUES: registros de < 2 min (reinício no kiosk) */}
                  {lay.ticks.map((e) => { const act = activities[e.activity]; const flow = act ? (act.flow || 'support') : 'support'; return (<div key={'tk-' + e.id} data-block-id={e.id} className={`tl-tick flow-${flow}`} style={{ left: X(e.started_min), top: M.laneTop + 8, height: M.LANE_H - 16 }} title={`${act ? act.name : e.activity} · ${fmt(e.started_min)} · registro de ${Math.max(0, effEndOf(e) - e.started_min)} min (provável reinício no kiosk)\nclique: apagar ou juntar`} onPointerDown={(ev) => { ev.stopPropagation(); openBar(ev.clientX, ev.clientY, e, op); }}/>); })}

                  {/* BURACOS entre tarefas de mão (≥ 15 min, fora do almoço do relógio) */}
                  {lay.gaps.filter((z) => !(lo != null && li != null && lo <= z.start + 2 && li >= z.end - 2) && !split.pauses.some((p) => p.start <= z.start + 1 && p.end >= z.end - 1)).map((z) => (
                    <button key={'gz-' + z.start} className={`tl-gap-zone ${z.dur >= 45 ? 'long' : ''}`} style={{ left: X(z.start), width: Math.max(20, X(z.end) - X(z.start)), top: M.laneTop, height: M.LANE_H }}
                            onClick={(ev) => { ev.stopPropagation(); openMenu(ev.clientX, ev.clientY, op, z.start, lay.real); }}
                            title={`Sem registro ${fmt(z.start)} → ${fmt(z.end)} (${L.fmtDurShort(z.dur)}) · clique`}>
                      {z.dur >= 30 && <span className="tl-gap-zone-label">{L.fmtDurShort(z.dur)} sem registro</span>}
                    </button>
                  ))}

                  {onQuickCreate && (
                    <button className="tl-rowplus" title="Esqueci de marcar: começa onde o último registro acabou"
                            onClick={(ev) => { ev.stopPropagation(); const s0 = last ? effEndOf(last) : (cin != null ? cin : DAY_START); openMini('quick', { op, start: s0, end: nowMin > s0 ? snap(nowMin) : null }, { x: ev.clientX, y: ev.clientY }); }}>+</button>
                  )}
                </div>
              </div>
              {expanded && (
                <TimelineErrorBoundary>
                  <PersonExpansion op={op} events={opEvents} now={now} gap={personGap} fmtClock={fmt} fmtDur={fmtDur} fmtCron={fmtCron} activities={activities} onSelectEvent={onSelectEvent} onGapClick={onGapClick}/>
                </TimelineErrorBoundary>
              )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* ── MENU CURTO do vazio ── */}
      {menu && (() => {
        const { op, m, prev, next } = menu;
        const pn = (e) => L.shortName(e.activity, activities[e.activity]?.name);
        const prevOpen = prev && prev.ended_min == null;
        const prevEnd = prev ? effEndOf(prev) : null;
        const Item = ({ ic, txt, sub, onClick, danger }) => (<button className={`tl-mi ${danger ? 'danger' : ''}`} onClick={(e) => { e.stopPropagation(); onClick(e); }}><span className="ic">{ic}</span><span>{txt}{sub && <small>{sub}</small>}</span></button>);
        return (
          <div className="tl-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="mh">{fmt(m)} · {op.name.split(' ')[0]}</div>
            <Item ic="+" txt="Registrar aqui" sub={`início ${fmt(m)}${next ? ' · fim ' + fmt(next.started_min) : (m < nowMin ? ' · fim agora' : '')}`} onClick={(e) => openMini('quick', { op, start: m, end: next ? next.started_min : (m < nowMin ? snap(nowMin) : null) }, { x: e.clientX, y: e.clientY })}/>
            {prev && prevOpen && <Item ic="✓" txt={`Finalizou ${pn(prev)} às ${fmt(m)}?`} sub={`aberto desde ${fmt(prev.started_min)}`} onClick={(e) => openMini('finish', { op, ev: prev, at: m }, { x: e.clientX, y: e.clientY })}/>}
            {prev && !prevOpen && prevEnd > m && <Item ic="✓" txt={`Terminou às ${fmt(m)}, não ${fmt(prev.ended_min)}?`} sub={`${pn(prev)} · encurta o registro`} onClick={(e) => openMini('finish', { op, ev: prev, at: m }, { x: e.clientX, y: e.clientY })}/>}
            {prev && <Item ic="⏱" txt={`Ajustar horário de ${pn(prev)}`} sub={`${fmt(prev.started_min)} → ${prevOpen ? 'agora' : fmt(prev.ended_min)}`} onClick={(e) => openMini('adjust', { op, ev: prev }, { x: e.clientX, y: e.clientY })}/>}
            {prev && next && !prevOpen && !L.isNeutral(prev) && next.started_min - prevEnd >= 15 && <Item ic="⇥" txt={`Estender ${pn(prev)} até ${fmt(next.started_min)}`} sub={`preenche ${L.fmtDurShort(next.started_min - prevEnd)} sem registro`} onClick={() => { closeAll(); onQuickPatch && onQuickPatch(prev.id, { ended_min: next.started_min }); }}/>}
          </div>
        );
      })()}

      {/* ── MINI-FORMS: ajustar (2 campos) · finalizou (1 confirmação) · registrar rápido ── */}
      {mini && mini.kind === 'adjust' && <AdjustForm mini={mini} fmt={fmt} activities={activities} onClose={closeAll} onSave={(s, e) => { closeAll(); onQuickPatch && onQuickPatch(mini.ev.id, { started_min: s, ended_min: e }); }}/>}
      {mini && mini.kind === 'finish' && <FinishForm mini={mini} fmt={fmt} activities={activities} onClose={closeAll} onSave={(e) => { closeAll(); onQuickPatch && onQuickPatch(mini.ev.id, { ended_min: e }); }}/>}
      {mini && mini.kind === 'quick' && <QuickAdd mini={mini} fmt={fmt} operators={operators} activities={activities} events={events} nowMin={nowMin} DAY_END_BASE={DAY_END_BASE} onClose={closeAll}
                                                  onSave={(d) => { closeAll(); onQuickCreate && onQuickCreate(d); }} onMore={(d) => { closeAll(); onOpenFullForm && onOpenFullForm(d); }}/>}

      {/* ── BARRA DE AÇÕES do bloco ── */}
      {bar && (() => {
        const { ev, op } = bar; const act = activities[ev.activity];
        const end = effEndOf(ev);
        const B = ({ txt, onClick, danger }) => (<button className={danger ? 'danger' : ''} onClick={(e) => { e.stopPropagation(); onClick(e); }}>{txt}</button>);
        return (
          <div className="tl-abar" style={{ left: bar.x, top: bar.y }} onMouseDown={(e) => e.stopPropagation()}>
            <span className="t">{act ? L.shortName(ev.activity, act.name) : ev.activity} · {fmt(ev.started_min)}→{ev.ended_min == null ? 'agora' : fmt(ev.ended_min)} · {L.fmtDurShort(end - ev.started_min)}</span>
            <B txt="Ajustar horário" onClick={(e) => openMini('adjust', { op, ev }, { x: e.clientX, y: e.clientY })}/>
            {ev.ended_min == null && <B txt="Finalizou às…" onClick={(e) => openMini('finish', { op, ev, at: snap(nowMin) }, { x: e.clientX, y: e.clientY })}/>}
            {onMoveEvent && <B txt={moveOpen ? 'Mover para ▴' : 'Mover para ▾'} onClick={() => setMoveOpen((v) => !v)}/>}
            {onMergeRequest && <B txt="Juntar ←" onClick={() => { const prevE = events.filter((x) => x.op === op.id && x.id !== ev.id && x.started_min <= ev.started_min).sort((a, b) => b.started_min - a.started_min)[0]; closeAll(); if (prevE) onMergeRequest(prevE.id, ev.id); }}/>}
            {onSplitRequest && ev.ended_min != null && <B txt="Dividir" onClick={() => { closeAll(); onSplitRequest(ev.id, snap((ev.started_min + end) / 2)); }}/>}
            {ev.dupes && onDedupe && <B txt={`Duplicado ×${ev.dupes}: manter 1`} onClick={() => { closeAll(); onDedupe(ev.dupe_ids[0], ev.dupe_ids.slice(1)); }}/>}
            {onDeleteEvent && <B txt="Apagar" danger onClick={() => { closeAll(); onDeleteEvent(ev); }}/>}
            {ev.product && onOpenBatch && <B txt={`Lote ${products[ev.product]?.name || ''} ›`} onClick={() => { closeAll(); onOpenBatch(ev.product); }}/>}
            <B txt="Detalhes…" onClick={(e) => { closeAll(); onSelectEvent && onSelectEvent(ev.id, { x: e.clientX, y: e.clientY }); }}/>
            {moveOpen && (
              <div className="tl-abar sub">
                {operators.filter((o) => o.id !== op.id).map((o) => (<button key={o.id} onClick={(e) => { e.stopPropagation(); closeAll(); onMoveEvent(ev.id, o.id); }}>{o.name}</button>))}
              </div>
            )}
          </div>
        );
      })()}

      {drag && drag.moved && (
        <div className="drag-tooltip" style={{ left: drag.tooltipX, top: drag.tooltipY }}>
          {drag.mode === 'left' ? `início → ${fmt(drag.newStart)}` : drag.mode === 'right' ? `fim → ${fmt(drag.newEnd)}` : drag.hoveredEventId ? 'solte para juntar' : `${fmt(drag.newStart)} → ${fmt(drag.newEnd)}`}
        </div>
      )}
    </div>
  );
}

/* ── mini-forms ─────────────────────────────────────────────── */
const minToInput = (m) => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const inputToMin = (s) => { if (!s) return null; const [h, m] = s.split(':').map(Number); return h * 60 + m; };

function AdjustForm({ mini, fmt, activities, onClose, onSave }) {
  const { ev, op } = mini; const act = activities[ev.activity];
  const [s, setS] = React.useState(ev.started_min); const [e, setE] = React.useState(ev.ended_min);
  const ref = React.useRef(null); React.useEffect(() => { ref.current && ref.current.focus(); }, []);
  const bad = e != null && e <= s;
  return (
    <div className="tl-mini" style={{ left: mini.x, top: mini.y }} onMouseDown={(x) => x.stopPropagation()}>
      <h3>Ajustar horário · {act ? act.name : ev.activity}</h3>
      <div className="hint">{op.name}{ev.product && window.HFData.products[ev.product] ? ' · ' + window.HFData.products[ev.product].name : ''}</div>
      <div className="times">
        <div><label>Início</label><input ref={ref} type="time" value={minToInput(s)} onChange={(x) => setS(inputToMin(x.target.value) ?? s)}/></div>
        <div><label>Fim</label><div className="inl"><input type="time" value={minToInput(e)} placeholder="em andamento" onChange={(x) => setE(x.target.value ? inputToMin(x.target.value) : null)}/>{e != null && <button className="link" onClick={() => setE(null)} title="Volta a 'em andamento'">em andamento</button>}</div></div>
      </div>
      {bad && <div className="warn">O fim tem que ser depois do início.</div>}
      <div className="foot"><button className="btn sm primary" disabled={bad} onClick={() => onSave(s, e)}>Salvar</button><span style={{ flex: 1 }}/><button className="link" onClick={onClose}>Cancelar</button></div>
    </div>
  );
}
function FinishForm({ mini, fmt, activities, onClose, onSave }) {
  const { ev, op } = mini; const act = activities[ev.activity];
  const [e, setE] = React.useState(mini.at);
  return (
    <div className="tl-mini" style={{ left: mini.x, top: mini.y }} onMouseDown={(x) => x.stopPropagation()}>
      <h3>Marcar fim de {act ? act.name : ev.activity}</h3>
      <div className="hint">{op.name} · começou {fmt(ev.started_min)}{ev.ended_min == null ? ' · ainda aberto' : ' · hoje termina ' + fmt(ev.ended_min)}</div>
      <div className="times">
        <div><label>Terminou às</label><input type="time" value={minToInput(e)} onChange={(x) => setE(inputToMin(x.target.value) ?? e)}/></div>
        <div><label>Duração</label><div className="mono" style={{ padding: '7px 0', fontSize: 13 }}>{e > ev.started_min ? L.fmtDurShort(e - ev.started_min) : '—'}</div></div>
      </div>
      <div className="foot"><button className="btn sm primary" disabled={!(e > ev.started_min)} onClick={() => onSave(e)}>Sim, terminou às {fmt(e)}</button><span style={{ flex: 1 }}/><button className="link" onClick={onClose}>Cancelar</button></div>
    </div>
  );
}
/* Registrar rápido: o que · quando · com quem (como o kiosk). "Mais opções" leva pro painel completo. */
function QuickAdd({ mini, fmt, operators, activities, events, nowMin, DAY_END_BASE, onClose, onSave, onMore }) {
  const [op, setOp] = React.useState(mini.op || null);
  const [slug, setSlug] = React.useState(null);
  const [s, setS] = React.useState(mini.start); const [e, setE] = React.useState(mini.end == null ? null : mini.end);
  const [cw, setCw] = React.useState([]);
  const FLOWS = [['production', 'Produção'], ['pnp', 'P&P'], ['support', 'Suporte']];
  const recent = op ? [...new Set(events.filter((x) => x.op === op.id).sort((a, b) => b.started_min - a.started_min).map((x) => x.activity))].slice(0, 3) : [];
  const catalog = Object.entries(activities).filter(([k, a]) => a && a._id != null && k !== 'unknown');
  const ActBtn = ({ k, a }) => (<button className={`tl-act flow-${a.flow || 'support'} ${slug === k ? 'on' : ''}`} title={a.name} onClick={() => setSlug(k)}>{a.name}</button>);
  return (
    <div className="tl-mini wide" style={{ left: mini.x, top: mini.y }} onMouseDown={(x) => x.stopPropagation()}>
      <h3>{op ? `Registrar pra ${op.name.split(' ')[0]}` : 'Registrar pra quem?'}</h3>
      <div className="hint">{op ? 'O que, quando, com quem. O resto fica em "mais opções".' : 'Só as pessoas de hoje. Quem não está na lista entra em Pessoas.'}</div>
      {!op ? (
        <div className="chips">
          {operators.map((o) => (<button key={o.id} className="chip" onClick={() => setOp(o)}>{o.name}</button>))}
          <a className="chip ghost" href="#pessoas" onClick={onClose}>+ outra pessoa…</a>
        </div>
      ) : (
        <>
          <div className="lbl">O que</div>
          <div className="tl-acts">
            {recent.length > 0 && <><div className="grp">recentes de {op.name.split(' ')[0]}</div>{recent.map((k) => activities[k] && <ActBtn key={k} k={k} a={activities[k]}/>)}</>}
            {FLOWS.map(([f, label]) => (<React.Fragment key={f}><div className="grp">{label}</div>{catalog.filter(([k, a]) => (a.flow || 'support') === f && !recent.includes(k)).map(([k, a]) => <ActBtn key={k} k={k} a={a}/>)}</React.Fragment>))}
          </div>
          <div className="lbl">Quando</div>
          <div className="times">
            <div><label>Início</label><input type="time" value={minToInput(s)} onChange={(x) => setS(inputToMin(x.target.value) ?? s)}/></div>
            <div><label>Fim</label><div className="inl"><input type="time" value={minToInput(e)} placeholder="em andamento" onChange={(x) => setE(x.target.value ? inputToMin(x.target.value) : null)}/><button className="link" onClick={() => setE(e == null ? Math.min(snap(nowMin), DAY_END_BASE + 600) : null)}>{e == null ? 'até agora' : 'em andamento'}</button></div></div>
          </div>
          <div className="lbl">Quem estava junto</div>
          <div className="chips">{operators.filter((o) => o.id !== op.id).map((o) => (<button key={o.id} className={`chip ${cw.includes(o.id) ? 'on' : ''}`} onClick={() => setCw(cw.includes(o.id) ? cw.filter((x) => x !== o.id) : [...cw, o.id])}>{o.name.split(' ')[0]}</button>))}</div>
        </>
      )}
      <div className="foot">
        {op && <button className="btn sm primary" disabled={!slug || (e != null && e <= s)} onClick={() => onSave({ op, activity: slug, started_min: s, ended_min: e, cowork: cw })}>Registrar</button>}
        {op && <button className="btn sm ghost" onClick={() => onMore({ op, activity: slug, started_min: s, ended_min: e, cowork: cw })}>Mais opções…</button>}
        <span style={{ flex: 1 }}/><button className="link" onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}

/* E7 #5 — bloco de detalhes inline que abre embaixo da lane quando o nome do operador é clicado. Read-only. */
function PersonExpansion({ op, events, now, gap, fmtClock, fmtDur, fmtCron, activities, onSelectEvent, onGapClick }) {
  const sorted = events.slice().sort((a, b) => a.started_min - b.started_min);
  const items = [];
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i]; items.push({ kind: 'event', ev });
    const next = sorted[i + 1];
    if (next) { const evEnd = ev.ended_min == null ? now : ev.ended_min; const gapMin = next.started_min - evEnd; if (gapMin > 1) items.push({ kind: 'gap', start: evEnd, end: next.started_min, dur: gapMin }); }
  }
  return (
    <div className="tl-row-expansion">
      <div className="tl-expansion-name">
        <div className="exp-title">Detalhes · {op.name}</div>
        {gap && gap.idle_seconds + gap.unreported_seconds > 0 && (
          <div className="exp-gaps">
            {gap.idle_seconds > 0 && <span className="tag">idle: {fmtDur(Math.round(gap.idle_seconds / 60))}</span>}
            {gap.unreported_seconds > 0 && <span className="tag tag-warn">não reportado: {fmtDur(Math.round(gap.unreported_seconds / 60))}</span>}
          </div>
        )}
      </div>
      <div className="tl-expansion-list">
        {items.length === 0 ? <div className="exp-empty">sem eventos hoje</div> : items.map((it, i) => it.kind === 'event' ? (() => {
          const ev = it.ev; const productsMap = window.HFData.products || {}; const prod = ev.product ? productsMap[ev.product] : null; const note = (ev.description || ev._phase_label || '').trim();
          return (
            <button key={'ev-' + ev.id} className="exp-row exp-row-event" onClick={(e) => onSelectEvent && onSelectEvent(ev.id, { x: e.clientX, y: e.clientY })} title="Abrir painel do evento" style={note ? { gridTemplateColumns: '130px 1fr 70px', alignItems: 'start' } : undefined}>
              <span className="exp-time mono">{fmtClock(ev.started_min)} → {ev.ended_min == null ? 'agora' : fmtClock(ev.ended_min)}</span>
              <span className={`exp-act flow-${activities[ev.activity]?.flow || 'support'}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>{activities[ev.activity]?.name || ev.activity}{prod && <span style={{ color: 'var(--text-2)', fontWeight: 500 }}> · {prod.name}</span>}{prod && prod.batch && <span className="mono" style={{ color: 'var(--text-3)', fontSize: 10.5, marginLeft: 4 }}>{prod.batch}</span>}{L.isRail(ev) && <span className="exp-bg-pill"> · máquina</span>}</span>
                {note && <span style={{ fontSize: 10.5, color: 'var(--text-3)', fontStyle: 'italic', fontWeight: 400 }}>📝 {note.length > 90 ? note.slice(0, 90) + '…' : note}</span>}
              </span>
              <span className="exp-dur mono">{ev.ended_min == null ? fmtCron(now - ev.started_min) : fmtDur(ev.ended_min - ev.started_min)}</span>
            </button>
          );
        })() : (
          <div key={'gap-' + i} className="exp-row exp-row-gap" style={{ position: 'relative' }}>
            <button className="exp-row-gap-main exp-row-clickable" onClick={(e) => onGapClick && onGapClick(op.id, it, { x: e.clientX, y: e.clientY })} title="Clique pra preencher o que aconteceu nesse intervalo" style={{ display: 'contents', cursor: 'pointer', background: 'transparent', border: 'none', padding: 0, font: 'inherit', textAlign: 'left' }}>
              <span className="exp-time mono">{fmtClock(it.start)} → {fmtClock(it.end)}</span>
              <span className="exp-act muted">+ preencher gap</span>
              <span className="exp-dur mono muted">{fmtDur(it.dur)}</span>
            </button>
            <CopyGapButton start={it.start} end={it.end} dur={it.dur} fmtClock={fmtClock} fmtDur={fmtDur} personName={op.name}/>
          </div>
        ))}
      </div>
    </div>
  );
}

function CopyGapButton({ start, end, dur, fmtClock, fmtDur }) {
  const [copied, setCopied] = React.useState(false);
  const text = `${fmtClock(start)} → ${fmtClock(end)} (${fmtDur(dur)}) — o que aconteceu?`;
  const onCopy = (e) => {
    e.stopPropagation();
    try { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }, () => setCopied(false)); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch {} document.body.removeChild(ta); }
  };
  return (<button className="gap-copy-btn" onClick={onCopy} title={copied ? 'Copiado!' : `Copiar "${text}" pro clipboard`} aria-label="Copiar texto do gap">{copied ? '✓' : '⎘'}</button>);
}

function Timeline(props) {
  return (<TimelineErrorBoundary><TimelineInner {...props} /></TimelineErrorBoundary>);
}
window.Timeline = Timeline;
export { Timeline };
