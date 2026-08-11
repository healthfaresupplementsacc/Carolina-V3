'use strict';
/**
 * HEALTHFARE V3 — Centro de Estoque — leitura (Bruno 08-01)
 * Repos de leitura sobre as tabelas 058/059/060. Só SELECT — escrita é
 * exclusiva do StockService (porta única).
 */
const { resolveDate } = require('./ny-date');

class StockRepo {
  constructor(deps = {}) { this.db = deps.db; }

  /** Bins ativos com produto e status de restock. */
  async bins() {
    const r = await this.db.query(`
      SELECT b.id, b.bin_code, b.shelf_code, b.area, b.qty, b.min_qty, b.active,
             b.product_id, p.canonical_name AS product,
             (b.qty <= b.min_qty AND b.min_qty > 0) AS needs_restock
        FROM v3.stock_bins b
        LEFT JOIN v3.products p ON p.id = b.product_id
       WHERE b.active
       ORDER BY b.bin_code`);
    return r.rows;
  }

  /** Caixas em estoque (e vazias recentes, pra conferência). */
  async boxes() {
    const r = await this.db.query(`
      SELECT x.id, x.box_number, x.area, x.qty, x.status,
             x.product_id, p.canonical_name AS product, x.created_at
        FROM v3.stock_boxes x
        LEFT JOIN v3.products p ON p.id = x.product_id
       WHERE x.status = 'in_storage'
          OR (x.status = 'empty' AND x.updated_at > NOW() - INTERVAL '7 days')
       ORDER BY x.status, x.box_number`);
    return r.rows;
  }

  /** Estoque do armazém por produto (bins + caixas). */
  async summary() {
    const r = await this.db.query(`
      SELECT p.id AS product_id, p.canonical_name AS product,
             COALESCE(b.q, 0)::int AS bin_qty,
             COALESCE(x.q, 0)::int AS box_qty,
             (COALESCE(b.q, 0) + COALESCE(x.q, 0))::int AS total_qty,
             COALESCE(b.bins, 0)::int AS bins,
             COALESCE(x.boxes, 0)::int AS boxes
        FROM v3.products p
        LEFT JOIN (SELECT product_id, SUM(qty) q, COUNT(*) bins FROM v3.stock_bins
                    WHERE active GROUP BY product_id) b ON b.product_id = p.id
        LEFT JOIN (SELECT product_id, SUM(qty) q, COUNT(*) boxes FROM v3.stock_boxes
                    WHERE status = 'in_storage' GROUP BY product_id) x ON x.product_id = p.id
       WHERE COALESCE(b.q, 0) + COALESCE(x.q, 0) > 0 OR COALESCE(b.bins, 0) > 0
       ORDER BY p.canonical_name`);
    return r.rows;
  }

  /** Garrafas separadas ("garrafa com problema") — abertas + resolvidas recentes. */
  async issues() {
    const r = await this.db.query(`
      SELECT i.id, i.qty, i.reason, i.status, i.note, i.created_at, i.resolved_at,
             p.canonical_name AS product, b.bin_code,
             pe.display_name AS person, pr.display_name AS resolved_by
        FROM v3.stock_issues i
        JOIN v3.products p ON p.id = i.product_id
        LEFT JOIN v3.stock_bins b ON b.id = i.bin_id
        LEFT JOIN v3.persons pe ON pe.id = i.person_id
        LEFT JOIN v3.persons pr ON pr.id = i.resolved_by_person_id
       WHERE i.is_test = false
         AND (i.status = 'separated' OR i.created_at > NOW() - INTERVAL '14 days')
       ORDER BY (i.status = 'separated') DESC, i.created_at DESC
       LIMIT 200`);
    return r.rows;
  }

  /** Movimentos recentes (auditoria/dashboard). */
  async movements({ limit = 100, product_id = null } = {}) {
    const r = await this.db.query(`
      SELECT m.id, m.kind, m.qty, m.source, m.source_ref, m.note, m.created_at,
             p.canonical_name AS product, b.bin_code, x.box_number,
             pe.display_name AS person
        FROM v3.stock_movements m
        LEFT JOIN v3.products p ON p.id = m.product_id
        LEFT JOIN v3.stock_bins b ON b.id = m.bin_id
        LEFT JOIN v3.stock_boxes x ON x.id = m.box_id
        LEFT JOIN v3.persons pe ON pe.id = m.person_id
       WHERE m.is_test = false AND ($2::int IS NULL OR m.product_id = $2)
       ORDER BY m.created_at DESC LIMIT $1`,
      [Math.min(Number(limit) || 100, 500), product_id]);
    return r.rows;
  }

  /**
   * Pick sheet do dia: linhas de pedido (pending/picklisted) agrupadas por
   * produto, maior volume primeiro, com localização (bin com mais qty; caixa
   * de fallback). "15 garrafas do BIN A03 · SHELF S2" — Bruno.
   */
  async picksheet(date) {
    const d = resolveDate(date);
    const r = await this.db.query(`
      WITH lines AS (
        SELECT l.product_id, l.sku,
               SUM(l.qty * COALESCE(ps.units_per_pack, 1))::int AS bottles,
               SUM(l.qty)::int AS units, COUNT(*)::int AS orders,
               array_agg(DISTINCT l.channel) AS channels
          FROM v3.pnp_order_lines l
          LEFT JOIN v3.product_skus ps ON ps.channel = l.source AND ps.sku = l.sku
         WHERE l.order_date = $1 AND l.status IN ('pending','picklisted')
         GROUP BY l.product_id, l.sku),
      best_bin AS (
        SELECT DISTINCT ON (product_id) product_id, id, bin_code, shelf_code, qty
          FROM v3.stock_bins WHERE active AND product_id IS NOT NULL
         ORDER BY product_id, qty DESC),
      best_box AS (
        SELECT DISTINCT ON (product_id) product_id, box_number, area, qty
          FROM v3.stock_boxes WHERE status = 'in_storage' AND product_id IS NOT NULL
         ORDER BY product_id, qty DESC)
      SELECT li.sku, li.bottles, li.units, li.orders, li.channels,
             li.product_id, p.canonical_name AS product,
             bb.bin_code, bb.shelf_code, bb.qty AS bin_qty,
             bx.box_number AS fallback_box, bx.area AS fallback_area, bx.qty AS box_qty,
             (li.product_id IS NULL) AS unmapped,
             (bb.qty IS NOT NULL AND bb.qty < li.bottles) AS bin_short
        FROM lines li
        LEFT JOIN v3.products p ON p.id = li.product_id
        LEFT JOIN best_bin bb ON bb.product_id = li.product_id
        LEFT JOIN best_box bx ON bx.product_id = li.product_id
       ORDER BY li.bottles DESC, p.canonical_name NULLS LAST`,
      [d]);
    const unmapped = r.rows.filter((x) => x.unmapped);
    return { date: d, items: r.rows, unmapped_count: unmapped.length };
  }

  /** Bins precisando de restock, com as caixas de onde reabastecer (FIFO). */
  async restockList() {
    const r = await this.db.query(`
      SELECT b.id AS bin_id, b.bin_code, b.shelf_code, b.qty, b.min_qty,
             b.product_id, p.canonical_name AS product,
             COALESCE(json_agg(json_build_object(
               'box_id', x.id, 'box_number', x.box_number, 'area', x.area, 'qty', x.qty)
               ORDER BY x.created_at) FILTER (WHERE x.id IS NOT NULL), '[]') AS boxes
        FROM v3.stock_bins b
        JOIN v3.products p ON p.id = b.product_id
        LEFT JOIN v3.stock_boxes x
          ON x.product_id = b.product_id AND x.status = 'in_storage'
       WHERE b.active AND b.min_qty > 0 AND b.qty <= b.min_qty
       GROUP BY b.id, b.bin_code, b.shelf_code, b.qty, b.min_qty, b.product_id, p.canonical_name
       ORDER BY (b.qty::numeric / NULLIF(b.min_qty, 0)) ASC`);
    return r.rows;
  }

  /** SKUs persistidos (mapa confirmado). */
  async skus() {
    const r = await this.db.query(`
      SELECT s.id, s.sku, s.channel, s.units_per_pack, s.barcode,
             s.product_id, p.canonical_name AS product,
             s.confirmed_at, pe.display_name AS confirmed_by
        FROM v3.product_skus s
        JOIN v3.products p ON p.id = s.product_id
        LEFT JOIN v3.persons pe ON pe.id = s.confirmed_by_person_id
       ORDER BY p.canonical_name, s.sku`);
    return r.rows;
  }
}

module.exports = { StockRepo };
