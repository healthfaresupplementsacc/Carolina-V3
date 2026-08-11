/* Página "Sistema" — SAÚDE DE TODOS OS PROCESSOS (Bruno 07-28).
   Fonte única: o registro src/v3/process-registry.js cruzado com os heartbeats
   reais. Mostra TUDO que roda (workers, crons, watchdogs, bots e os processos do
   PC de impressão .28): ligado/desligado, vivo/morto, o que cada um faz.
   Dado real: GET /api/v3/data/system-health (poll 20s). */
import React from 'react';
import { usePoll } from '../adapters/from-api.js';

// estado → cor + rótulo. Honesto: 'on_no_hb' = ligado mas sem como confirmar liveness.
function healthView(h) {
  switch (h) {
    case 'up':       return { c: '#22b35d', label: 'rodando', dot: '#22b35d' };
    case 'down':     return { c: '#dc2626', label: 'PAROU', dot: '#dc2626' };
    case 'off':      return { c: 'var(--text-3)', label: 'desligado', dot: 'var(--text-3)' };
    case 'on_no_hb': return { c: '#d97706', label: 'ligado (sem heartbeat)', dot: '#d97706' };
    case 'idle28':   return { c: '#d97706', label: 'ocioso (sem sinal recente)', dot: '#d97706' };
    case 'unknown':  return { c: 'var(--text-3)', label: 'sem sinal', dot: 'var(--text-3)' };
    default:         return { c: 'var(--text-3)', label: h || '?', dot: 'var(--text-3)' };
  }
}

function ago(min) {
  if (min == null) return '—';
  if (min < 1) return 'agora';
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60); return h + 'h' + String(min % 60).padStart(2, '0');
}

function ProcRow({ p }) {
  const v = healthView(p.health);
  const [open, setOpen] = React.useState(false);
  return (
    <div className="card" style={{ padding: 0, marginBottom: 6, overflow: 'hidden',
           borderLeft: '3px solid ' + v.c }}>
      <div style={{ padding: '9px 13px', display: 'flex', alignItems: 'center', gap: 11, cursor: 'pointer' }}
           onClick={() => setOpen(!open)}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: v.dot, flexShrink: 0 }}/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 13.5 }}>{p.name}</b>
            {p.critical && <span style={{ fontSize: 9.5, fontWeight: 800, color: '#dc2626', border: '1px solid #dc2626', padding: '0 4px', borderRadius: 4 }}>CRÍTICO</span>}
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{p.where === 'win28' ? 'PC impressão (.28)' : 'Railway'}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 1 }}>{p.short}</div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: v.c }}>{v.label}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
            {p.heartbeat || p.where === 'win28' ? 'últ. sinal: ' + ago(p.last_beat_min) : (p.tick_ms ? 'loop ' + Math.round(p.tick_ms / 1000) + 's' : 'sob demanda')}
          </div>
        </div>
      </div>
      {open && (
        <div style={{ padding: '4px 13px 11px 33px', fontSize: 12, color: 'var(--text-2)', borderTop: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          <div style={{ marginTop: 6 }}>{p.detail}</div>
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)' }}>
            id: <span className="mono">{p.key}</span>
            {p.tick_ms ? <> · loop {Math.round(p.tick_ms / 1000)}s</> : <> · sob demanda</>}
            {p.since ? <> · no ar desde {p.since}</> : null}
            {' · '}{p.enabled ? 'ligado por config' : 'DESLIGADO por config'}
          </div>
        </div>
      )}
    </div>
  );
}

export function SystemHealthPage() {
  const { data } = usePoll('/system-health', [], 20000);
  const procs = (data && data.processes) || [];
  const sum = (data && data.summary) || {};
  const railway = procs.filter((p) => p.where === 'railway');
  const win28 = procs.filter((p) => p.where === 'win28');

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '4px 2px 40px' }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, margin: '4px 0 2px' }}>Sistema — o que está rodando</h1>
      <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: '0 0 14px' }}>
        Todo worker, cron, watchdog e processo do PC de impressão. Verde = rodando · vermelho = parou · cinza = desligado. Clique pra ver o que cada um faz.
      </p>

      {/* resumo */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {[['rodando', sum.up, '#22b35d'], ['parados', sum.down, '#dc2626'], ['desligados', sum.off, 'var(--text-3)'], ['total', sum.total, 'var(--text-2)']].map(([lbl, n, c]) => (
          <div key={lbl} className="card" style={{ padding: '8px 14px', minWidth: 84, textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: c }}>{n != null ? n : '—'}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{lbl}</div>
          </div>
        ))}
      </div>

      {sum.critical_down > 0 && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 14, border: '1.5px solid #dc2626', background: 'color-mix(in srgb, #dc2626 7%, var(--surface))' }}>
          <b style={{ color: '#dc2626', fontSize: 13.5 }}>⚠️ {sum.critical_down} processo(s) CRÍTICO(s) parado(s)</b>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>Avisos automáticos podem não estar saindo. Ver abaixo.</div>
        </div>
      )}

      <div style={{ fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.05, color: 'var(--text-3)', margin: '4px 0 7px' }}>Railway (backend)</div>
      {railway.map((p) => <ProcRow key={p.key} p={p}/>)}

      <div style={{ fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.05, color: 'var(--text-3)', margin: '16px 0 7px' }}>PC de impressão (.28)</div>
      {win28.map((p) => <ProcRow key={p.key} p={p}/>)}
      <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
        Os processos do .28 não imprimem o tempo todo — "ocioso" é normal fora de uma impressão; "parou" só se o pipeline sumir por horas.
      </p>
    </div>
  );
}
