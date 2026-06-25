import React from 'react';
import { Icon } from './Icons.jsx';
import { OperatorAvatar } from './Primitives.jsx';

/* Timeline component — the centerpiece.
   Features:
   - Sticky operator name column
   - Hour axis with sticky top
   - Event blocks positioned by minute
   - Live "now" vertical line, ticks every second
   - Drag: body (horizontal move + cross-row reassign + drop-onto-block to merge)
   - Drag: left/right edge resize
   - Click → opens side panel
   - Filter dimming (operator id set + flow set)
*/

const HOUR_PX_DEFAULT = 140; // px per hour on desktop

function snap(min) { return Math.round(min / 5) * 5; } // 5-min snap during drag

function Timeline({ operators, events, now, hourPx, setHourPx, filterOps, filterFlows,
                    onUpdateEvent, onMergeRequest, onSelectEvent, selectedId,
                    expandedOpIds, onToggleExpand,
                    gaps,
                    correio,            // { minutes, label }  — E7-refine2 #2
                    onCorreioClick,     // (coords) => void
                    onGapClick,         // (op_id, gap, coords) — E7-refine2 #3
                    pendingDrags,       // E6 #7: array de drags pendentes
                    onConfirmDrags,     // E6 #7: () => void  (faz dupla confirmação interna)
                    onCancelDrags,      // E6 #7: () => void
                    fmtClock: fmtClockProp,
                    invalidIds,         // Bug #1 bloco 29/mai: Set<eventId> com duração ruim
}) {
  const { DAY_START, DAY_END, DEADLINE_MIN, activities, FLOWS } = window.HFData;
  const { fmtClock, fmtCron, fmtDur } = window.HFH;
  const dayMin = DAY_END - DAY_START;
  const trackW = (dayMin / 60) * hourPx;

  // Drag state
  const [drag, setDrag] = React.useState(null);
  // drag = { id, mode: 'body'|'left'|'right', startX, startY, origStart, origEnd, origOpIdx,
  //          newStart, newEnd, newOpIdx, hoveredEventId, tooltipX, tooltipY }

  const dragRef = React.useRef(null);
  dragRef.current = drag;

  React.useEffect(() => {
    if (!drag) return;
    function onMove(e) {
      const d = dragRef.current; if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const deltaMin = (dx / hourPx) * 60;

      let newStart = d.origStart, newEnd = d.origEnd, newOpIdx = d.origOpIdx;

      if (d.mode === "body") {
        const dur = d.origEnd - d.origStart;
        newStart = snap(Math.max(DAY_START, Math.min(DAY_END - dur, d.origStart + deltaMin)));
        newEnd = newStart + dur;
        // vertical row change: cada row tem ~96px (E7 #1, antes 72)
        const rowH = 96;
        const rowShift = Math.round(dy / rowH);
        newOpIdx = Math.max(0, Math.min(operators.length - 1, d.origOpIdx + rowShift));
      } else if (d.mode === "left") {
        newStart = snap(Math.max(DAY_START, Math.min(d.origEnd - 5, d.origStart + deltaMin)));
      } else if (d.mode === "right") {
        // for closed events; live events should not be resizable on right
        newEnd = snap(Math.max(d.origStart + 5, Math.min(DAY_END, d.origEnd + deltaMin)));
      }

      // hover-detect for merge: element under pointer
      let hoveredEventId = null;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el && el.closest) {
        const blk = el.closest("[data-block-id]");
        if (blk && Number(blk.dataset.blockId) !== d.id) {
          hoveredEventId = Number(blk.dataset.blockId);
        }
      }

      setDrag({ ...d, newStart, newEnd, newOpIdx, hoveredEventId, tooltipX: e.clientX + 12, tooltipY: e.clientY + 14 });
    }
    function onUp(e) {
      const d = dragRef.current; if (!d) { setDrag(null); return; }
      // Did mouse move at all? if no, treat as click (open panel)
      const moved = Math.abs(e.clientX - d.startX) > 4 || Math.abs(e.clientY - d.startY) > 4;
      if (!moved) {
        // treat as click; open panel (passa coords pro painel flutuante posicionar perto)
        onSelectEvent && onSelectEvent(d.id, { x: e.clientX, y: e.clientY });
        setDrag(null);
        return;
      }

      // Merge?
      if (d.mode === "body" && d.hoveredEventId != null) {
        onMergeRequest && onMergeRequest(d.id, d.hoveredEventId);
        setDrag(null);
        return;
      }
      // E5 — drag vertical (trocar pessoa) está BLOQUEADO. Se o drag mudou
      // de lane SEM ser merge, cancela com aviso. Admin troca pessoa via
      // drawer (painel flutuante), não por gesto. Horário e resize ficam OK.
      const newOpIdx = d.newOpIdx ?? d.origOpIdx;
      if (newOpIdx !== d.origOpIdx && d.mode === 'body') {
        // Tava arrastando pra outra lane — cancela
        if (typeof window !== 'undefined' && window.HFV4_ack) {
          window.HFV4_ack('Trocar pessoa: use o painel de edição (clique no bloco). Drag entre lanes desativado.');
        }
        setDrag(null);
        return;
      }
      // OK: aplica horário/resize na mesma lane (mantém op). Regra do "agora":
      //  • AO VIVO → arrastar só desloca o início; nunca grava fim (não fecha).
      //  • FECHADO arrastado até "agora" (ou além) → está acontecendo agora →
      //    reabre AO VIVO (ended_min=null). Uma tarefa não pode terminar no futuro.
      //  • senão → aplica o novo fim normalmente.
      // (bug do Vitor: arrastar pra ajustar gap gravava fim="agora" e fechava a
      //  Linha de Produção que ainda estava rolando.)
      const nowMin = Math.floor(now);
      let patch;
      if (d.live) patch = { started_min: d.newStart };
      else if (d.newEnd >= nowMin - 3) patch = { started_min: d.newStart, ended_min: null };
      else patch = { started_min: d.newStart, ended_min: d.newEnd };
      onUpdateEvent && onUpdateEvent(d.id, patch);
      setDrag(null);
    }
    // POINTER events (Bruno 06-23): funcionam pra MOUSE e TOUCH — antes era só
    // mouse, então no iPhone/iPad não dava pra arrastar (mover/estender início/fim).
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag != null]);

  const startDrag = (e, ev, opIdx, mode) => {
    e.preventDefault(); e.stopPropagation();
    const endMin = ev.ended_min ?? Math.max(ev.started_min + 5, Math.floor(now));
    setDrag({
      id: ev.id, mode,
      startX: e.clientX, startY: e.clientY,
      origStart: ev.started_min, origEnd: endMin, origOpIdx: opIdx,
      newStart: ev.started_min, newEnd: endMin, newOpIdx: opIdx,
      hoveredEventId: null,
      tooltipX: e.clientX + 12, tooltipY: e.clientY + 14,
      live: ev.ended_min == null,
    });
  };

  // Hour ticks
  const hoursMarks = [];
  for (let h = DAY_START; h <= DAY_END; h += 60) {
    hoursMarks.push(h);
  }

  const nowX = ((Math.max(DAY_START, Math.min(DAY_END, now)) - DAY_START) / 60) * hourPx;
  // E7 bugfix: Correio (deadline) saiu da Timeline. Linha vertical removida —
  // o Correio agora vive APENAS dentro do card P&P (checkbox + horário).
  // deadlineX e o render da .tl-deadline foram retirados.

  const NAME_W = 220;

  // Build per-op events
  const byOp = {};
  for (const ev of events) {
    (byOp[ev.op] = byOp[ev.op] || []).push(ev);
  }

  const dragHoveredRowIdx = drag && drag.mode === "body" ? drag.newOpIdx : null;

  return (
    <div className="tl-wrap"
         style={{ "--name-w": `${NAME_W}px`, "--hour-px": `${hourPx}px` }}>
      <div className="tl-header">
        <h2>Linha do Tempo Operacional</h2>
        <span className="en">· Operator Timeline</span>
        <div className="legend">
          <span className="legend-item"><span className="swatch" style={{ background: "var(--flow-prod)" }}/>Produção · Production</span>
          <span className="legend-item"><span className="swatch" style={{ background: "var(--flow-pnp)" }}/>P&P · Pick & Pack</span>
          <span className="legend-item"><span className="swatch" style={{ background: "var(--flow-support)" }}/>Suporte · Support</span>
          <span className="legend-item"><Icon name="link" size={11}/>cowork</span>
          <span className="legend-item"><Icon name="live" size={11}/>live</span>
        </div>
        {/* FASE 4 — zoom in/out do eixo de tempo */}
        {setHourPx && (
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 4, marginRight: 8 }}>
            <button className="btn sm ghost" title="Menos zoom"
                    onClick={() => setHourPx((p) => Math.max(70, Math.round(p / 1.4)))}
                    style={{ minWidth: 28, padding: "2px 8px", fontWeight: 800 }}>−</button>
            <span style={{ fontSize: 10.5, color: "var(--text-3)", minWidth: 24, textAlign: "center" }} title="zoom">🔍</span>
            <button className="btn sm ghost" title="Mais zoom"
                    onClick={() => setHourPx((p) => Math.min(360, Math.round(p * 1.4)))}
                    style={{ minWidth: 28, padding: "2px 8px", fontWeight: 800 }}>+</button>
          </div>
        )}
        <div style={{ flex: "0 0 auto", fontSize: 11.5, color: "var(--text-3)" }}>
          arraste para mover · resize nas bordas · solte em cima para juntar
        </div>
      </div>

      {/* E6 #7 — banner de confirmação dupla pra drags pendentes. */}
      {pendingDrags && pendingDrags.length > 0 && (
        <div className="tl-pending-bar" style={{
          margin: '0 10px 8px', padding: '10px 14px', borderRadius: 10,
          background: 'linear-gradient(90deg, rgba(245, 158, 11, 0.12), rgba(245, 158, 11, 0.04))',
          border: '1px solid var(--warn, #f59e0b)',
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--warn, #b45309)' }}>
              {pendingDrags.length} mudança(s) pendente(s) na linha do tempo
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              {pendingDrags.slice(0, 3).map((pd) => {
                const ev = events.find((e) => e.id === pd.id);
                const act = ev && ev.activity && window.HFData.activities[ev.activity];
                const fmt = fmtClockProp || fmtClock;
                const fromRange = `${fmt(pd.origStart)}→${pd.origEnd == null ? 'live' : fmt(pd.origEnd)}`;
                const toRange   = `${fmt(pd.started_min)}→${pd.ended_min == null ? 'live' : fmt(pd.ended_min)}`;
                return (
                  <span key={pd.id} style={{ marginRight: 10 }}>
                    ev{pd.id} {act ? `(${act.name})` : ''}: <b className="mono">{fromRange}</b> → <b className="mono">{toRange}</b>
                  </span>
                );
              })}
              {pendingDrags.length > 3 && <span> · +{pendingDrags.length - 3} outro(s)</span>}
            </div>
          </div>
          <button className="btn sm primary" onClick={onConfirmDrags}
                  style={{ background: 'var(--warn, #f59e0b)', borderColor: 'var(--warn, #f59e0b)' }}>
            ✓ Aplicar mudanças
          </button>
          <button className="btn sm ghost" onClick={onCancelDrags}>
            ✕ Cancelar
          </button>
        </div>
      )}

      <div className="tl-scroller">
        <div className="tl-grid" style={{ width: NAME_W + trackW }}>
          {/* Axis */}
          <div className="tl-axis" style={{ width: NAME_W + trackW }}>
            <div className="tl-axis-name">
              <Icon name="clock" size={13}/>
              {operators.length} operadores
            </div>
            <div className="tl-axis-hours" style={{ width: trackW }}>
              {hoursMarks.map(h => {
                const x = ((h - DAY_START) / 60) * hourPx;
                return (
                  <div key={h} className="tl-axis-tick" style={{ left: x }}>
                    {fmtClock(h).replace(":00 ", " ")}
                  </div>
                );
              })}
              {now >= DAY_START && now <= DAY_END && (
                <div className="tl-now" style={{ left: nowX, top: 4, height: 28 }}>
                  <div style={{ position: "absolute", top: -2, left: 10, fontSize: 10.5, color: "var(--hf-leaf-700)", fontWeight: 700, whiteSpace: "nowrap" }}>
                    AGORA · {fmtClock(now)}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Correio row — tab attached na barra do tempo (E7-refine2 #2).
              Mesma estética das bg tabs (mini-pill com flow accent). Atrelado ao
              x do horário do deadline (1PM real do v3.deadlines). Click abre o
              detalhe igual notificação. */}
          {correio && correio.minutes != null && correio.minutes >= DAY_START && correio.minutes <= DAY_END && (
            <div className="tl-correio-row">
              <div className="tl-correio-name">
                <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600 }}>Notif.</span>
              </div>
              <div className="tl-correio-track" style={{ width: trackW }}>
                <button className="tl-correio-tab"
                        style={{ left: ((correio.minutes - DAY_START) / 60) * hourPx }}
                        onClick={(e) => onCorreioClick && onCorreioClick({ x: e.clientX, y: e.clientY })}
                        title={`Correio · ${fmtClock(correio.minutes)} · clique para editar`}>
                  <span className="tl-correio-icon">📮</span>
                  <span className="tl-correio-label">{correio.label || 'Correio'} · {fmtClock(correio.minutes)}</span>
                </button>
              </div>
            </div>
          )}

          {/* Rows */}
          {operators.map((op, opIdx) => {
            const opEvents = byOp[op.id] || [];
            const dimmed = filterOps && filterOps.size > 0 && !filterOps.has(op.id);
            const isDropActive = dragHoveredRowIdx === opIdx && drag && drag.mode === "body";
            // Separa foreground vs background (E7 #2)
            const fgEvents = opEvents.filter((e) => !e._is_background);
            const bgEvents = opEvents.filter((e) => e._is_background);
            // FASE 4 — SUB-LANES: tasks que se SOBREPÕEM no tempo vão pra linhas
            // diferentes (mesma row do operador), em vez de empilhar e ficar
            // impossível de ver/clicar. Algoritmo guloso de partição de intervalos.
            const effEnd = (e) => (e.ended_min == null ? Math.min(now, DAY_END) : e.ended_min);
            const assignLanes = (list) => {
              const sorted = list.slice().filter((e) => e.started_min != null)
                .sort((a, b) => a.started_min - b.started_min || effEnd(a) - effEnd(b));
              const laneEnds = []; const laneOf = {};
              for (const e of sorted) {
                let lane = laneEnds.findIndex((le) => le <= e.started_min);
                if (lane === -1) { lane = laneEnds.length; laneEnds.push(effEnd(e)); }
                else laneEnds[lane] = effEnd(e);
                laneOf[e.id] = lane;
              }
              return { laneOf, count: Math.max(1, laneEnds.length) };
            };
            const BG_H = 20, BG_GAP = 3, FG_H = 54, FG_GAP = 6, TOP_PAD = 6;
            const bgLanes = assignLanes(bgEvents);
            const bgCount = bgEvents.length ? bgLanes.count : 0;
            const fgLanes = assignLanes(fgEvents);
            // SIMULTÂNEO (Bruno 06-24): tarefas de FOREGROUND do mesmo operador que se
            // SOBREPÕEM no tempo = "trabalhando em N ao mesmo tempo" → ficam ROSA + label.
            const fgSimul = {};
            {
              // EXCLUI pausa/almoço/fim-de-dia (Bruno 06-24): pausa NÃO é "trabalho
              // simultâneo" — antes a Pausa e a tarefa congelada por baixo dela
              // apareciam rosas. Só conta tarefa de trabalho real sobreposta.
              const NOT_WORK = new Set(['break', 'lunch', 'pausa', 'end_of_day']);
              const fl = fgEvents.filter((e) => e.started_min != null && !NOT_WORK.has(e.activity));
              for (const e of fl) {
                const es = e.started_min, ee = effEnd(e); let n = 0;
                for (const o of fl) { if (o.started_min < ee && effEnd(o) > es) n += 1; }
                if (n >= 2) fgSimul[e.id] = n;
              }
            }
            const fgTop0 = TOP_PAD + bgCount * (BG_H + BG_GAP) + (bgCount ? 4 : 0);
            const rowMinH = Math.max(96, fgTop0 + fgLanes.count * (FG_H + FG_GAP) + TOP_PAD);
            // Compute idle / sem registro (só sobre foreground)
            const last = fgEvents.length ? fgEvents[fgEvents.length - 1] : null;
            const isLive = last && last.ended_min == null;
            const idleSince = !isLive && last ? Math.max(0, now - last.ended_min) : 0;
            const expanded = expandedOpIds && expandedOpIds.has(op.id);
            const personGap = gaps && gaps[op.id];

            return (
              <React.Fragment key={op.id}>
              <div className={`tl-row ${dimmed ? "dim" : ""} ${isDropActive ? "drop-active" : ""} ${expanded ? "expanded" : ""}`}
                   style={{ minHeight: rowMinH }}>
                <div className="tl-name tl-name-clickable"
                     onClick={() => onToggleExpand && onToggleExpand(op.id)}
                     title={expanded ? "Recolher detalhes" : "Expandir detalhes"}>
                  <OperatorAvatar op={op}/>
                  <div className="tl-name-info">
                    <div className="nm">
                      {op.name}
                      <span className="tl-expand-caret" style={{
                        marginLeft: 6, fontSize: 10, color: "var(--text-3)",
                        transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                        display: 'inline-block', transition: 'transform 0.18s ease',
                      }}>▶</span>
                    </div>
                    <div className="ro">{op.role}</div>
                    {isLive
                      ? <div className="meta" style={{ color: "var(--hf-leaf-600)" }}>● ao vivo · {fmtCron((now - last.started_min))}</div>
                      : idleSince > 30
                        ? <div className="meta">⏱ idle {fmtDur(idleSince)}</div>
                        : <div className="meta" style={{ color: "var(--text-3)" }}>{opEvents.length} eventos</div>}
                  </div>
                </div>
                <div className="tl-track" style={{ width: trackW }}>
                  {/* half-hour subdivisions */}
                  {hoursMarks.slice(0, -1).map(h => (
                    <div key={h} className="halfhour" style={{ left: ((h - DAY_START + 30) / 60) * hourPx }}/>
                  ))}
                  {/* (E7 bugfix) Linha de Correio removida da timeline.
                       Correio vive só no card P&P. */}
                  {/* Now line */}
                  {now >= DAY_START && now <= DAY_END && <div className="tl-now" style={{ left: nowX }}/>}

                  {/* Background tabs (E7 #2) — mini-pills no topo da lane com nome
                      da tarefa de fundo. Se um evento background cobrir [s,e], a
                      tab fica posicionada exatamente sobre essas coordenadas. */}
                  {bgEvents.map((ev) => {
                    const act = activities[ev.activity];
                    if (!act) return null;
                    const isLiveBg = ev.ended_min == null;
                    const endMin = isLiveBg ? Math.min(now, DAY_END) : ev.ended_min;
                    const start = ev.started_min;
                    const left = ((start - DAY_START) / 60) * hourPx;
                    const width = Math.max(40, ((endMin - start) / 60) * hourPx);
                    const flow = act.flow;
                    const bgTop = TOP_PAD + (bgLanes.laneOf[ev.id] || 0) * (BG_H + BG_GAP); // FASE 4 — empilha bg sem sobrepor
                    const productName = ev.product ? window.HFData.products[ev.product]?.name : null;
                    return (
                      <div key={`bg-${ev.id}`}
                           className={`tl-bg-tab flow-${flow} ${isLiveBg ? 'live' : ''} ${selectedId === ev.id ? 'selected' : ''}`}
                           style={{ left, width, top: bgTop, height: BG_H }}
                           onPointerDown={(e) => { e.stopPropagation(); startDrag(e, ev, opIdx, "body"); }}
                           title={`background · ${act.name}${productName ? ' · ' + productName : ''}`}>
                        <span className="bg-tab-dot"/>
                        <span className="bg-tab-label">{act.name}</span>
                        {isLiveBg && <span className="bg-tab-live" title="rodando">●</span>}
                      </div>
                    );
                  })}

                  {/* Foreground event blocks */}
                  {fgEvents.map(ev => {
                    const act = activities[ev.activity];
                    if (!act) return null;
                    const flow = act.flow;
                    const flowColor = `var(--flow-${flow})`;
                    const flowColor2 = `var(--flow-${flow}-2)`;
                    const isLiveEv = ev.ended_min == null;
                    const endMin = isLiveEv ? Math.min(now, DAY_END) : ev.ended_min;

                    // Use draft values if currently dragging this event
                    const isDragging = drag && drag.id === ev.id;
                    const start = isDragging ? drag.newStart : ev.started_min;
                    const end = isDragging ? drag.newEnd : endMin;
                    const dragRowMismatch = isDragging && drag.mode === "body" && drag.newOpIdx !== opIdx;
                    if (dragRowMismatch) return null;

                    const left = ((start - DAY_START) / 60) * hourPx;
                    const width = Math.max(28, ((end - start) / 60) * hourPx);
                    const fgLane = fgLanes.laneOf[ev.id] || 0; // FASE 4 — sub-lane (sobreposição)
                    const blockTop = fgTop0 + fgLane * (FG_H + FG_GAP);
                    const isSelected = selectedId === ev.id;
                    const isMergeTarget = drag && drag.hoveredEventId === ev.id;
                    const isInvalid = invalidIds && invalidIds.has(ev.id);
                    const productName = ev.product ? window.HFData.products[ev.product]?.name : null;
                    const flowDimmed = filterFlows && filterFlows.size > 0 && !filterFlows.has(flow);

                    return (
                      <div key={ev.id}
                           data-block-id={ev.id}
                           className={`tl-block ${isLiveEv ? "live" : ""} ${ev.overrun ? "overrun" : ""} ${isDragging ? "dragging" : ""} ${isSelected ? "selected" : ""} ${isMergeTarget ? "merge-target" : ""} ${flowDimmed ? "dim" : ""} ${isInvalid ? "tl-block-invalid" : ""}`}
                           style={{
                             left, width, top: blockTop, height: FG_H, bottom: 'auto',
                             "--bk-color": fgSimul[ev.id] ? "#db2777" : flowColor,
                             "--bk-color2": fgSimul[ev.id] ? "#f472b6" : flowColor2,
                           }}
                           onPointerDown={e => startDrag(e, ev, opIdx, "body")}
                           title={fgSimul[ev.id] ? `TRABALHANDO SIMULTANEAMENTE EM ${fgSimul[ev.id]} TASKS — ${act.name}${productName ? ` · ${productName}` : ""}` : `${act.name}${productName ? ` · ${productName}` : ""}`}>
                        {!isLiveEv && (
                          <>
                            <div className="tl-handle left" onPointerDown={e => startDrag(e, ev, opIdx, "left")}/>
                            <div className="tl-handle right" onPointerDown={e => startDrag(e, ev, opIdx, "right")}/>
                          </>
                        )}
                        {ev.overrun && <span className="bk-overrun">⏰</span>}
                        {ev.cowork && ev.cowork.length > 0 && (
                          <div className="bk-cow">
                            {ev.cowork.slice(0, 3).map(cw => {
                              const o = operators.find(x => x.id === cw);
                              return o ? <span key={cw} className="chip">{o.short}</span> : null;
                            })}
                          </div>
                        )}
                        <div className="bk-fn" style={{ paddingLeft: ev.overrun ? 22 : 0, paddingRight: ev.cowork && ev.cowork.length ? 38 : 0 }}>
                          {act.name}
                        </div>
                        {fgSimul[ev.id] && (
                          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.2, color: "#fff", background: "rgba(0,0,0,0.22)", borderRadius: 5, padding: "1px 5px", marginTop: 2, display: "inline-block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}
                               title={`TRABALHANDO SIMULTANEAMENTE EM ${fgSimul[ev.id]} TASKS`}>
                            ⚡ SIMULTÂNEO ×{fgSimul[ev.id]}
                          </div>
                        )}
                        {productName && <div className="bk-pr">{productName}</div>}
                        <div className="bk-time">
                          {isLiveEv
                            ? `⏱ ${fmtCron(now - ev.started_min)}`
                            : fmtDur(end - start)}
                        </div>
                      </div>
                    );
                  })}

                  {/* Gap zones — entre fg events consecutivos com gap >= 15min.
                      Click abre o detalhe (mesmo onGapClick que o expand usa).
                      Bot 27/mai #2: gap visível também na timeline principal,
                      não só no expand. */}
                  {(() => {
                    if (!onGapClick) return null;
                    const sorted = fgEvents.slice()
                      .filter((e) => e.started_min != null)
                      .sort((a, b) => a.started_min - b.started_min);
                    const zones = [];
                    for (let i = 0; i < sorted.length - 1; i++) {
                      const evEnd = sorted[i].ended_min == null ? now : sorted[i].ended_min;
                      const gap = sorted[i + 1].started_min - evEnd;
                      if (gap < 15) continue;   // ignora micro-gaps
                      zones.push({ start: evEnd, end: sorted[i + 1].started_min, dur: gap, key: 'gz-' + i });
                    }
                    return zones.map((z) => {
                      const left = ((z.start - DAY_START) / 60) * hourPx;
                      const width = Math.max(20, ((z.end - z.start) / 60) * hourPx);
                      return (
                        <button key={z.key} className="tl-gap-zone"
                                style={{ left, width }}
                                onClick={(e) => { e.stopPropagation(); onGapClick(op.id, z, { x: e.clientX, y: e.clientY }); }}
                                title={`Gap ${fmtClock(z.start)} → ${fmtClock(z.end)} (${fmtDur(z.dur)}) — clique pra preencher`}>
                          <span className="tl-gap-zone-label">{fmtDur(z.dur)}</span>
                        </button>
                      );
                    });
                  })()}

                  {/* Render the dragged event in the destination row if cross-row */}
                  {drag && drag.mode === "body" && drag.newOpIdx === opIdx && drag.origOpIdx !== opIdx && (() => {
                    const ev = events.find(e => e.id === drag.id);
                    if (!ev) return null;
                    const act = activities[ev.activity];
                    if (!act) return null;
                    const flow = act.flow;
                    const left = ((drag.newStart - DAY_START) / 60) * hourPx;
                    const width = Math.max(28, ((drag.newEnd - drag.newStart) / 60) * hourPx);
                    return (
                      <div className="tl-block dragging" style={{
                        left, width, "--bk-color": `var(--flow-${flow})`, "--bk-color2": `var(--flow-${flow}-2)`,
                      }}>
                        <div className="bk-fn">{act.name} → {operators[drag.newOpIdx].name}</div>
                        <div className="bk-time">{fmtDur(drag.newEnd - drag.newStart)}</div>
                      </div>
                    );
                  })()}
                </div>
              </div>
              {expanded && (
                <PersonExpansion op={op} events={opEvents} now={now} gap={personGap}
                                 fmtClock={fmtClock} fmtDur={fmtDur} fmtCron={fmtCron}
                                 activities={activities}
                                 onSelectEvent={onSelectEvent}
                                 onGapClick={onGapClick}/>
              )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {drag && (
        <div className="drag-tooltip" style={{ left: drag.tooltipX, top: drag.tooltipY }}>
          {drag.mode === "left"  ? `início → ${fmtClock(drag.newStart)}` :
           drag.mode === "right" ? `fim → ${fmtClock(drag.newEnd)}` :
           drag.hoveredEventId ? `solte para juntar` :
           drag.newOpIdx !== drag.origOpIdx
             ? `→ ${operators[drag.newOpIdx]?.name} · ${fmtClock(drag.newStart)}`
             : `${fmtClock(drag.newStart)} → ${fmtClock(drag.newEnd)}`}
        </div>
      )}
    </div>
  );
}

/* E7 #5 — bloco de detalhes inline que abre embaixo da lane quando o
   nome do operador é clicado. Lista todos os eventos do dia daquela
   pessoa, com hora/duração + gaps entre eventos calculados client-side.
   Read-only. */
function PersonExpansion({ op, events, now, gap, fmtClock, fmtDur, fmtCron, activities, onSelectEvent, onGapClick }) {
  // ordena por started_min crescente
  const sorted = events.slice().sort((a, b) => a.started_min - b.started_min);
  // intercala gaps entre eventos consecutivos
  const items = [];
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    items.push({ kind: 'event', ev });
    const next = sorted[i + 1];
    if (next) {
      const evEnd = ev.ended_min == null ? now : ev.ended_min;
      const gapMin = next.started_min - evEnd;
      if (gapMin > 1) items.push({ kind: 'gap', start: evEnd, end: next.started_min, dur: gapMin });
    }
  }

  return (
    <div className="tl-row-expansion">
      <div className="tl-expansion-name">
        <div className="exp-title">Detalhes · {op.name}</div>
        {gap && gap.idle_seconds + gap.unreported_seconds > 0 && (
          <div className="exp-gaps">
            {gap.idle_seconds > 0   && <span className="tag">idle: {fmtDur(Math.round(gap.idle_seconds / 60))}</span>}
            {gap.unreported_seconds > 0 && <span className="tag tag-warn">não reportado: {fmtDur(Math.round(gap.unreported_seconds / 60))}</span>}
          </div>
        )}
      </div>
      <div className="tl-expansion-list">
        {items.length === 0
          ? <div className="exp-empty">sem eventos hoje</div>
          : items.map((it, i) => it.kind === 'event' ? (
            // E7-resto Leva 1: mostra produto + batch ao lado da atividade,
            // e se a pessoa deixou nota (description) renderiza embaixo.
            // Ex: "Linha de Produção · Graviola · 0150" + "label deu problema 4x".
            (() => {
              const ev = it.ev;
              const products = window.HFData.products || {};
              const prod = ev.product ? products[ev.product] : null;
              const note = (ev.description || ev._phase_label || '').trim();
              return (
                <button key={'ev-' + ev.id} className="exp-row exp-row-event"
                        onClick={(e) => onSelectEvent && onSelectEvent(ev.id, { x: e.clientX, y: e.clientY })}
                        title="Abrir painel do evento"
                        style={note ? { gridTemplateColumns: '130px 1fr 70px', alignItems: 'start' } : undefined}>
                  <span className="exp-time mono">{fmtClock(ev.started_min)} → {ev.ended_min == null ? 'agora' : fmtClock(ev.ended_min)}</span>
                  <span className={`exp-act flow-${activities[ev.activity]?.flow || 'support'}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span>
                      {activities[ev.activity]?.name || ev.activity}
                      {prod && <span style={{ color: 'var(--text-2)', fontWeight: 500 }}> · {prod.name}</span>}
                      {prod && prod.batch && <span className="mono" style={{ color: 'var(--text-3)', fontSize: 10.5, marginLeft: 4 }}>{prod.batch}</span>}
                      {ev._is_background && <span className="exp-bg-pill"> · background</span>}
                    </span>
                    {note && (
                      <span style={{ fontSize: 10.5, color: 'var(--text-3)', fontStyle: 'italic', fontWeight: 400 }}>
                        📝 {note.length > 90 ? note.slice(0, 90) + '…' : note}
                      </span>
                    )}
                  </span>
                  <span className="exp-dur mono">{ev.ended_min == null
                    ? fmtCron(now - ev.started_min)
                    : fmtDur(ev.ended_min - ev.started_min)}</span>
                </button>
              );
            })()
          ) : (
            // E7-bloco-27 #1+#3: tira "curto/longo" (53min sendo "curto" era absurdo)
            // e adiciona botão copy pra Bruno mandar o gap pro Slack da pessoa.
            <div key={'gap-' + i} className="exp-row exp-row-gap" style={{ position: 'relative' }}>
              <button className="exp-row-gap-main exp-row-clickable"
                      onClick={(e) => onGapClick && onGapClick(op.id, it, { x: e.clientX, y: e.clientY })}
                      title="Clique pra preencher o que aconteceu nesse intervalo"
                      style={{ display: 'contents', cursor: 'pointer', background: 'transparent', border: 'none', padding: 0, font: 'inherit', textAlign: 'left' }}>
                <span className="exp-time mono">{fmtClock(it.start)} → {fmtClock(it.end)}</span>
                <span className="exp-act muted">+ preencher gap</span>
                <span className="exp-dur mono muted">{fmtDur(it.dur)}</span>
              </button>
              <CopyGapButton start={it.start} end={it.end} dur={it.dur} fmtClock={fmtClock} fmtDur={fmtDur}
                             personName={op.name}/>
            </div>
          ))}
      </div>
    </div>
  );
}

/* CopyGapButton — botão lateral nos rows de gap (expand). Copia pro clipboard
   texto formatado pra Bruno mandar pro Slack da pessoa.
   Formato: "11:52 AM → 12:45 PM (53min) — o que aconteceu?"
   Bloco 27/mai #3. */
function CopyGapButton({ start, end, dur, fmtClock, fmtDur, personName }) {
  const [copied, setCopied] = React.useState(false);
  const text = `${fmtClock(start)} → ${fmtClock(end)} (${fmtDur(dur)}) — o que aconteceu?`;
  const onCopy = (e) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(text).then(
        () => { setCopied(true); setTimeout(() => setCopied(false), 1400); },
        () => { setCopied(false); }
      );
    } catch {
      // fallback p/ browsers sem clipboard API (rara)
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch {}
      document.body.removeChild(ta);
    }
  };
  return (
    <button className="gap-copy-btn"
            onClick={onCopy}
            title={copied ? 'Copiado!' : `Copiar "${text}" pro clipboard`}
            aria-label="Copiar texto do gap">
      {copied ? '✓' : '⎘'}
    </button>
  );
}

window.Timeline = Timeline;

export { Timeline };
