import React from 'react';
import { getBatchJourney } from '../adapters/journey-api.js';
import L from './timeline-layout.cjs';

/* BatchJourney — "quando eu clico no produto deveria aparecer todo o tempo que
   cada coisa que foi feita naquele produto/batch demorou até chegar ali"
   (Bruno 09-10). Gaveta à direita: fases na ordem real, tempo de gente ×
   tempo de parede, quem, espera entre fases, dias desde o início, garrafas
   contadas; cada fase expande nos registros. Só leitura. */

const toMin = (iso) => Math.round(new Date(iso).getTime() / 60000);
const nyStamp = (iso, withDate) => {
  if (!iso) return '';
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return (withDate ? `${g('day')}/${g('month')} ` : '') + `${g('hour')}:${g('minute')}`;
};

export function BatchJourney({ batchId, onClose }) {
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState('');
  const [open, setOpen] = React.useState({});
  React.useEffect(() => {
    let alive = true; setData(null); setErr('');
    if (!batchId) return undefined;
    getBatchJourney(batchId).then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setErr(e.message || String(e)); });
    return () => { alive = false; };
  }, [batchId]);
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!batchId) return null;

  let body = null;
  if (err) body = <div className="bj-err">{err}</div>;
  else if (!data) body = <div className="bj-hint">Carregando a jornada…</div>;
  else {
    const { batch, events, counts, bottles } = data;
    const evs = events.map((e) => ({ ...e, s: toMin(e.started_at), e: e.ended_at ? toMin(e.ended_at) : null }));
    const span = (e) => (e.e == null ? 0 : Math.max(0, e.e - e.s - Math.round((e.total_paused_seconds || 0) / 60)));
    const first = evs.length ? Math.min(...evs.map((e) => e.s)) : null;
    const last = evs.length ? Math.max(...evs.map((e) => e.e == null ? e.s : e.e)) : null;
    const days = first != null ? Math.max(1, Math.round((last - first) / 1440 * 10) / 10) : 0;
    const isMach = (e) => e.is_background || L.RAIL_SLUGS.has(e.slug);
    const hands = evs.filter((e) => !isMach(e)); const mach = evs.filter(isMach);
    const byPhase = {}; for (const e of evs) (byPhase[e.slug || '?'] = byPhase[e.slug || '?'] || []).push(e);
    const phases = Object.keys(byPhase).sort((a, b) => byPhase[a][0].s - byPhase[b][0].s);
    let prevEnd = null;
    body = (
      <>
        <h3>{batch.canonical_name || batch.product}</h3>
        <div className="bj-bn">{batch.batch_number} · {evs.length ? 'começou ' + nyStamp(evs[0].started_at, true) : 'sem registros'} · {evs.length} registros{batch.target_bottles ? ` · meta ${batch.target_bottles} garrafas` : ''}</div>
        <div className="bj-kpis">
          <div className="bj-kpi"><b>{days}{days === 1 ? ' dia' : ' dias'}</b><span>do início até aqui</span></div>
          <div className="bj-kpi"><b>{L.fmtDurShort(hands.reduce((a, e) => a + span(e), 0))}</b><span>tempo de gente</span></div>
          <div className="bj-kpi"><b>{L.fmtDurShort(mach.reduce((a, e) => a + span(e), 0))}</b><span>máquina</span></div>
          <div className="bj-kpi"><b>{bottles || 0}</b><span>garrafas contadas</span></div>
        </div>
        {phases.map((s, i) => {
          const l = byPhase[s]; const st = l[0].s; const en = Math.max(...l.map((e) => e.e == null ? e.s : e.e));
          const wait = prevEnd != null && st - prevEnd > 20 ? st - prevEnd : 0; prevEnd = Math.max(prevEnd || 0, en);
          const m = isMach(l[0]); const flow = l[0].flow === 'pnp' ? 'pnp' : 'production';
          const people = [...new Set(l.map((e) => (e.person || '').split(' ')[0]))].join(', ');
          const isOpen = !!open[s];
          return (
            <React.Fragment key={s}>
              {wait > 0 && <div className="bj-wait">espera de {L.fmtDurShort(wait)} entre fases</div>}
              <div className={`bj-ph flow-${flow} ${isOpen ? 'open' : ''}`}>
                <div className="h" onClick={() => setOpen((o) => ({ ...o, [s]: !o[s] }))}>
                  <div className="no">{i + 1}</div>
                  <div className="n">{l[0].activity || s}{m ? ' (máquina)' : ''}<small>{people} · {nyStamp(l[0].started_at, true)} → {l.every((e) => e.e != null) ? nyStamp(l[l.length - 1].ended_at, true) : 'em andamento'}</small></div>
                  <div className="v">{L.fmtDurShort(l.reduce((a, e) => a + span(e), 0))}<small>parede {L.fmtDurShort(en - st)} · {l.length} reg.</small></div>
                  <div className="car">▶</div>
                </div>
                <div className="body">
                  {l.map((e) => (<div key={e.id} className="e"><div><b>{e.person}</b> · {nyStamp(e.started_at, true)} → {e.e == null ? 'aberto' : nyStamp(e.ended_at)}{e.quantity ? ` · ${e.quantity} ${e.quantity_unit || ''}` : ''}{e.total_paused_seconds ? ` · pausa ${Math.round(e.total_paused_seconds / 60)}m` : ''}</div><span>{e.e == null ? '…' : L.fmtDurShort(span(e))}</span></div>))}
                </div>
              </div>
            </React.Fragment>
          );
        })}
        {counts && counts.length > 0 && (
          <div className="bj-ph open"><div className="h"><div className="no">#</div><div className="n">Garrafas contadas<small>{counts.length} contagem{counts.length > 1 ? 'ns' : ''}</small></div><div className="v">{bottles}</div><div className="car"/></div>
            <div className="body">{counts.map((c) => (<div key={c.id} className="e"><div><b>{c.person || '?'}</b> · {nyStamp(c.reported_at, true)}{c.kind && c.kind !== 'production' ? ' · ' + c.kind : ''}</div><span>{c.bottles}</span></div>))}</div>
          </div>
        )}
      </>
    );
  }
  return (
    <div className="bj-drawer on" data-batch-journey={batchId} onMouseDown={(e) => e.stopPropagation()}>
      <button className="bj-x" onClick={onClose} aria-label="Fechar" title="Fechar (Esc)">✕</button>
      {body}
    </div>
  );
}
