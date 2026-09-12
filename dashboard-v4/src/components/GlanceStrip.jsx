import React from 'react';
import { Icon } from './Icons.jsx';
import { FloatingPopover } from './FloatingPopover.jsx';
import { useGlance } from './glance-store.js';

/* ═══════════════════════════════════════════════════════════════════
   GLANCE — os números do dia na barra do topo (Bruno 09-12).

   Fica logo depois do PONTO (quem está trabalhando). Um chip por widget da
   Hoje, só com o número que importa: 420 garrafas · 34 ordens · 30 pedidos ·
   120 labels · 2/2 metas · 4.2 cáps/s. Clicou → abre o widget INTEIRO num
   popover (o mesmo JSX que a grade desenhava, sem duplicar nada).

   Tela estreita: vira uma pill "Números" que abre a lista, igual ao Ponto.
   Fora da Hoje não existe (o dado é do dia da Hoje).
   ═══════════════════════════════════════════════════════════════════ */

function Chip({ it, active, onOpen }) {
  return (
    <button type="button"
            className={`glance-chip ${it.tone ? 'glance-' + it.tone : ''} ${active ? 'active' : ''}`}
            data-glance={it.id}
            title={it.title || `${it.label}: clique pra ver tudo`}
            onClick={(e) => onOpen(it, e)}>
      {it.icon && <span className="glance-ico"><Icon name={it.icon} size={12}/></span>}
      <b className="glance-val mono">{it.value}</b>
      {it.unit && <span className="glance-unit">{it.unit}</span>}
      <span className="glance-lbl">{it.label}</span>
      {it.sub && <span className="glance-sub mono">{it.sub}</span>}
    </button>
  );
}

export function GlanceStrip({ pageId }) {
  const active = pageId === 'hoje';
  const items = useGlance();
  const [open, setOpen] = React.useState(null);        // id do chip aberto
  const [anchor, setAnchor] = React.useState(null);
  const [listOpen, setListOpen] = React.useState(false);

  React.useEffect(() => { if (!active) { setOpen(null); setListOpen(false); } }, [active]);

  if (!active || items.length === 0) return null;

  const onOpen = (it, e) => {
    setAnchor({ x: e.clientX, y: e.clientY });
    setOpen((cur) => (cur === it.id ? null : it.id));
    setListOpen(false);
  };
  const cur = open ? items.find((x) => x.id === open) : null;

  return (
    <div className="glance-strip" data-glance-strip>
      <span className="glance-list">
        {items.map((it) => <Chip key={it.id} it={it} active={open === it.id} onOpen={onOpen}/>)}
      </span>

      {/* estreito: uma pill com a lista */}
      <button type="button" className="glance-collapsed" data-glance-collapsed
              aria-expanded={listOpen} onClick={() => setListOpen((v) => !v)}
              title="Números do dia">
        <Icon name="live" size={13}/> Números ({items.length})
      </button>
      {listOpen && (
        <>
          <div className="ponto-pop-back" onClick={() => setListOpen(false)}/>
          <div className="ponto-pop glance-pop-list" data-glance-pop-list>
            <div className="kit-mlabel" style={{ marginBottom: 8 }}>Números do dia</div>
            {items.map((it) => <Chip key={it.id} it={it} active={open === it.id} onOpen={onOpen}/>)}
          </div>
        </>
      )}

      {/* o widget inteiro, no clique */}
      <FloatingPopover open={!!cur} anchor={anchor} width={cur && cur.width ? cur.width : 440}
                       onClose={() => setOpen(null)}
                       anchorSelector={cur ? `[data-glance="${cur.id}"]` : undefined}
                       className="glance-pop"
                       header={cur ? (
                         <>
                           {cur.icon && <Icon name={cur.icon} size={14}/>}
                           <b style={{ flex: 1, fontSize: 12.5 }}>{cur.label}</b>
                           <button className="icon-btn" onClick={() => setOpen(null)} style={{ padding: 4, width: 26, height: 26 }} aria-label="Fechar">
                             <Icon name="x" size={11}/>
                           </button>
                         </>
                       ) : null}>
        <div className="glance-pop-body" data-glance-pop={cur ? cur.id : ''}>
          {cur && cur.render ? cur.render() : null}
        </div>
      </FloatingPopover>
    </div>
  );
}

export default GlanceStrip;
