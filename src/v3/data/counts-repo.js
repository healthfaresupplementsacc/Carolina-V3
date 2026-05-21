'use strict';
/**
 * HEALTHFARE V3 — Bloco 0 — CountsRepo (leitura).
 *
 * production_counts de um dia (NY). Só contagens vigentes
 * (não-superseded, não-deletadas). Read-only.
 *
 * `production_date` já é a data NY (o Observer grava com etDate),
 * então o filtro é direto, sem AT TIME ZONE.
 */

const { resolveDate, toNyIso } = require('./ny-date');

class CountsRepo {
  constructor(deps = {}) {
    this.db = deps.db;
  }

  /** @param {string} date YYYY-MM-DD (NY). @returns {Promise<object>} */
  async countsByDay(date) {
    const d = resolveDate(date);
    const r = await this.db.query(
      `SELECT pc.id, pc.bottles, pc.reported_at, pc.confidence, pc.notes,
              pc.product_id, pr.canonical_name AS product,
              pc.product_batch_id, pb.batch_number,
              pc.reported_by_person_id, per.display_name AS reporter
       FROM v3.production_counts pc
       JOIN v3.products pr ON pr.id = pc.product_id
       LEFT JOIN v3.product_batches pb ON pb.id = pc.product_batch_id
       LEFT JOIN v3.persons per ON per.id = pc.reported_by_person_id
       WHERE pc.production_date = $1
         AND pc.superseded_by IS NULL AND pc.deleted_at IS NULL
       ORDER BY pr.canonical_name, pc.reported_at`, [d]);

    const counts = (r.rows || []).map((c) => ({
      id: c.id,
      bottles: Number(c.bottles || 0),
      reported_at: toNyIso(c.reported_at),
      confidence: c.confidence || null,
      notes: c.notes || null,
      product: { id: c.product_id, canonical_name: c.product || null },
      batch: c.product_batch_id
        ? { id: c.product_batch_id, batch_number: c.batch_number || null }
        : null,
      reporter: c.reported_by_person_id
        ? { person_id: c.reported_by_person_id, display_name: c.reporter || null }
        : null,
    }));

    const totals = {};
    for (const c of counts) {
      const k = c.product.canonical_name || ('#' + c.product.id);
      totals[k] = (totals[k] || 0) + c.bottles;
    }

    return { date: d, counts, totals_by_product: totals };
  }
}

module.exports = { CountsRepo };
