/* Página "Picklist" (Bruno 08-04). Segue o HealthFare STYLE-KIT (Kinto editorial:
   ground com dot-grid, títulos DM Serif Display com uma palavra em itálico verde,
   micro-labels DM Mono, cards 18px, pill navy, chips tonais). REGRA: sem travessão
   (em dash) em texto de UI.
   Agrupa POR PRODUTO (ordem de caminhada por local), single primeiro / multi no fim,
   com divisória por produto (nickname grande + local + aviso multi-bottle).
   Fonte: /api/v3/data/picklist (pedidos pending). Imprime em 4×6 (print-to-PDF). */
import React from 'react';
import { usePoll } from '../adapters/from-api.js';

/* Esta página tinha a cópia inteira dos tokens do kit aqui dentro (era anterior
   ao kit.css global). Auditoria 08-19: token duplicado é token que envelhece
   sozinho, então ficou só o que é DESTA página (o layout do root, a divisória
   4x6 e as regras de impressão). Título, card, KPI, pill e chip agora são as
   classes do kit, iguais às do resto do dashboard.
   As classes .pl-* que sobraram não redeclaram cor: leem as variáveis do kit. */
const KIT = `
.pl-root{ font-family:var(--font); color:var(--ink); min-height:100%; padding:34px 30px 60px; }
.pl-mlabel{font:500 10px var(--font-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-faint)}
/* divisória de produto (a "label 4×6" grande) */
.pl-divider{border-radius:var(--r-lg);border:1px solid var(--line-strong);background:var(--kit-surface-2);padding:16px 18px;margin-top:22px;display:flex;flex-direction:column;gap:6px;break-inside:avoid}
.pl-divider .name{font-family:var(--font-display);font-size:26px;color:var(--primary-deep);line-height:1.05}
.pl-divider .loc{font:600 15px var(--font-mono);color:var(--primary);letter-spacing:.02em}
.pl-orders{margin-top:2px;border-top:1px solid var(--line)}
.pl-order{display:flex;align-items:center;gap:12px;padding:9px 14px;border-bottom:1px dotted var(--dotline)}
.pl-order:last-child{border-bottom:none}
.pl-order .onum{font:500 13px var(--font-mono);color:var(--ink);min-width:180px}
.pl-order .who{color:var(--ink-dim);font-size:12.5px;flex:1}
.pl-warn{margin-top:6px;font:600 12.5px var(--font);color:var(--warn-deep);background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:12px;padding:8px 12px}

/* IMPRESSÃO 4×6: cada produto começa em nova "página" de etiqueta */
@media print {
  @page { size: 4in 6in; margin: 0.18in; }
  .pl-noprint { display:none !important; }
  .pl-root { padding:0; background:#fff; background-image:none; }
  .pl-product { break-before: page; }
  .pl-product:first-of-type { break-before: avoid; }
  .pl-divider { box-shadow:none; }
}
`;

function loc(g) {
  const parts = [];
  if (g.location.shelf) parts.push('SHELF ' + g.location.shelf);
  if (g.location.bin) parts.push('BIN ' + g.location.bin);
  if (g.location.pallet) parts.push('PALLET ' + g.location.pallet);
  if (!parts.length && g.location.area) parts.push(g.location.area);
  return parts.join('  ·  ');
}

export function PicklistPage() {
  // poll a cada 15s: pega os nomes do cliente quando o refresh de fundo do Veeqo volta
  const pl = usePoll('/picklist', [], 15000);
  const d = pl.data || {};
  const groups = d.groups || [];

  return (
    <div className="pl-root">
      <style>{KIT}</style>

      {/* header */}
      <div className="pl-noprint" style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <span className="kit-eyebrow">● HEALTHFARE P&amp;P · PICKLIST</span>
          <h1 className="kit-h1">O que <em>separar hoje</em></h1>
          <p className="kit-sub">Pedidos pendentes, agrupados por produto na ordem de caminhada. Single primeiro, multi no fim.</p>
        </div>
        {/* Mesma palavra do botão da Central do operador (src/op/ws.js): lá é
            PRINT, aqui era "Imprimir / Baixar". Duas palavras pro mesmo botão
            faz o admin e o operador falarem línguas diferentes no telefone. */}
        <button className="kit-btn primary" data-act="print" onClick={() => window.print()}>PRINT (4×6)</button>
      </div>

      {/* KPIs */}
      <div className="pl-noprint" style={{ display: 'flex', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
        <div className="kit-card" style={{ padding: '14px 18px', minWidth: 130 }}>
          <div className="pl-mlabel">Pedidos</div><div className="kit-kpi">{d.total_orders ?? '—'}</div>
        </div>
        <div className="kit-card" style={{ padding: '14px 18px', minWidth: 130 }}>
          <div className="pl-mlabel">Garrafas</div><div className="kit-kpi">{d.total_bottles ?? '—'}</div>
        </div>
        <div className="kit-card" style={{ padding: '14px 18px', minWidth: 130 }}>
          <div className="pl-mlabel">Produtos</div><div className="kit-kpi">{d.product_count ?? '—'}</div>
        </div>
      </div>

      {pl.loading && <div className="kit-card" style={{ padding: 20, marginTop: 18, color: 'var(--ink-dim)' }}>Carregando picklist…</div>}
      {!pl.loading && groups.length === 0 && <div className="kit-card" style={{ padding: 20, marginTop: 18, color: 'var(--ink-dim)' }}>Nenhum pedido pendente pra separar agora.</div>}

      {/* grupos por produto */}
      {groups.map((g) => {
        const location = loc(g);
        return (
          <div key={g.key} className="pl-product">
            <div className="pl-divider">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span className="name">{g.nickname}</span>
                {!g.mapped && <span className="kit-chip warn">SKU não mapeado</span>}
                <span style={{ flex: 1 }} />
                <span className="kit-chip neutral">{g.order_count} pedido{g.order_count !== 1 ? 's' : ''}</span>
              </div>
              <div className="loc" style={location ? undefined : { color: 'var(--ink-faint)', fontWeight: 400 }}>
                {location || 'local a definir'}
              </div>
              {g.multi_count > 0 && (
                <div className="pl-warn">
                  NO FIM · {g.multi_summary.map((m) => `${m.orders} ${m.orders !== 1 ? 'pedidos' : 'pedido'} de ${m.bottles} garrafas`).join('  ·  ')}
                </div>
              )}
            </div>
            <div className="pl-orders">
              {g.orders.map((o, i) => (
                <div key={o.order_number + i} className="pl-order" style={o.multi ? { background: 'var(--warn-bg)' } : undefined}>
                  <span className="onum">{o.order_number}</span>
                  <span className="who">{o.patient
                    ? <b style={{ color: 'var(--ink)', fontWeight: 600 }}>{o.patient}</b>
                    : <span style={{ color: 'var(--ink-faint)', fontStyle: 'italic' }}>{d.names_loading ? 'carregando nome…' : 'sem nome'}</span>}</span>
                  <span className="kit-chip neutral">{o.channel}</span>
                  {o.multi
                    ? <span className="kit-chip warn">{o.bottles} garrafas</span>
                    : <span className="kit-chip ok">1 garrafa</span>}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
