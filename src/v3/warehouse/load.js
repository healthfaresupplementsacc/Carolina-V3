'use strict';
/**
 * HEALTHFARE V3 — Warehouse hub — PORTA DA CARGA (S15.44, Bruno 08-22).
 *
 * A carga inicial do estoque começa HOJE, e a página "Montar" usa UMA porta só:
 * POST /api/v3/warehouse/load. Todo caminho de entrada passa por aqui:
 *   count_manual       contou na mão e digitou
 *   count_weigh        pesou; o sistema calculou (meta leva a pesagem)
 *   production_direct  caixa no zero, garrafas vindo DIRETO da produção pra prateleira
 *   loose_fixed        garrafas soltas pelo armazém, label consertada, entram no estoque
 *
 * A porta COMPÕE verbos EXISTENTES do StockService (porta única de quantidade):
 * storeIn no "a organizar" e, quando o destino é bin/caixa, place até lá. NUNCA
 * SQL cru em tabela de estoque. Idempotente por client_ref (uuid): clique duplo
 * ou retry usa o MESMO source_ref e o StockService recusa a repetição sozinho.
 * O retry também COMPLETA carga pela metade: storeIn que já passou volta como
 * duplicado (applied 0) e o place, com ref próprio, aplica o que faltou.
 *
 * O alvo da carga é o TOTAL DA VEEQO por produto: cada resposta volta com
 * veeqo_match pro check verde "bate com a Veeqo". Diferença é AVISO
 * ("conferir/ajustar"), nunca bloqueio (RULE #0).
 */

const SOURCES = ['count_manual', 'count_weigh', 'production_direct', 'loose_fixed'];
const SOURCE_PT = {
  count_manual: 'contagem na mão',
  count_weigh: 'contagem por peso',
  production_direct: 'direto da produção',
  loose_fixed: 'garrafas soltas, label consertada',
};
const QTY_MAX = 20000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const intOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

/**
 * @param {object} deps
 *   deps.db            pool pg (só leitura de contadores; quantidade é StockService)
 *   deps.stock         StockService (a ÚNICA escrita de quantidade)
 *   deps.boxTypes      BoxTypesRepo (avisos de re-pesagem)
 *   deps.rowsWithVeeqo (productId|null) → Rows enriquecidas (mesmas do hub)
 */
function createLoad(deps = {}) {
  const { db, stock, boxTypes, rowsWithVeeqo } = deps;

  /** O resumo que TODA resposta da carga devolve: os números + o check da Veeqo. */
  async function productSummary(productId) {
    const rows = await rowsWithVeeqo(Number(productId));
    const r = rows[0];
    if (!r) return null;
    const veeqoTotal = r.veeqo_total != null ? Number(r.veeqo_total) : null;
    return {
      product_id: r.product_id,
      total: Number(r.total) || 0,
      shelf_qty: Number(r.shelf_qty) || 0,
      box_qty: Number(r.box_qty) || 0,
      unplaced_qty: Number(r.unplaced_qty) || 0,
      veeqo_total: veeqoTotal,
      veeqo_match: veeqoTotal != null && (Number(r.total) || 0) === veeqoTotal,
    };
  }

  /**
   * A porta. body: {product_id, qty (1..20000), dest:{kind:'bin'|'box'|'unplaced',
   * id?}, source, meta? (detalhe da pesagem), client_ref (uuid)}.
   * ctx: {person_id, login} de quem está logado.
   * @returns {{applied, duplicate, product}}
   */
  // A função load() (que SOMAVA o contado ao local) FOI REMOVIDA na Fase A
  // (Bruno 09-10, "nunca duplicar"): contar a mesma caixa duas vezes entrava duas
  // vezes. O que DEFINE o absoluto ficou: /simple/set (escopo) e /product/:id/count
  // (local). Este módulo só guarda os contadores do cabeçalho e as constantes.

  async function progress() {
    const [rows, counts, recal] = await Promise.all([
      rowsWithVeeqo(null),
      db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM v3.products p
            WHERE p.active AND p.kind = 'bottle'
              AND p.merged_into_product_id IS NULL)                    AS products_total,
          (SELECT COUNT(*)::int FROM v3.products p
            WHERE p.active AND p.kind = 'bottle'
              AND p.merged_into_product_id IS NULL
              AND p.unit_weight_g IS NOT NULL)                         AS products_with_weight,
          (SELECT COUNT(*)::int FROM v3.stock_bins WHERE active)       AS bins_count,
          (SELECT COUNT(*)::int FROM v3.box_types WHERE active)        AS box_types_count,
          (SELECT COUNT(*)::int FROM v3.stock_boxes
            WHERE status = 'in_storage')                               AS boxes_count`),
      boxTypes.recalibrationWarnings(),
    ]);
    const c = (counts.rows && counts.rows[0]) || {};
    const n = (v) => Number(v) || 0;
    return {
      products_total: n(c.products_total),
      products_with_weight: n(c.products_with_weight),
      bins_count: n(c.bins_count),
      box_types_count: n(c.box_types_count),
      boxes_count: n(c.boxes_count),
      bottles_loaded: rows.reduce((sum, r) => sum + (Number(r.total) || 0), 0),
      products_matching_veeqo: rows.filter((r) =>
        r.veeqo_total != null && (Number(r.total) || 0) === Number(r.veeqo_total)).length,
      products_with_any_stock: rows.filter((r) => (Number(r.total) || 0) > 0).length,
      recalibration_warnings: recal,
    };
  }

  return { progress, productSummary };
}

module.exports = { createLoad, SOURCES, SOURCE_PT, QTY_MAX, UUID_RE };
