'use strict';
/**
 * HEALTHFARE V3 — days_of_stock UNIFICADO no interino (Bruno 09-04).
 *
 * Duas definições coexistiam (MASTER-SYNC-PLAN, conflito 7 / decisão D-6):
 *   hub:     disponível do ARMAZÉM ÷ (sold_7d ÷ 7)      — StockService._buildRow
 *   planner: (armazém + marketplace) ÷ média de 14 dias — src/workers/stock-alerts.js
 *
 * Bruno resolveu o interino: "continuamos nos baseando no stock da veeqo"
 * enquanto o armazém físico não é carregado. Então, UMA definição, rotulada:
 *
 *   armazém NÃO carregado (total global = 0) → o hub mostra a conta do planner
 *     sobre o estoque Veeqo (velocidade 14d DELEGADA ao PlanningModel, o mesmo
 *     cérebro do worker — nunca re-derivada) e a linha sai com days_source='veeqo';
 *   primeira garrafa carregada → volta SOZINHO pra conta do armazém
 *     (days_source='warehouse'), o mesmo auto-switch do modo quieto do
 *     stock-drift-alert: nada de flag, o dado decide.
 *
 * Só leitura. Nenhuma escrita de quantidade acontece aqui (StockService é o
 * único escritor).
 */
const { createPlanningModel } = require('../planning/model');

/**
 * Velocidade de venda (unidades-garrafa/dia, média 14d) por produto, das linhas
 * shipped. NÃO re-deriva: delega pro cérebro do planner
 * (src/v3/planning/model.js, o mesmo que o worker stock-alerts usa) — a conta
 * do hub interino e a do alerta são LITERALMENTE a mesma query.
 * @returns {Promise<Map<number,{perDay:number,daysSeen:number}>>}
 */
async function velocityByProduct(db) {
  return createPlanningModel({ db })._velocityByProduct();
}

/**
 * Total físico global do armazém (bins + caixas + a organizar) — a MESMA conta
 * do modo quieto do stock-drift-alert. null = query falhou (fail-open: quem
 * chama trata como carregado e mantém o número do armazém).
 */
async function warehouseTotal(db) {
  try {
    const r = await db.query(
      `SELECT COALESCE((SELECT SUM(qty) FROM v3.stock_bins WHERE active), 0)
            + COALESCE((SELECT SUM(qty) FROM v3.stock_boxes WHERE status = 'in_storage'), 0)
            + COALESCE((SELECT SUM(qty) FROM v3.stock_unplaced), 0) AS total`);
    const t = r.rows[0] && r.rows[0].total;
    return t == null ? null : Number(t);
  } catch (_) { return null; }
}

/**
 * A conta do planner com armazém zerado: totalQty = 0 + veeqo.
 * veeqoQty null (Veeqo 'unknown' pro SKU base) → null, nunca um número
 * inventado. Sem velocidade → null (dividir por zero viraria "infinito").
 */
function interimDays(veeqoQty, perDay) {
  if (veeqoQty == null || !Number.isFinite(Number(veeqoQty))) return null;
  if (!(perDay > 0)) return null;
  return Number((Math.max(0, Number(veeqoQty)) / perDay).toFixed(1));
}

/**
 * Aplica a definição interina nas Rows JÁ enriquecidas (precisa de veeqo_total,
 * que o router preenche do cache Veeqo). Sempre rotula: days_source =
 * 'warehouse' | 'veeqo'. Muta as rows (mesmo contrato do enrich) e devolve.
 */
async function applyInterimDays(rows, db) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const total = await warehouseTotal(db);
  const loaded = total == null ? true : total > 0;   // fail-open = comporta como carregado
  if (loaded) {
    for (const r of rows) r.days_source = 'warehouse';
    return rows;
  }
  let velo = new Map();
  try { velo = await velocityByProduct(db); } catch (_) { /* sem velocidade → dias null */ }
  for (const r of rows) {
    const v = velo.get(r.product_id);
    const d = interimDays(r.veeqo_total, v ? v.perDay : 0);
    r.days_of_stock = d;
    r.days_cover = d;          // alias antigo do mesmo número (compat)
    r.days_source = 'veeqo';
  }
  return rows;
}

module.exports = { velocityByProduct, warehouseTotal, interimDays, applyInterimDays };
