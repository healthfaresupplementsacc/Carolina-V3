'use strict';
/**
 * HEALTHFARE V3 — Bloco 2 — GoalsRepo (leitura).
 *
 * Metas do dia COM o cálculo esperado vs realizado:
 *   esperado   = goal.expected_quantity
 *   realizado  = Σ production_counts (mesmo produto+lote, possible_duplicate_of
 *                IS NULL — duplicatas marcadas NÃO entram na soma)
 *   % atingido, bateu (realizado >= esperado), duplicatas p/ revisão,
 *   tempo por fase do lote (events com duração VÁLIDA — ended>started).
 *
 * Read-only. Datas/timestamps em America/New_York.
 */

const { resolveDate, toNyIso } = require('./ny-date');
const { normalizeBatchNumber } = require('../services/GoalService');

/**
 * Duração de um event em segundos, ou null se INVÁLIDA. Inválida =
 * ended_at <= started_at (os events ruins do re-processo em lote +
 * os clampados em 0 pelo guard) — nunca poluem o tempo da fase.
 * Event aberto (ended_at NULL) → conta até agora.
 */
function validSeconds(startedAt, endedAt, nowMs) {
  if (!startedAt) return null;
  const s = new Date(startedAt).getTime();
  const e = endedAt ? new Date(endedAt).getTime() : nowMs;
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  const dur = (e - s) / 1000;
  return dur > 0 ? dur : null;
}

class GoalsRepo {
  constructor(deps = {}) {
    this.db = deps.db;
    this._now = deps.now || Date.now;
  }

  /** Tempo por fase de um conjunto de batches (events agrupados). */
  async _phaseTimesByBatch(batchIds) {
    const out = new Map(); // batch_id → { total_seconds, invalid_event_count, phases:[] }
    if (!batchIds.length) return out;
    const rows = (await this.db.query(
      `SELECT e.product_batch_id, e.started_at, e.ended_at,
              at.display_name AS activity_name, at.flow AS activity_flow
       FROM v3.events e
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       WHERE e.product_batch_id = ANY($1) AND e.deleted_at IS NULL
       ORDER BY e.product_batch_id, e.started_at`, [batchIds])).rows;
    const nowMs = this._now();
    for (const e of rows) {
      if (!out.has(e.product_batch_id)) {
        out.set(e.product_batch_id, { total_seconds: 0, invalid_event_count: 0, _byPhase: new Map() });
      }
      const b = out.get(e.product_batch_id);
      const secs = validSeconds(e.started_at, e.ended_at, nowMs);
      if (secs == null) { b.invalid_event_count += 1; continue; }
      b.total_seconds += secs;
      const key = e.activity_name || '(não classificado)';
      b._byPhase.set(key, (b._byPhase.get(key) || 0) + secs);
    }
    for (const b of out.values()) {
      b.total_seconds = Math.round(b.total_seconds);
      b.phases = [...b._byPhase.entries()].map(([activity, s]) => ({
        activity, seconds: Math.round(s),
      }));
      delete b._byPhase;
    }
    return out;
  }

  /** Metas do dia + esperado vs realizado. @param {string} date YYYY-MM-DD (NY) */
  async goalsByDay(date) {
    const d = resolveDate(date);
    const goals = (await this.db.query(
      `SELECT g.id, g.product_id, g.batch_number, g.expected_quantity, g.unit,
              g.destinations, g.confidence, g.source, g.created_by_person_id,
              pr.canonical_name AS product
       FROM v3.production_goals g
       LEFT JOIN v3.products pr ON pr.id = g.product_id
       WHERE g.production_date = $1 AND g.deleted_at IS NULL AND g.superseded_by IS NULL
       ORDER BY pr.canonical_name NULLS LAST, g.batch_number`, [d])).rows;
    if (!goals.length) return { date: d, goals: [] };

    const productIds = [...new Set(goals.map((g) => g.product_id).filter((x) => x != null))];

    // realizado — contagens do dia desses produtos
    const counts = productIds.length ? (await this.db.query(
      `SELECT pc.id, pc.product_id, pc.bottles, pc.unit, pc.possible_duplicate_of,
              pc.product_batch_id, pb.batch_number AS batch_raw,
              per.display_name AS reporter, pc.reported_at
       FROM v3.production_counts pc
       LEFT JOIN v3.product_batches pb ON pb.id = pc.product_batch_id
       LEFT JOIN v3.persons per ON per.id = pc.reported_by_person_id
       WHERE pc.product_id = ANY($1) AND pc.production_date = $2
         AND pc.superseded_by IS NULL AND pc.deleted_at IS NULL`,
      [productIds, d])).rows : [];

    // batches desses produtos — p/ casar lote e medir tempo por fase
    const batchRows = productIds.length ? (await this.db.query(
      `SELECT id, product_id, batch_number FROM v3.product_batches
       WHERE product_id = ANY($1) AND deleted_at IS NULL`, [productIds])).rows : [];
    const phaseTimes = await this._phaseTimesByBatch(batchRows.map((b) => b.id));

    const out = goals.map((g) => {
      const matched = counts.filter((c) =>
        c.product_id === g.product_id
        && normalizeBatchNumber(c.batch_raw) === g.batch_number);
      const real = matched.filter((c) => c.possible_duplicate_of == null);
      const dups = matched.filter((c) => c.possible_duplicate_of != null);
      const realizado = real.reduce((s, c) => s + Number(c.bottles || 0), 0);
      const esperado = Number(g.expected_quantity || 0);

      // lote casado (p/ tempo por fase)
      const batch = batchRows.find((b) =>
        b.product_id === g.product_id
        && normalizeBatchNumber(b.batch_number) === g.batch_number);
      const bt = batch ? phaseTimes.get(batch.id) : null;

      return {
        goal_id: g.id,
        product: { id: g.product_id, canonical_name: g.product || null },
        batch_number: g.batch_number,
        unit: g.unit,
        destinations: g.destinations || null,
        confidence: g.confidence,
        source: g.source,
        esperado,
        realizado,
        pct_atingido: esperado > 0 ? Math.round((realizado / esperado) * 100) : null,
        bateu: esperado > 0 ? realizado >= esperado : null,
        contagens: real.length,
        duplicatas_suspeitas: dups.map((c) => ({
          count_id: c.id, bottles: Number(c.bottles || 0),
          reporter: c.reporter || null, reported_at: toNyIso(c.reported_at),
          possible_duplicate_of: c.possible_duplicate_of,
        })),
        batch: batch ? {
          id: batch.id,
          total_seconds: bt ? bt.total_seconds : 0,
          invalid_event_count: bt ? bt.invalid_event_count : 0,
          phases: bt ? bt.phases : [],
        } : null,
      };
    });

    return { date: d, goals: out };
  }
}

module.exports = { GoalsRepo, validSeconds };
