import React from 'react';
import { Icon } from './Icons.jsx';
import { OperatorAvatar, FlowPill, ProductChip } from './Primitives.jsx';

/* Side panel for event detail/edit. Used by Command Center.
   Modes: view, edit, create.
*/

function SidePanel({ event, onClose, onUpdate, onDelete, operators, now }) {
  const [mode, setMode] = React.useState(event?._new ? "edit" : "view");
  React.useEffect(() => { setMode(event?._new ? "edit" : "view"); }, [event?.id]);

  if (!event) return null;
  const { activities, products, FLOWS } = window.HFData;
  const { fmtClock, fmtCron, fmtDur } = window.HFH;
  const act = activities[event.activity];
  const prod = event.product ? products[event.product] : null;
  const flow = act?.flow;
  const flowDef = FLOWS[flow];
  const isLive = event.ended_min == null;
  const endMin = isLive ? now : event.ended_min;
  const dur = endMin - event.started_min;
  const op = operators.find(o => o.id === event.op);
  const cowork = (event.cowork || []).map(id => operators.find(o => o.id === id)).filter(Boolean);

  // EDIT MODE form state
  const [form, setForm] = React.useState(null);
  React.useEffect(() => {
    if (mode !== "edit") return;
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

  const minToInput = (min) => {
    if (min === "" || min == null) return "";
    const h = Math.floor(min / 60), m = Math.floor(min % 60);
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
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
    <>
      <div className="backdrop" onClick={onClose}/>
      <aside className="side-panel">
        {/* Header */}
        <div style={{ padding: "16px 18px 12px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "flex-start", gap: 12, position: "relative", zIndex: 1 }}>
          <OperatorAvatar op={op} size="lg"/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.015em", lineHeight: 1.2 }}>{op?.name}</div>
            <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <FlowPill flow={flow}>{act?.name}</FlowPill>
              {isLive && <span className="pill live"><span className="dot"/>ao vivo · {fmtCron(dur)}</span>}
              {event.overrun && <span className="pill warn">⏰ overrun</span>}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar"><Icon name="x" size={16}/></button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: "14px 18px" }}>
          {mode === "view" && (
            <>
              <Field label="Atividade" en="Activity"><span>{act?.name} <span style={{ color: "var(--text-3)" }}>· {act?.en}</span></span></Field>
              <Field label="Fluxo" en="Flow"><FlowPill flow={flow}/></Field>
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
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border)", display: "flex", gap: 8, position: "relative", zIndex: 1, background: "var(--surface)" }}>
          {mode === "view" ? (
            <>
              <button className="btn primary" onClick={() => setMode("edit")}><Icon name="edit" size={14}/>Editar</button>
              <button className="btn"><Icon name="merge" size={14}/>Juntar</button>
              <button className="btn"><Icon name="split" size={14}/>Dividir</button>
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
    </>
  );
}

const Field = ({ label, en, children }) => (
  <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: 10, padding: "8px 0", borderBottom: "1px dashed var(--border)", alignItems: "baseline" }}>
    <div style={{ fontSize: 10.5, letterSpacing: 0.08, textTransform: "uppercase", color: "var(--text-3)", fontWeight: 600 }}>{label}{en && <div style={{ marginTop: 1, opacity: 0.7 }}>{en}</div>}</div>
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
