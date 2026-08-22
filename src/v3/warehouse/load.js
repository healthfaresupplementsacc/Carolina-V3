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
  async function load(body = {}, ctx = {}) {
    const productId = intOf(body.product_id);
    if (!productId || productId <= 0) throw new Error('product_id inválido');
    const qty = intOf(body.qty);
    if (!qty || qty < 1 || qty > QTY_MAX) {
      throw new Error(`qty inválido (inteiro de 1 a ${QTY_MAX})`);
    }
    const dest = body.dest || {};
    const kind = dest.kind;
    if (!['bin', 'box', 'unplaced'].includes(kind)) {
      throw new Error('dest.kind inválido (bin, box ou unplaced)');
    }
    const destId = intOf(dest.id);
    if (kind !== 'unplaced' && (!destId || destId <= 0)) {
      throw new Error('dest.id obrigatório quando o destino é bin ou caixa');
    }
    const source = String(body.source || '');
    if (!SOURCES.includes(source)) {
      throw new Error('source inválido (' + SOURCES.join(', ') + ')');
    }
    const clientRef = String(body.client_ref || '').trim();
    if (!UUID_RE.test(clientRef)) {
      throw new Error('client_ref inválido (uuid, é a idempotência do clique)');
    }

    const ref = 'load:' + clientRef.toLowerCase();
    const who = ctx.login || 'admin';
    const meta = body.meta && typeof body.meta === 'object' ? body.meta : null;
    const weighBit = meta && meta.gross_g != null
      ? ` (bruto ${meta.gross_g}g, tara ${meta.tare_g != null ? meta.tare_g : '?'}g)` : '';
    const note = `[${who}] carga: ${SOURCE_PT[source]}${weighBit}`;

    // 1) entra no armazém (bucket "a organizar") — idempotente por client_ref
    const stored = await stock.storeIn({
      product_id: productId, qty,
      person_id: ctx.person_id || null, actor_type: 'admin',
      source: 'warehouse_load', source_ref: ref, note,
    });

    // 2) destino bin/caixa: organiza até lá (ref próprio: o retry completa o
    //    que faltou sem duplicar o que já foi)
    if (kind !== 'unplaced') {
      await stock.place({
        product_id: productId, qty,
        bin_id: kind === 'bin' ? destId : null,
        box_id: kind === 'box' ? destId : null,
        person_id: ctx.person_id || null, actor_type: 'admin',
        source: 'warehouse_load', source_ref: ref + ':place', note,
      });
    }

    return {
      applied: stored.applied || 0,
      duplicate: !!stored.duplicate,
      product: await productSummary(productId),
    };
  }

  /**
   * O CABEÇALHO da página Montar em uma consulta barata: quanto do armazém já
   * está carregado e o que ainda falta calibrar. Os números de produto saem das
   * MESMAS Rows do hub (nenhuma conta paralela pra divergir um dia).
   */
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

  return { load, progress, productSummary };
}

module.exports = { createLoad, SOURCES, SOURCE_PT, QTY_MAX, UUID_RE };
