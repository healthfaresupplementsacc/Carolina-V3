import React from 'react';
import { Icon, Leaf, Capsule } from './Icons.jsx';

/* Shared small components: OperatorAvatar, FlowPill, ProductChip, KPI, CountdownCard */

const OperatorAvatar = ({ op, size = "md", variant = "circle" }) => {
  if (!op) return null;
  const sizeClass = size === "lg" ? "lg" : size === "xl" ? "xl" : "";
  const style = { "--av-c1": op.c1, "--av-c2": op.c2,
                  background: variant === "capsule"
                    ? `linear-gradient(90deg, ${op.c1} 50%, ${op.c2} 50%)`
                    : `linear-gradient(135deg, ${op.c1}, ${op.c2})` };
  return (
    <div className={`av ${sizeClass} ${variant === "capsule" ? "capsule" : ""}`} style={style} title={op.name}>
      {op.short}
    </div>
  );
};

const FlowPill = ({ flow, en = false, live = false, children }) => {
  const def = window.HFData.FLOWS[flow];
  if (!def) return null;
  return (
    <span className={`pill ${flow} ${live ? "live" : ""}`}>
      <span className="dot"/>
      {children || (en ? def.en : def.label)}
    </span>
  );
};

const FlowDot = ({ flow, size = 8 }) => (
  <span style={{ display: "inline-block", width: size, height: size, borderRadius: "50%",
                 background: `var(--flow-${flow})`, flex: `0 0 ${size}px` }}/>
);

const ProductChip = ({ product, lot = true }) => {
  if (!product) return <span style={{ color: "var(--text-3)", fontSize: 12 }}>—</span>;
  const p = window.HFData.products[product];
  if (!p) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
      <Leaf size={10} color="var(--hf-leaf-500)"/>
      <b style={{ fontWeight: 600 }}>{p.name}</b>
      {lot && <span className="mono" style={{ color: "var(--text-3)", fontSize: 11 }}>{p.batch}</span>}
    </span>
  );
};

const KPI = ({ label, en, value, suffix, foot, attn, children, headRight, onValueClick }) => (
  <div className={`card kpi ${attn ? "attn" : ""}`}>
    <div style={{ position: "relative", zIndex: 1 }}>
      <div className="label">
        <Leaf size={11} color="var(--hf-leaf-500)"/>
        <span style={{ whiteSpace: "nowrap" }}>{label}</span>
        {en && <span style={{ color: "var(--text-3)", fontWeight: 500, letterSpacing: 0.04, marginLeft: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>· {en}</span>}
        <span style={{ flex: 1, minWidth: 4 }}/>
        {headRight}
      </div>
      {onValueClick ? (
        <button className="value kpi-value-btn" onClick={onValueClick}
                title="Ver detalhe (taxas)" style={{
                  background: "none", border: "none", padding: 0, cursor: "pointer",
                  font: "inherit", color: "inherit", textAlign: "left", display: "block", width: "100%",
                }}>
          {value}{suffix && <small>{suffix}</small>}
          <span className="kpi-drill-caret" style={{ fontSize: 11, color: "var(--text-3)", marginLeft: 6, fontWeight: 500 }}>▾</span>
        </button>
      ) : (
        <div className="value">
          {value}{suffix && <small>{suffix}</small>}
        </div>
      )}
      {foot && <div className="foot">{foot}</div>}
      {children}
    </div>
  </div>
);

const CapBar = ({ pct, label, sub, size = "md", color1, color2 }) => {
  const cls = size === "xl" ? "cap xl" : size === "lg" ? "cap lg" : "cap";
  const clamped = Math.max(0, Math.min(100, pct));
  const fillStyle = {
    width: clamped + "%",
    background: color1 && color2
      ? `linear-gradient(90deg, ${color1}, ${color2})`
      : undefined,
  };
  return (
    <div>
      {(label || sub) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)" }}>{label}</span>
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>{sub}</span>
        </div>
      )}
      <div className={cls} style={{ width: "100%", display: "block" }}>
        <div className="cap-fill" style={fillStyle}/>
      </div>
    </div>
  );
};

// Countdown — green/amber/red urgency states
const CountdownCard = ({ deadlineMin, now, label, en, title }) => {
  const remaining = deadlineMin - now;
  let urgency = "ok";
  if (remaining <= 30) urgency = "red";
  else if (remaining <= 90) urgency = "amber";
  const cls = urgency === "ok" ? "" : urgency === "amber" ? "amber" : "red";
  const passed = remaining < 0; // deadline já passou → estado VENCIDO (vermelho)
  const h = Math.max(0, Math.floor(remaining / 60));
  const m = Math.max(0, Math.floor(remaining % 60));
  const s = Math.max(0, Math.floor((remaining - Math.floor(remaining)) * 60));
  return (
    <div className={`countdown ${passed ? 'red' : cls}`}>
      <div className="cd-ico"><Icon name="clock" size={22}/></div>
      <div className="cd-text">
        <div className="cd-label">{label}{en && <span style={{ opacity: 0.6, marginLeft: 6 }}>· {en}</span>}</div>
        <div className="cd-title">{title} · {window.HFH.fmtClock(deadlineMin)}</div>
      </div>
      <div className="cd-clock mono tabnum">
        {passed ? <span>vencido</span> : <>{h > 0 && <>{h}<small>h </small></>}{window.HFH.pad(m)}<small>m </small>{window.HFH.pad(s)}<small>s</small></>}
      </div>
    </div>
  );
};

/* Faixa das telas legadas (S15 08-19). As duas páginas antigas saíram do menu
   mas continuam abrindo por hash: quem chegou por link salvo precisa saber, na
   primeira linha, que o hub faz a mesma coisa e é lá que o número é escrito. */
const LegacyBanner = () => (
  <div className="kit-legacy-banner" data-legacy-banner>
    <span>Página antiga. O hub Estoque substitui esta tela.</span>
    <a className="kit-btn sm primary" href="#estoque">Ir pro hub Estoque</a>
  </div>
);

Object.assign(window, { OperatorAvatar, FlowPill, FlowDot, ProductChip, KPI, CapBar, CountdownCard, LegacyBanner });

export { OperatorAvatar, FlowPill, FlowDot, ProductChip, KPI, CapBar, CountdownCard, LegacyBanner };
