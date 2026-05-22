// HEALTHFARE V3 — SPA — componentes visuais compartilhados.
import React from 'react';
import { fmtDur } from './api.js';

const CONF = { high: 'var(--high)', medium: 'var(--medium)', low: 'var(--low)', unconfirmed: 'var(--unconfirmed)' };
const CAT = { production_phase: 'var(--prod)', support: 'var(--pnp)', meta: 'var(--support)' };

export function Loading() { return <div className="loading">carregando…</div>; }

export function ErrorBox({ error }) {
  return <div className="errbox">erro: {error && error.message ? error.message : String(error)}</div>;
}

export function Empty({ children }) { return <div className="empty">{children || 'nada por aqui.'}</div>; }

/** Card de métrica (label + valor grande + sub). */
export function Metric({ label, value, sub }) {
  return (
    <div className="card metric">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

/** Badge de confiança colorido. */
export function ConfBadge({ value }) {
  return <span className="badge" style={{ background: CONF[value] || '#64748b' }}>{value || '?'}</span>;
}

/** Barra de progresso de meta (verde se bateu, vermelho se não). */
export function GoalBar({ pct, bateu }) {
  const w = Math.max(0, Math.min(100, pct == null ? 0 : pct));
  const color = bateu ? 'var(--ok)' : 'var(--bad)';
  return <div className="bar"><span style={{ width: w + '%', background: color }} /></div>;
}

/** Bloco de fase/atividade colorido pela categoria. */
export function ActivityBlock({ name, seconds, category, extra }) {
  return (
    <span className="block" style={{ background: CAT[category] || 'var(--panel)' }}>
      {name}{seconds != null ? <span className="muted"> · {fmtDur(seconds)}</span> : null}{extra || ''}
    </span>
  );
}

/** Legenda das cores de categoria. */
export function FlowLegend() {
  return (
    <p className="small muted">
      <span className="badge" style={{ background: 'var(--prod)' }}>produção</span>{' '}
      <span className="badge" style={{ background: 'var(--pnp)' }}>P&amp;P / apoio</span>{' '}
      <span className="badge" style={{ background: 'var(--support)' }}>pausa/meta</span>{' '}
      &nbsp;🔗 cowork &nbsp;• em andamento
    </p>
  );
}
