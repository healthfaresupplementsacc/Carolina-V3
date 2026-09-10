import React from 'react';
import L from './timeline-layout.cjs';

/* FlowHistory — três cartões (Produção · P&P · Suporte) em cima da linha do
   tempo com os números de relance; clique abre o histórico do dia daquele
   fluxo (Bruno 09-10: "todas as funções deveriam ter como ver o histórico...
   P&P: tempo de demora de cada pessoa, que horas imprimiu; expand nas
   impressões aparece os produtos"). Só leitura; dados que a página já tem. */

export function FlowHistory({ events, operators, activities, products, now, pp, lotes, onOpenBatch, fmtClock }) {
  const [open, setOpen] = React.useState(null);
  const eff = (e) => (e.ended_min == null ? now : e.ended_min);
  const nameOf = (opId) => (operators.find((o) => o.id === opId) || {}).name || '?';
  const flowOf = (e) => { const a = activities[e.activity]; if (L.RAIL_SLUGS.has(e.activity) && (!a || a.flow !== 'pnp')) return 'production'; return (a && a.flow) || 'support'; };
  const work = (list) => list.reduce((a, e) => a + Math.max(0, eff(e) - e.started_min), 0);
  const evs = events.filter((e) => e.started_min != null);
  const prod = evs.filter((e) => flowOf(e) === 'production' && !L.isNeutral(e));
  const pnp = evs.filter((e) => flowOf(e) === 'pnp');
  const sup = evs.filter((e) => flowOf(e) === 'support' && !L.isNeutral(e));
  const batchesTouched = [...new Set(prod.map((e) => e.product).filter(Boolean))];
  const lineBatches = [...new Set(prod.filter((e) => e.activity === 'production_line').map((e) => e.product).filter(Boolean))];
  const ppOrders = pp && pp.orders != null ? pp.orders : null;
  const ppSec = pp && pp.total_seconds != null ? pp.total_seconds : null;
  const cards = [
    { key: 'production', cls: 'flow-production', title: 'Produção', sub: `${batchesTouched.length} lote${batchesTouched.length === 1 ? '' : 's'} tocado${batchesTouched.length === 1 ? '' : 's'}`, k: [['tempo de gente', L.fmtDurShort(work(prod.filter((e) => !L.isRail(e))))], ['máquina', L.fmtDurShort(work(prod.filter(L.isRail)))], ['lotes na linha', lineBatches.length]] },
    { key: 'pnp', cls: 'flow-pnp', title: 'P&P', sub: ppOrders != null ? `${ppOrders} ordens` : `${pnp.length} registros`, k: [['tempo', ppSec != null ? L.fmtDurShort(ppSec / 60) : L.fmtDurShort(work(pnp))], ['por ordem', pp && pp.seconds_per_order != null ? pp.seconds_per_order + ' s' : '—'], ['pessoas', [...new Set(pnp.map((e) => e.op))].length]] },
    { key: 'support', cls: 'flow-support', title: 'Suporte', sub: `${sup.length} registros`, k: [['tempo', L.fmtDurShort(work(sup))], ['limpeza', L.fmtDurShort(work(sup.filter((e) => e.activity === 'cleaning')))], ['estoque', L.fmtDurShort(work(sup.filter((e) => e.activity === 'stock_organization')))]] },
  ];
  const Row = ({ n, d, v, sub, onClick }) => (<div className={`fh-row ${sub ? 'sub' : ''} ${onClick ? 'click' : ''}`} onClick={onClick}><div className="n">{n}</div><div className="d">{d}</div><div className="v">{v}</div></div>);
  let hist = null;
  if (open === 'pnp') {
    const printing = pnp.filter((e) => e.activity === 'order_printing' || e.activity === 'order_printing_2').sort((a, b) => a.started_min - b.started_min);
    const packing = pnp.filter((e) => e.activity === 'packaging').sort((a, b) => a.started_min - b.started_min);
    const labels = evs.filter((e) => e.activity === 'label_printing');
    hist = (
      <>
        <h4>P&P de hoje <span>{ppOrders != null ? `${ppOrders} ordens · ` : ''}{ppSec != null ? L.fmtDurShort(ppSec / 60) : L.fmtDurShort(work(pnp))}{pp && pp.seconds_per_order != null ? ` · ${pp.seconds_per_order} s por ordem` : ''}</span></h4>
        {(pp && pp.orders_inputs || []).map((o, i) => <Row key={'oi' + i} n="Ordens informadas" d={`${o.person} · ${o.activity_name} às ${o.at}${o.adjustment_kind ? ' · ' + o.adjustment_kind : ''}`} v={`${o.qty} ordens`}/>)}
        {printing.map((e) => <Row key={e.id} n={activities[e.activity]?.name || e.activity} d={`${nameOf(e.op)} · ${fmtClock(e.started_min)} → ${e.ended_min == null ? 'agora' : fmtClock(e.ended_min)}${e.qty ? ' · ' + e.qty + ' ordens' : ''}`} v={L.fmtDurShort(eff(e) - e.started_min)}/>)}
        {packing.length > 0 && <Row n="Empacotamento" d={`${packing.length} registro${packing.length > 1 ? 's' : ''} · ${[...new Set(packing.map((e) => nameOf(e.op)))].join(', ')}`} v={L.fmtDurShort(work(packing))}/>}
        {packing.map((e) => <Row key={e.id} sub n={nameOf(e.op)} d={`${fmtClock(e.started_min)} → ${e.ended_min == null ? 'agora' : fmtClock(e.ended_min)}`} v={L.fmtDurShort(eff(e) - e.started_min)}/>)}
        {(pp && pp.person_seconds || []).map((ps) => <Row key={ps.person} n="Tempo por pessoa" d={ps.person} v={L.fmtDurShort(ps.seconds / 60)}/>)}
        {labels.length > 0 && <Row n="Impressão de labels (produção)" d={`${labels.length} rodada${labels.length > 1 ? 's' : ''} · ${[...new Set(labels.map((e) => e.product && products[e.product]?.name).filter(Boolean))].join(', ')}`} v={L.fmtDurShort(work(labels))}/>}
      </>
    );
  } else if (open === 'production') {
    const byB = {}; for (const e of prod) if (e.product) (byB[e.product] = byB[e.product] || []).push(e);
    hist = (
      <>
        <h4>Produção de hoje, por lote <span>clique num lote pra ver a jornada inteira</span></h4>
        {Object.keys(byB).map((k) => { const l = byB[k]; const p = products[k] || {}; const phases = [...new Set(l.map((e) => e.activity))].map((s) => L.shortName(s, activities[s]?.name)).join(' → '); return <Row key={k} n={p.name || k} d={`${p.batch || ''} · ${phases} · ${[...new Set(l.map((e) => nameOf(e.op).split(' ')[0]))].join(', ')}`} v={L.fmtDurShort(work(l))} onClick={() => onOpenBatch && onOpenBatch(k)}/>; })}
        {Object.keys(byB).length === 0 && <div className="fh-empty">sem lote tocado hoje</div>}
      </>
    );
  } else if (open === 'support') {
    const byS = {}; for (const e of sup) (byS[e.activity] = byS[e.activity] || []).push(e);
    const lunch = evs.filter((e) => e.activity === 'lunch');
    hist = (
      <>
        <h4>Suporte de hoje <span>o que não é produção nem P&P</span></h4>
        {Object.keys(byS).map((k) => { const l = byS[k]; return (<React.Fragment key={k}><Row n={activities[k]?.name || k} d={`${[...new Set(l.map((e) => nameOf(e.op).split(' ')[0]))].join(', ')} · ${l.length} registro${l.length > 1 ? 's' : ''}`} v={L.fmtDurShort(work(l))}/>{l.map((e) => <Row key={e.id} sub n={nameOf(e.op)} d={`${fmtClock(e.started_min)} → ${e.ended_min == null ? 'agora' : fmtClock(e.ended_min)}`} v={L.fmtDurShort(eff(e) - e.started_min)}/>)}</React.Fragment>); })}
        {lunch.length > 0 && <Row n="Almoço (fora do tempo de trabalho)" d={lunch.map((e) => nameOf(e.op).split(' ')[0] + ' ' + L.fmtDurShort(eff(e) - e.started_min)).join(' · ')} v={L.fmtDurShort(work(lunch))}/>}
      </>
    );
  }
  return (
    <div className="fh" data-flow-history>
      <div className="fh-cards">
        {cards.map((c) => (
          <div key={c.key} className={`fh-card ${c.cls} ${open === c.key ? 'on' : ''}`} onClick={() => setOpen(open === c.key ? null : c.key)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpen(open === c.key ? null : c.key); }}>
            <div className="t"><b>{c.title}</b><span>{c.sub}</span></div>
            <div className="k">{c.k.map(([l, v]) => (<div key={l}><b>{v}</b>{l}</div>))}</div>
            <div className="x">{open === c.key ? 'fechar histórico' : 'ver histórico do dia ›'}</div>
          </div>
        ))}
      </div>
      {hist && <div className="fh-hist">{hist}</div>}
    </div>
  );
}
