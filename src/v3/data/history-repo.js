'use strict';
/**
 * HEALTHFARE V3 — Bloco 0 — HistoryRepo (leitura).
 *
 * Histórico por pessoa e por produto num intervalo de datas (NY).
 * Read-only. Base do /api/v3/data/person/{id}/history e
 * /product/{id}/history.
 *
 * Intervalo default: últimos 30 dias até hoje (NY).
 */

const { resolveDate, nyDate } = require('./ny-date');

const DEFAULT_RANGE_DAYS = 30;

/** Resolve {from,to} → datas válidas (NY). to default hoje, from default to-30d. */
function resolveRange(opts = {}) {
  const to = resolveDate(opts.to);
  let from;
  if (opts.from) {
    from = resolveDate(opts.from);
  } else {
    const base = Date.parse(to + 'T12:00:00Z') - DEFAULT_RANGE_DAYS * 86400000;
    from = nyDate(new Date(base));
  }
  // garante from <= to
  return from <= to ? { from, to } : { from: to, to: from };
}

class HistoryRepo {
  constructor(deps = {}) {
    this.db = deps.db;
  }

  /** Eventos de uma pessoa no intervalo, agrupados por dia (NY). */
  async personHistory(personId, opts = {}) {
    const { from, to } = resolveRange(opts);
    const r = await this.db.query(
      `SELECT e.id, e.started_at, e.ended_at, e.confidence, e.cowork_with,
              e.product_batch_id,
              (e.started_at AT TIME ZONE 'America/New_York')::date AS ny_day,
              at.slug AS activity_slug, at.display_name AS activity_name,
              at.category AS activity_category
       FROM v3.events e
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       WHERE e.deleted_at IS NULL AND e.person_id = $1
         AND (e.started_at AT TIME ZONE 'America/New_York')::date BETWEEN $2 AND $3
       ORDER BY e.started_at`, [personId, from, to]);

    const days = new Map();
    for (const e of (r.rows || [])) {
      const key = String(e.ny_day).slice(0, 10);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push({
        event_id: e.id,
        activity: e.activity_name
          ? { slug: e.activity_slug, display_name: e.activity_name, category: e.activity_category }
          : null,
        started_at: e.started_at || null,
        ended_at: e.ended_at || null,
        confidence: e.confidence || null,
        cowork_with: e.cowork_with || [],
        product_batch_id: e.product_batch_id || null,
      });
    }
    return {
      person_id: personId,
      from,
      to,
      event_count: r.rows.length,
      days: [...days.entries()].map(([date, events]) => ({ date, events })),
    };
  }

  /** Contagens e lotes de um produto no intervalo (por production_date NY). */
  async productHistory(productId, opts = {}) {
    const { from, to } = resolveRange(opts);
    const [counts, batches, product] = await Promise.all([
      this.db.query(
        `SELECT pc.id, pc.bottles, pc.production_date, pc.reported_at, pc.confidence,
                pc.product_batch_id, pb.batch_number,
                pc.reported_by_person_id, per.display_name AS reporter
         FROM v3.production_counts pc
         LEFT JOIN v3.product_batches pb ON pb.id = pc.product_batch_id
         LEFT JOIN v3.persons per ON per.id = pc.reported_by_person_id
         WHERE pc.product_id = $1 AND pc.superseded_by IS NULL AND pc.deleted_at IS NULL
           AND pc.production_date BETWEEN $2 AND $3
         ORDER BY pc.production_date, pc.reported_at`, [productId, from, to]),
      this.db.query(
        `SELECT id, batch_number, started_at, finished_at, status
         FROM v3.product_batches
         WHERE product_id = $1 AND deleted_at IS NULL
         ORDER BY started_at DESC`, [productId]),
      this.db.query('SELECT id, canonical_name FROM v3.products WHERE id = $1', [productId]),
    ]);

    return {
      product: product.rows[0]
        ? { id: product.rows[0].id, canonical_name: product.rows[0].canonical_name }
        : { id: productId, canonical_name: null },
      from,
      to,
      counts: (counts.rows || []).map((c) => ({
        id: c.id,
        bottles: Number(c.bottles || 0),
        production_date: String(c.production_date).slice(0, 10),
        reported_at: c.reported_at || null,
        confidence: c.confidence || null,
        batch: c.product_batch_id
          ? { id: c.product_batch_id, batch_number: c.batch_number || null }
          : null,
        reporter: c.reported_by_person_id
          ? { person_id: c.reported_by_person_id, display_name: c.reporter || null }
          : null,
      })),
      batches: (batches.rows || []).map((b) => ({
        id: b.id,
        batch_number: b.batch_number,
        started_at: b.started_at || null,
        finished_at: b.finished_at || null,
        status: b.status,
      })),
    };
  }
}

module.exports = { HistoryRepo, resolveRange, DEFAULT_RANGE_DAYS };
