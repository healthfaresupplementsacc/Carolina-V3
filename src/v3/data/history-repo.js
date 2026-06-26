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

const { resolveDate, nyDate, toNyIso } = require('./ny-date');

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
              e.product_batch_id, e.flow_override,
              (e.started_at AT TIME ZONE 'America/New_York')::date AS ny_day,
              at.slug AS activity_slug, at.display_name AS activity_name,
              at.category AS activity_category, at.flow AS activity_flow
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
        flow: e.flow_override || e.activity_flow || null,
        started_at: toNyIso(e.started_at),
        ended_at: toNyIso(e.ended_at),
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

  /** Busca universal: produto, lote, pessoa, tarefa. Cada query é tolerante a
   *  falha (colunas que variam por schema) → nunca derruba a busca inteira. */
  async search(q) {
    const term = String(q || '').trim();
    const out = { query: term, products: [], batches: [], persons: [], tasks: [] };
    if (term.length < 1) return out;
    const like = '%' + term + '%';
    const tryQ = async (sql, params) => { try { return (await this.db.query(sql, params)).rows; } catch (e) { return []; } };
    const [products, batches, persons, tasks] = await Promise.all([
      tryQ(`SELECT id, canonical_name FROM v3.products
            WHERE COALESCE(active, true) = true AND (canonical_name ILIKE $1 OR aliases::text ILIKE $1)
            ORDER BY canonical_name LIMIT 12`, [like]),
      tryQ(`SELECT pb.id, pb.batch_number, pb.status, pr.id AS product_id, pr.canonical_name AS product
            FROM v3.product_batches pb LEFT JOIN v3.products pr ON pr.id = pb.product_id
            WHERE pb.deleted_at IS NULL AND (pb.batch_number ILIKE $1 OR pr.canonical_name ILIKE $1)
            ORDER BY pb.started_at DESC NULLS LAST LIMIT 14`, [like]),
      tryQ(`SELECT id, display_name, role FROM v3.persons
            WHERE display_name ILIKE $1 AND COALESCE(deleted_at, NULL) IS NULL
            ORDER BY display_name LIMIT 12`, [like]),
      tryQ(`SELECT slug, display_name, flow FROM v3.activity_types
            WHERE active = true AND (display_name ILIKE $1 OR slug ILIKE $1)
            ORDER BY display_name LIMIT 14`, [like]),
    ]);
    out.products = products.map((p) => ({ id: p.id, name: p.canonical_name }));
    out.batches = batches.map((b) => ({ id: b.id, batch_number: b.batch_number, product: b.product || null, product_id: b.product_id || null, status: b.status }));
    out.persons = persons.map((p) => ({ id: p.id, name: p.display_name, role: p.role }));
    out.tasks = tasks.map((t) => ({ slug: t.slug, name: t.display_name, flow: t.flow }));
    return out;
  }

  /** HISTÓRICO COMPLETO de um lote: cada tarefa (fase) do início ao envio —
   *  quem fez, quando, quanto tempo (descontando pausa), o que foi feito
   *  (anotações), + contagens (garrafas/ordens/clínica) + tempo total. */
  async batchHistory(batchId) {
    const id = parseInt(batchId, 10);
    if (!Number.isFinite(id)) return null;
    const WORK = `GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(e.ended_at, NOW()) - e.started_at)) - COALESCE(e.total_paused_seconds, 0))::int`;
    const [batchR, evR, countsR] = await Promise.all([
      this.db.query(
        `SELECT pb.id, pb.batch_number, pb.status, pb.started_at, pb.finished_at, pb.origin,
                pr.id AS product_id, pr.canonical_name AS product, pb.target_bottles, pb.units_per_bottle
         FROM v3.product_batches pb LEFT JOIN v3.products pr ON pr.id = pb.product_id WHERE pb.id = $1`, [id]),
      this.db.query(
        `SELECT e.id, e.started_at, e.ended_at, e.description, e.orders_printed,
                e.exception_no_count, e.exception_reason, e.confidence, e.source,
                e.cowork_with, e.is_long_running, ${WORK} AS work_sec,
                at.slug, at.display_name AS activity, COALESCE(e.flow_override, at.flow) AS flow, at.phase_order,
                p.id AS person_id, p.display_name AS person
         FROM v3.events e
         LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
         LEFT JOIN v3.persons p ON p.id = e.person_id
         WHERE e.product_batch_id = $1 AND e.deleted_at IS NULL
         ORDER BY e.started_at`, [id]),
      this.db.query(
        `SELECT kind, SUM(bottles)::int AS total, MAX(reported_at) AS last_at
         FROM v3.production_counts WHERE product_batch_id = $1 AND deleted_at IS NULL AND superseded_by IS NULL
         GROUP BY kind`, [id]),
    ]);
    if (!batchR.rows[0]) return null;
    const b = batchR.rows[0];
    const events = (evR.rows || []).map((e) => ({
      event_id: e.id, slug: e.slug, activity: e.activity || '(?)', flow: e.flow || null, phase_order: e.phase_order,
      person_id: e.person_id, person: e.person || null, cowork_with: e.cowork_with || [],
      started_at: toNyIso(e.started_at), ended_at: toNyIso(e.ended_at),
      work_seconds: e.work_sec, open: e.ended_at == null, is_background: !!e.is_long_running,
      description: e.description || null, orders_printed: e.orders_printed != null ? e.orders_printed : null,
      exception: !!e.exception_no_count, exception_reason: e.exception_reason || null,
      confidence: e.confidence || null, source: e.source || null,
    }));
    // span (1º início → último fim/agora) e tempo de trabalho efetivo
    let spanStart = null, spanEnd = null, totalWork = 0;
    const people = new Set();
    const byStage = new Map();
    for (const e of evR.rows) {
      const s = e.started_at ? new Date(e.started_at).getTime() : null;
      const en = e.ended_at ? new Date(e.ended_at).getTime() : Date.now();
      if (s != null && (spanStart == null || s < spanStart)) spanStart = s;
      if (en != null && (spanEnd == null || en > spanEnd)) spanEnd = en;
      totalWork += Number(e.work_sec) || 0;
      if (e.person) people.add(e.person);
      const st = e.activity || '(?)';
      if (!byStage.has(st)) byStage.set(st, { activity: st, flow: e.flow || null, phase_order: e.phase_order, seconds: 0, events: 0, people: new Set() });
      const g = byStage.get(st); g.seconds += Number(e.work_sec) || 0; g.events += 1; if (e.person) g.people.add(e.person);
    }
    const counts = {};
    for (const c of (countsR.rows || [])) counts[c.kind] = { total: c.total, last_at: toNyIso(c.last_at) };
    return {
      batch: { id: b.id, batch_number: b.batch_number, status: b.status, origin: b.origin,
        product: b.product || null, product_id: b.product_id || null,
        target_bottles: b.target_bottles != null ? b.target_bottles : null,
        units_per_bottle: b.units_per_bottle != null ? b.units_per_bottle : null,
        started_at: toNyIso(b.started_at), finished_at: toNyIso(b.finished_at) },
      span_seconds: (spanStart != null && spanEnd != null && spanEnd > spanStart) ? Math.round((spanEnd - spanStart) / 1000) : 0,
      span_start: spanStart != null ? toNyIso(new Date(spanStart)) : null,
      span_end: spanEnd != null ? toNyIso(new Date(spanEnd)) : null,
      total_work_seconds: Math.round(totalWork),
      people: [...people],
      event_count: events.length,
      counts,
      by_stage: [...byStage.values()].map((g) => ({ activity: g.activity, flow: g.flow, phase_order: g.phase_order, seconds: Math.round(g.seconds), events: g.events, people: [...g.people] }))
        .sort((a, b2) => (a.phase_order || 99) - (b2.phase_order || 99) || b2.seconds - a.seconds),
      events,
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
        reported_at: toNyIso(c.reported_at),
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
        started_at: toNyIso(b.started_at),
        finished_at: toNyIso(b.finished_at),
        status: b.status,
      })),
    };
  }
}

module.exports = { HistoryRepo, resolveRange, DEFAULT_RANGE_DAYS };
