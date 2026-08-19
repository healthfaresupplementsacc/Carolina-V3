/* Página "Sistema" — SAÚDE DE TODOS OS PROCESSOS (Bruno 07-28).
   Fonte única: o registro src/v3/process-registry.js cruzado com os heartbeats
   reais. Mostra TUDO que roda (workers, crons, watchdogs, bots e os processos do
   PC de impressão .28): ligado/desligado, vivo/morto, o que cada um faz.
   Dado real: GET /api/v3/data/system-health (poll 20s).

   S15 Fase 2 (grupo C): STYLE-KIT 100%. O registro virou uma kit-table (linha
   clicável abre o detalhe), estados viram chips tonais. Endpoint e poll iguais. */
import React from 'react';
import { usePoll } from '../adapters/from-api.js';
import './pages-admin.css';

// estado → tom do kit + rótulo. Honesto: 'on_no_hb' = ligado mas sem como
// confirmar liveness; 'idle28' = o PC de impressão está quieto (normal).
function healthView(h) {
  switch (h) {
    case 'up':       return { tone: 'ok',      dot: 'ok',   label: 'rodando' };
    case 'down':     return { tone: 'bad',     dot: 'bad',  label: 'PAROU' };
    case 'off':      return { tone: 'neutral', dot: 'off',  label: 'desligado' };
    case 'on_no_hb': return { tone: 'warn',    dot: 'warn', label: 'ligado, sem heartbeat' };
    case 'idle28':   return { tone: 'warn',    dot: 'warn', label: 'ocioso, sem sinal recente' };
    case 'unknown':  return { tone: 'neutral', dot: 'off',  label: 'sem sinal' };
    default:         return { tone: 'neutral', dot: 'off',  label: h || '?' };
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
  const sinal = (p.heartbeat || p.where === 'win28')
    ? 'últ. sinal ' + ago(p.last_beat_min)
    : (p.tick_ms ? 'loop ' + Math.round(p.tick_ms / 1000) + 's' : 'sob demanda');
  return (
    <>
      <tr className="clickable" onClick={() => setOpen(!open)} data-proc={p.key}>
        <td style={{ width: 18 }}><span className={'sys-dot ' + v.dot}/></td>
        <td>
          <b style={{ color: 'var(--primary-deep)' }}>{p.name}</b>
          {p.critical && <span className="kit-chip bad" style={{ marginLeft: 7 }}>crítico</span>}
          <div className="adm-note" style={{ marginTop: 2 }}>{p.short}</div>
        </td>
        <td><span className={'kit-chip ' + v.tone}>{v.label}</span></td>
        <td className="num">{sinal}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} style={{ padding: 0 }}>
            <div className="sys-detail">
              <div>{p.detail}</div>
              <div className="adm-note faint" style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span className="kit-chip neutral">{p.key}</span>
                <span className="kit-chip info">{p.tick_ms ? 'loop ' + Math.round(p.tick_ms / 1000) + 's' : 'sob demanda'}</span>
                {p.since ? <span className="kit-chip neutral">no ar desde {p.since}</span> : null}
                <span className={'kit-chip ' + (p.enabled ? 'ok' : 'neutral')}>{p.enabled ? 'ligado por config' : 'desligado por config'}</span>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ProcTable({ rows }) {
  if (rows.length === 0) return <div className="adm-empty">Nenhum processo neste grupo.</div>;
  return (
    <table className="kit-table" data-table="processos">
      <thead>
        <tr><th/><th>Processo</th><th>Estado</th><th className="num">Sinal</th></tr>
      </thead>
      <tbody>{rows.map((p) => <ProcRow key={p.key} p={p}/>)}</tbody>
    </table>
  );
}

export function SystemHealthPage() {
  const { data } = usePoll('/system-health', [], 20000);
  const procs = (data && data.processes) || [];
  const sum = (data && data.summary) || {};
  const railway = procs.filter((p) => p.where === 'railway');
  const win28 = procs.filter((p) => p.where === 'win28');

  return (
    <div data-page="sistema" style={{ maxWidth: 980, paddingBottom: 60 }}>
      <div className="adm-head">
        <div className="lead">
          <span className="kit-eyebrow">● HEALTHFARE · SISTEMA</span>
          <h1 className="kit-h1">Tudo que está <em>rodando</em></h1>
          <p className="kit-sub">
            Todo worker, cron, watchdog e processo do PC de impressão. Verde é rodando, vermelho parou, cinza está desligado.
            Clique na linha pra ver o que cada um faz.
          </p>
        </div>
      </div>

      {/* resumo */}
      <div className="adm-kpis" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))' }}>
        {[['rodando', sum.up, 'ok'], ['parados', sum.down, 'bad'], ['desligados', sum.off, ''], ['total', sum.total, '']].map(([lbl, n, tone]) => (
          <div key={lbl} className="adm-kpi" data-sum={lbl}>
            <div className="kit-mlabel">{lbl}</div>
            <div className={'v ' + tone}>{n != null ? n : '—'}</div>
          </div>
        ))}
      </div>

      {sum.critical_down > 0 && (
        <div className="kit-card pad bad" style={{ marginBottom: 16 }}>
          <b style={{ color: 'var(--bad-deep)', fontSize: 14 }}>{sum.critical_down} processo(s) crítico(s) parado(s)</b>
          <div className="adm-note" style={{ marginTop: 3 }}>Avisos automáticos podem não estar saindo. Veja a lista abaixo.</div>
        </div>
      )}

      <div className="kit-card pad" style={{ marginBottom: 14 }}>
        <div className="adm-sec">
          <span className="kit-mlabel">Railway · backend</span>
          <span className="rule"/>
          <span className="kit-chip neutral">{railway.length}</span>
        </div>
        <ProcTable rows={railway}/>
      </div>

      <div className="kit-card pad">
        <div className="adm-sec">
          <span className="kit-mlabel">PC de impressão · .28</span>
          <span className="rule"/>
          <span className="kit-chip neutral">{win28.length}</span>
        </div>
        <ProcTable rows={win28}/>
        <p className="adm-note faint" style={{ marginTop: 12 }}>
          Os processos do .28 não imprimem o tempo todo. "Ocioso" é normal fora de uma impressão; "parou" só se o pipeline sumir por horas.
        </p>
      </div>
    </div>
  );
}
