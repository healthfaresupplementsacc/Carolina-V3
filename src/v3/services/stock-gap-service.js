'use strict';
/**
 * HEALTHFARE V3 — stock-gap-service (Bruno 08-06)
 *
 * Cruza o que a picklist PRECISA hoje com o estoque (Veeqo) e com o EMS, e diz
 * O QUE FAZER pra cada produto sem estoque / com estoque baixo.
 *
 * Regras do Bruno:
 *  - sem estoque OU baixo → olhar o EMS:
 *      • tem batch em `yield_review` (cápsulas prontas, aguardando revisão)
 *        → "temos cápsulas prontas, dá pra fazer na mão e liberar hoje?"
 *      • está passando na linha agora (weighing/weighed/pending)
 *        → "está na linha, dá pra esperar?"
 *      • passou recentemente (finalized)
 *        → "já passou na linha, temos aqui no estoque? dá pra preencher?"
 *      • nada disso → VERMELHO: "sem estoque e sem produção, precisa resolver já"
 *  - "baixo" = estoque menor que o necessário pra hoje, ou <= LOW_THRESHOLD.
 */
// "baixo" = estoque <= 25 garrafas OU menos do que a picklist precisa hoje.
// (Bruno 08-06: precisa avisar ANTES de zerar, com tempo de reagir.)
const LOW_THRESHOLD = 25;

const norm = (s) => String(s || '').toLowerCase()
  .replace(/healthfare|healtfare/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// palavras que não ajudam a identificar o produto.
// ATENÇÃO (Bruno 08-07): C2/C3/C4 NÃO entram aqui — casepack é OUTRO produto.
const STOP = new Set(['mg', 'mcg', 'g', 'iu', 'caps', 'capsules', 'tablets', 'tabs', 'softgels',
  'count', 'ct', 'veg', 'vegan', 'with', 'and', 'the', 'extract', 'complex',
  'hcl', 'pack', 'bottles', 'bottle']);
const tokens = (s) => norm(s).split(' ').filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t));

/** Sufixo de casepack ('c2','c3','c4'…) ou null se for o produto base. */
function casepackOf(s) {
  const m = norm(s).match(/\bc(\d+)\b/);
  return m ? 'c' + m[1] : null;
}

/** casa nome do EMS com nome do nosso produto.
 *  Aceita se todas as palavras significativas do menor estiverem no maior
 *  (ex.: "Berberine 6000mg" casa com "Berberine HCl 6000mg with Ceylon Cinnamon"),
 *  ou se compartilharem 2+ palavras fortes. */
function nameMatches(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  // CASEPACK É OUTRO PRODUTO (Bruno 08-07): base ≠ C2 ≠ C3 ≠ C4. Nunca casar.
  if (casepackOf(a) !== casepackOf(b)) return false;
  if (x === y) return true;
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  // SEGURANÇA: o nome do produto (1ª palavra forte) tem que bater nos dois lados.
  // Sem isso "Magnesium Citrate" casaria com "Magnesium Oxide" e o sistema
  // recomendaria o batch ERRADO. Só a 1ª palavra igual não basta: exige que TODAS
  // as palavras do menor estejam no maior.
  if (ta[0] !== tb[0]) return false;
  const small = ta.length <= tb.length ? ta : tb;
  const big = new Set(ta.length <= tb.length ? tb : ta);
  return small.every((t) => big.has(t));
}

class StockGapService {
  constructor(deps = {}) {
    this.db = deps.db;
    this.ems = deps.ems || null;
    this.lowThreshold = deps.lowThreshold != null ? deps.lowThreshold : LOW_THRESHOLD;
  }

  /** Estágios do EMS agrupados por produto.
   *  O /pipeline do EMS não traz SKU (só nome) — então buscamos o SKU no
   *  /products do EMS pelo nome e anexamos, pra poder casar por SKU
   *  (fonte da verdade, Bruno 08-07) em vez de só por nome. */
  async emsByProduct() {
    if (!this.ems || !this.ems.configured || !this.ems.configured()) return [];
    let p;
    try { p = await this.ems.pipeline(); } catch (e) { return []; }
    // mapa nome-do-produto -> internal_sku (do catálogo do EMS)
    const skuByName = new Map();
    try {
      const prods = await this.ems.products();
      const list = Array.isArray(prods) ? prods : (prods.products || prods.items || prods.data || []);
      list.forEach((x) => {
        const nm = norm(x.name || x.product_name);
        const sku = x.internal_sku || x.sku;
        if (nm && sku) skuByName.set(nm, String(sku).trim().toUpperCase());
      });
    } catch (_) { /* sem catálogo: cai no nome */ }
    const out = [];
    const push = (arr, kind) => (arr || []).forEach((b) => {
      const product = (b.product && b.product.name) || (b.formula && b.formula.name) || '';
      out.push({
        kind, product,
        sku: skuByName.get(norm(product)) || null,
        batch: b.batch_record_number || null,
        qty: b.actual_yield_bottles || b.target_qty_bottles || null,
        at: b.finalized_at || b.completed_at || b.updated_at || b.created_at || null,
      });
    });
    push(p.pending_queue, 'queue');                                        // na fila
    push(p.formulation && p.formulation.weighing, 'line');                 // pesando
    push(p.formulation && p.formulation.weighed, 'line');                  // pesado
    push(p.production_line && p.production_line.yield_review, 'capsules'); // CÁPSULAS PRONTAS
    push(p.production_line && p.production_line.finalized, 'finalized');   // já passou
    return out;
  }

  /**
   * Analisa a picklist do dia.
   * @returns {object} { items: [...], out_count, low_count, critical_count }
   */
  async analyze(picklist) {
    const groups = (picklist && picklist.groups) || [];
    if (!groups.length) return { items: [], out_count: 0, low_count: 0, critical_count: 0 };

    // estoque Veeqo por produto (o que já temos na visão de estoque)
    const stock = new Map();
    try {
      const r = await this.db.query(`
        SELECT ps.product_id, p.canonical_name,
               COALESCE(MAX(sv.veeqo_stock), 0) AS veeqo_stock
          FROM v3.product_skus ps
          JOIN v3.products p ON p.id = ps.product_id
          LEFT JOIN LATERAL (SELECT 0 AS veeqo_stock) sv ON true
         GROUP BY ps.product_id, p.canonical_name`);
      r.rows.forEach((x) => stock.set(x.product_id, x));
    } catch (_) { /* estoque vem do picklist/veeqo abaixo */ }

    const ems = await this.emsByProduct();
    const items = [];

    for (const g of groups) {
      const need = (g.orders || []).reduce((n, o) => n + (Number(o.bottles) || 0), 0);
      const have = g.veeqo_stock != null ? Number(g.veeqo_stock) : null;
      if (have == null) continue;                       // sem dado de estoque: não inventa
      const isOut = have <= 0;
      const isLow = !isOut && (have < need || have <= this.lowThreshold);
      if (!isOut && !isLow) continue;

      const name = g.product || g.nickname || g.sku;
      // SKU é a fonte da verdade (Bruno 08-07): casa por SKU quando o EMS tiver;
      // nome é fallback e já bloqueia casepack diferente (base ≠ C2 ≠ C4).
      const mySku = String(g.sku || '').trim().toUpperCase();
      const bySku = mySku ? ems.filter((e) => e.sku && e.sku === mySku) : [];
      const hits = bySku.length ? bySku : ems.filter((e) => nameMatches(e.product, name));
      const capsules = hits.find((e) => e.kind === 'capsules');
      const onLine = hits.find((e) => e.kind === 'line');
      const queued = hits.find((e) => e.kind === 'queue');
      const done = hits.find((e) => e.kind === 'finalized');

      let action, advice, severity;
      if (capsules) {
        action = 'capsules_ready'; severity = 'warn';
        advice = 'Temos cápsulas prontas (' + capsules.batch + (capsules.qty ? ', ' + capsules.qty + ' garrafas' : '')
          + ') aguardando revisão. Podemos fazer esses na mão e já liberar hoje?';
      } else if (onLine) {
        action = 'on_line'; severity = 'warn';
        advice = 'Está passando na linha agora (' + onLine.batch + '). Dá pra esperar sair hoje?';
      } else if (done) {
        action = 'recently_made'; severity = 'warn';
        advice = 'Já passou na linha (' + done.batch + (done.at ? ', ' + String(done.at).slice(0, 10) : '')
          + '). Temos aqui no estoque? Dá pra preencher essas ordens?';
      } else if (queued) {
        action = 'queued'; severity = 'warn';
        advice = 'Está na fila de produção (' + queued.batch + '), ainda não começou.';
      } else if (isOut) {
        action = 'no_production'; severity = 'critical';
        advice = 'ZERADO e sem nada em produção. Precisamos resolver o que fazer o mais rápido possível.';
      } else {
        action = 'no_production'; severity = 'warn';
        advice = 'Estoque baixo (' + have + ') e nada em produção. Vale programar antes de zerar.';
      }

      items.push({
        product_id: g.product_id || null, sku: g.sku, product: name, nickname: g.nickname,
        needed: need, stock: have, status: isOut ? 'out' : 'low',
        action, advice, severity,
        ems_batch: (capsules || onLine || done || queued || {}).batch || null,
      });
    }

    items.sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1)
      || (a.status === 'out' ? -1 : 1) - (b.status === 'out' ? -1 : 1));
    return {
      items,
      out_count: items.filter((x) => x.status === 'out').length,
      low_count: items.filter((x) => x.status === 'low').length,
      critical_count: items.filter((x) => x.severity === 'critical').length,
    };
  }
}

module.exports = { StockGapService, nameMatches };
