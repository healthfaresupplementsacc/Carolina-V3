import React from 'react';
import { Icon } from './Icons.jsx';
import { OperatorAvatar, FlowPill, ProductChip } from './Primitives.jsx';

/* Painel flutuante de evento — E7 substitui o "side panel" lateral com
   backdrop. Agora abre próximo do clique, sem overlay (dá pra ver a
   timeline atrás), arrastável pela barra de título.

   API: { event, onClose, onUpdate, onDelete, operators, now, initialPos }
     initialPos = { x, y }  // coords do clique (clientX/clientY). Adapter
                            // clampa pra caber na viewport.

   Mantém o export `SidePanel` por retro-compat com App.jsx.

   TODO (Bruno · pós-E7, ordem final):
     1. minimizar → vira chip no canto inferior direito
     2. maximizar → ocupa metade/inteiro da tela
     3. redimensionar → handles SE/E/S pra arrastar bordas
     4. transparência ajustável → slider no head
*/

const PANEL_W = 440;
const PANEL_ESTIMATED_H = 540;   // altura aproximada — clampa pra caber acima
const DEFAULT_W_PAD = 24;

function clampPos(x, y) {
  const vh = window.innerHeight || 800;
  const maxX = Math.max(0, (window.innerWidth || 1200) - PANEL_W - 12);
  const maxY = Math.max(0, vh - 60);   // pelo menos o head visível
  return {
    x: Math.min(Math.max(12, x), maxX),
    y: Math.min(Math.max(12, y), maxY),
  };
}

/* E7-refine2 #1 — abre ACIMA do cursor (bottom do painel = cursor.y - gap).
   Se não cabe acima (cursor muito perto do topo), encosta no topo da viewport
   (12px do topo). Centro horizontal aproximado: cursor.x à esquerda do painel
   ou descola um pouco pra direita pra não sumir atrás do mouse. */
function positionAboveCursor(initialPos) {
  const vh = window.innerHeight || 800;
  const vw = window.innerWidth || 1200;
  if (!initialPos || initialPos.x == null) {
    return clampPos(vw - PANEL_W - DEFAULT_W_PAD, 80);
  }
  // y: bottom do painel imediatamente acima do clique (gap 12px)
  const desiredH = Math.min(PANEL_ESTIMATED_H, vh - 24);
  let y = initialPos.y - desiredH - 12;
  if (y < 12) y = 12;                       // não cabe acima → encosta no topo
  // x: encosta ligeiramente à direita do cursor; se passar do limite, à esquerda
  let x = initialPos.x + 16;
  if (x + PANEL_W > vw - 12) x = initialPos.x - PANEL_W - 16;
  return clampPos(x, y);
}

function SidePanel({ event, onClose, onUpdate, onDelete, operators, now,
                     initialPos, pendingForm, onDraftChange }) {
  // Quando há pendente, abrimos JÁ em edit pra Bruno ver os campos.
  const [mode, setMode] = React.useState(() => (event?._new || pendingForm) ? "edit" : "view");
  React.useEffect(() => { setMode((event?._new || pendingForm) ? "edit" : "view"); }, [event?.id]);

  // ── posição: ACIMA do cursor, clampada à viewport (E7-refine2 #1) ──
  const [pos, setPos] = React.useState(() => positionAboveCursor(initialPos));
  React.useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p.x, p.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  React.useEffect(() => {
    if (!initialPos) return;
    setPos(positionAboveCursor(initialPos));
  }, [event?.id, initialPos?.x, initialPos?.y]);

  // ── drag pela barra de título ──
  const dragRef = React.useRef(null);
  const onDragStart = (e) => {
    if (e.button !== 0) return;
    // ignora se o mousedown veio do botão de fechar/avatar interativos
    if (e.target.closest('button, input, select, textarea')) return;
    e.preventDefault();
    const startX = e.clientX - pos.x;
    const startY = e.clientY - pos.y;
    dragRef.current = { startX, startY };
    const onMove = (ev) => {
      setPos(clampPos(ev.clientX - dragRef.current.startX, ev.clientY - dragRef.current.startY));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!event) return null;
  const { activities, products, FLOWS } = window.HFData;
  const { fmtClock, fmtCron, fmtDur } = window.HFH;
  const act = activities[event.activity];
  const prod = event.product ? products[event.product] : null;
  const flow = act?.flow;
  const isLive = event.ended_min == null;
  const endMin = isLive ? now : event.ended_min;
  const dur = endMin - event.started_min;
  const op = operators.find(o => o.id === event.op);
  const cowork = (event.cowork || []).map(id => operators.find(o => o.id === id)).filter(Boolean);

  // EDIT MODE form state — começa do pendingForm se houver (draft preservado)
  const [form, setForm] = React.useState(null);
  React.useEffect(() => {
    if (mode !== "edit") return;
    if (pendingForm) {
      setForm({ ...pendingForm });
      return;
    }
    setForm({
      op: event.op,
      activity: event.activity,
      product: event.product || "",
      started_min: event.started_min,
      ended_min: event.ended_min == null ? "" : event.ended_min,
      cowork: [...(event.cowork || [])],
      qty: event.qty || "",
      unit: event.unit || "",
      description: event.description || "",
      confidence: event.confidence || "high",
    });
  }, [mode, event.id]);

  // Bubbling do draft pro App.jsx (pra fechar mid-edit virar pending automático).
  React.useEffect(() => {
    if (!onDraftChange) return;
    if (mode !== 'edit' || !form) { onDraftChange(null); return; }
    const dirty = !!(
      form.op !== event.op ||
      form.activity !== event.activity ||
      (form.product || null) !== (event.product || null) ||
      form.started_min !== event.started_min ||
      ((form.ended_min === '' || form.ended_min == null ? null : form.ended_min)) !== event.ended_min ||
      JSON.stringify(form.cowork || []) !== JSON.stringify(event.cowork || []) ||
      (form.qty || null) !== (event.qty || null) ||
      (form.unit || null) !== (event.unit || null) ||
      (form.description || '') !== (event.description || '') ||
      form.confidence !== (event.confidence || 'high')
    );
    onDraftChange({ ...form, _dirty: dirty });
  }, [form, mode, event, onDraftChange]);

  const minToInput = (min) => {
    if (min === "" || min == null) return "";
    const h = Math.floor(min / 60), m = Math.floor(min % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  const inputToMin = (s) => {
    if (!s) return null;
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };

  function save() {
    const next = {
      ...event,
      op: form.op,
      activity: form.activity,
      product: form.product || null,
      started_min: typeof form.started_min === "number" ? form.started_min : inputToMin(form.started_min),
      ended_min: form.ended_min === "" || form.ended_min == null ? null : (typeof form.ended_min === "number" ? form.ended_min : inputToMin(form.ended_min)),
      cowork: form.cowork,
      qty: form.qty || null,
      unit: form.unit || null,
      description: form.description,
      confidence: form.confidence,
    };
    delete next._new;
    onUpdate(next);
    setMode("view");
  }

  return (
    <aside className="float-panel" style={{
      position: 'fixed', left: pos.x, top: pos.y, width: PANEL_W,
      maxHeight: 'min(80vh, 640px)', zIndex: 300,
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
      boxShadow: 'var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.18))',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      // TODO transparência: aplicar opacity dinâmica controlada por slider.
    }}>
      {/* Header — drag handle */}
      <div className="float-panel-head"
           onMouseDown={onDragStart}
           style={{
             padding: '12px 14px 10px',
             borderBottom: '1px solid var(--border)',
             display: 'flex', alignItems: 'center', gap: 10,
             background: 'var(--surface-2)',
             cursor: 'move', userSelect: 'none',
           }}
           title="Arraste para mover">
        <span style={{ color: 'var(--text-3)', fontSize: 14, fontWeight: 700 }}>⋮⋮</span>
        <OperatorAvatar op={op} size="md"/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {op?.name || '—'}
          </div>
          <div style={{ marginTop: 2, display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', fontSize: 11 }}>
            {flow && <FlowPill flow={flow}>{act?.name}</FlowPill>}
            {isLive && <span className="pill live"><span className="dot"/>ao vivo · {fmtCron(dur)}</span>}
            {event.overrun && <span className="pill warn">⏰ overrun</span>}
            {pendingForm && (
              <span className="pill warn" title="Rascunho não salvo — fecha sem salvar e mantém aqui pra terminar depois">
                <span className="dot"/>pending
              </span>
            )}
          </div>
        </div>
        {/* TODO controles futuros — área reservada no canto direito.
            Ordem: [opacity-slider] [minimize] [maximize] [close]. */}
        <button className="icon-btn" onClick={onClose} aria-label="Fechar" title="Fechar (Esc)">
          <Icon name="x" size={14}/>
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 14px' }}>
        {mode === "view" && (
          <>
            <Field label="Atividade" en="Activity"><span>{act?.name || '—'} {act?.en && <span style={{ color: "var(--text-3)" }}>· {act?.en}</span>}</span></Field>
            {flow && <Field label="Fluxo" en="Flow"><FlowPill flow={flow}/></Field>}
            <Field label="Produto" en="Product">
              {prod ? <ProductChip product={event.product}/> : <span style={{ color: "var(--text-3)" }}>—</span>}
            </Field>
            <Field label="Início" en="Start"><b>{fmtClock(event.started_min)}</b></Field>
            <Field label="Fim" en="End">
              {isLive ? <span className="pill live"><span className="dot"/>contando</span> : <b>{fmtClock(event.ended_min)}</b>}
            </Field>
            <Field label="Duração" en="Duration">
              <b className="mono">{isLive ? fmtCron(dur) : fmtDur(dur)}</b>
              {act?.expected && (
                <span style={{ fontSize: 11, color: "var(--text-3)", marginLeft: 8 }}>esperado {fmtDur(act.expected)}</span>
              )}
            </Field>
            {/* FASE 3b — Revisão: taxa por TASK (cáps/seg + cáps/min + total cápsulas
                pelo lote que a pessoa está revisando). Casa com a run do dia (review.runs). */}
            {event.activity === 'review' && (() => {
              const runs = (window.HFData.review && window.HFData.review.runs) || [];
              const bn = prod ? prod.batch : null;
              const run = runs.find(r => bn && r.batch === bn && (!op || r.operator === op.name))
                       || runs.find(r => bn && r.batch === bn);
              if (!run) return (
                <Field label="Taxa de revisão" en="Review rate">
                  <span style={{ color: 'var(--text-3)', fontSize: 12 }}>sem dados — lote sem cápsulas-por-frasco, ou revisão ainda aberta/de outro dia</span>
                </Field>
              );
              const capsMin = run.capsules_per_sec != null ? Math.round(run.capsules_per_sec * 60) : null;
              const perBottle = (run.bottles && run.capsules) ? Math.round(run.capsules / run.bottles) : null;
              return (
                <Field label="Taxa de revisão" en="Review rate">
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <span><b className="mono" style={{ color: 'var(--flow-prod)', fontSize: 15 }}>{run.capsules_per_sec != null ? run.capsules_per_sec : '—'}</b> <small style={{ color: 'var(--text-3)' }}>cáps/seg</small></span>
                    <span><b className="mono" style={{ color: 'var(--flow-prod)', fontSize: 15 }}>{capsMin != null ? capsMin : '—'}</b> <small style={{ color: 'var(--text-3)' }}>cáps/min</small></span>
                    <span><b className="mono" style={{ fontSize: 15 }}>{run.capsules != null ? run.capsules.toLocaleString() : '—'}</b> <small style={{ color: 'var(--text-3)' }}>cáps total</small></span>
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 4 }}>
                    {run.bottles} frascos × {perBottle != null ? perBottle : '?'} cáps/frasco · {run.bottles_per_min}/min · lote {run.batch || '—'}
                  </div>
                </Field>
              );
            })()}
            {cowork.length > 0 && (
              <Field label="Cowork" en="Co-work">
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {cowork.map(cw => (
                    <span key={cw.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, padding: "3px 8px 3px 3px", borderRadius: 999, background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                      <OperatorAvatar op={cw} size="md" style={{ width: 22, height: 22, fontSize: 10 }}/>
                      {cw.name}
                    </span>
                  ))}
                </div>
              </Field>
            )}
            {event.qty && (
              <Field label="Quantidade" en="Quantity"><b>{event.qty}</b> <span style={{ color: "var(--text-3)" }}>{event.unit}</span></Field>
            )}
            {event.description && (
              <Field label="Descrição" en="Description"><span style={{ fontStyle: "italic", color: "var(--text-2)" }}>{event.description}</span></Field>
            )}
            <Field label="Confiança" en="Confidence">
              <span className={`pill ${event.confidence === "high" ? "ok" : event.confidence === "medium" ? "warn" : "bad"}`}>
                <span className="dot"/>{event.confidence}
              </span>
            </Field>
            <Field label="ID"><span className="mono" style={{ color: "var(--text-3)", fontSize: 12 }}>ev {event.id}</span></Field>
          </>
        )}

        {mode === "edit" && form && (
          <>
            <FieldEdit label="Operador" en="Operator">
              <select value={form.op} onChange={e => setForm({ ...form, op: e.target.value })} className="input">
                {operators.map(o => <option key={o.id} value={o.id}>{o.name} · {o.role}</option>)}
              </select>
            </FieldEdit>
            <FieldEdit label="Atividade" en="Activity">
              <select value={form.activity} onChange={e => setForm({ ...form, activity: e.target.value })} className="input">
                {Object.entries(activities).map(([k, a]) => (
                  <option key={k} value={k}>{a.name} ({a.flow})</option>
                ))}
              </select>
            </FieldEdit>
            <FieldEdit label="Produto" en="Product">
              <select value={form.product} onChange={e => setForm({ ...form, product: e.target.value })} className="input">
                <option value="">— nenhum —</option>
                {Object.entries(products).map(([k, p]) => (
                  <option key={k} value={k}>{p.name} · {p.batch}</option>
                ))}
              </select>
            </FieldEdit>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <FieldEdit label="Início" en="Start">
                <input type="time" className="input" value={minToInput(form.started_min)}
                       onChange={e => setForm({ ...form, started_min: inputToMin(e.target.value) })}/>
              </FieldEdit>
              <FieldEdit label="Fim" en="End">
                <input type="time" className="input" value={minToInput(form.ended_min)}
                       placeholder="(live)"
                       onChange={e => setForm({ ...form, ended_min: e.target.value === "" ? null : inputToMin(e.target.value) })}/>
              </FieldEdit>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <FieldEdit label="Quantidade" en="Quantity">
                <input type="number" className="input" value={form.qty} onChange={e => setForm({ ...form, qty: e.target.value })}/>
              </FieldEdit>
              <FieldEdit label="Unidade" en="Unit">
                <select className="input" value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })}>
                  <option value="">—</option>
                  <option value="bottle">bottle · garrafa</option>
                  <option value="order">order · pedido</option>
                  <option value="box">box · caixa</option>
                </select>
              </FieldEdit>
            </div>
            <FieldEdit label="Cowork">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {operators.filter(o => o.id !== form.op).map(o => {
                  const on = form.cowork.includes(o.id);
                  return (
                    <button key={o.id} className={`filter-chip ${on ? "on" : ""}`}
                            onClick={() => setForm({ ...form, cowork: on ? form.cowork.filter(x => x !== o.id) : [...form.cowork, o.id] })}>
                      {o.short} · {o.name}
                    </button>
                  );
                })}
              </div>
            </FieldEdit>
            <FieldEdit label="Descrição" en="Description">
              <textarea className="input" rows={3} value={form.description}
                        onChange={e => setForm({ ...form, description: e.target.value })}/>
            </FieldEdit>
          </>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, background: 'var(--surface)' }}>
        {mode === "view" ? (
          <>
            <button className="btn primary" onClick={() => setMode("edit")}><Icon name="edit" size={14}/>Editar</button>
            <span style={{ flex: 1 }}/>
            <button className="btn danger" onClick={() => onDelete(event)}><Icon name="trash" size={14}/></button>
          </>
        ) : (
          <>
            <button className="btn primary" onClick={save}>Salvar</button>
            <button className="btn ghost" onClick={() => event._new ? onClose() : setMode("view")}>Cancelar</button>
            <span style={{ flex: 1 }}/>
            {!event._new && <button className="btn danger" onClick={() => onDelete(event)}><Icon name="trash" size={14}/></button>}
          </>
        )}
      </div>
    </aside>
  );
}

const Field = ({ label, en, children }) => (
  <div style={{ display: "grid", gridTemplateColumns: "92px 1fr", gap: 10, padding: "6px 0", borderBottom: "1px dashed var(--border)", alignItems: "baseline" }}>
    <div style={{ fontSize: 10.5, letterSpacing: 0.08, textTransform: "uppercase", color: "var(--text-3)", fontWeight: 600 }}>
      {label}{en && <div style={{ marginTop: 1, opacity: 0.7 }}>{en}</div>}
    </div>
    <div style={{ fontSize: 13, color: "var(--text)" }}>{children}</div>
  </div>
);
const FieldEdit = ({ label, en, children }) => (
  <div style={{ marginBottom: 10 }}>
    <label style={{ display: "block", fontSize: 10.5, letterSpacing: 0.08, textTransform: "uppercase", color: "var(--text-3)", fontWeight: 600, marginBottom: 5 }}>
      {label}{en && <span style={{ opacity: 0.6, marginLeft: 4 }}>· {en}</span>}
    </label>
    {children}
  </div>
);

window.SidePanel = SidePanel;

export { SidePanel };
