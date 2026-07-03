'use strict';
/**
 * HEALTHFARE V3 — Bloco 0 — BatchesRepo (leitura).
 *
 * Lotes ativos + resumo. DELEGA pro BatchService (princípio do
 * desacoplamento: leitura que já existe e é não-trivial não é
 * reimplementada — getSummary carrega a dedup de cowork §6.11).
 * O repo só acrescenta o nome canônico do produto e padroniza o
 * shape de saída. Read-only.
 */

const { BatchService } = require('../services/BatchService');
const { toNyIso } = require('./ny-date');

class BatchesRepo {
  /**
   * @param {object} deps  deps.db = pool pg; deps.batchService injetável (teste)
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.batchService = deps.batchService || new BatchService({ db: deps.db });
  }

  /** Resolve canonical_name de vários product_ids de uma vez. */
  async _productNames(ids) {
    const uniq = [...new Set(ids.filter((x) => x != null))];
    if (!uniq.length) return new Map();
    const r = await this.db.query(
      'SELECT id, canonical_name FROM v3.products WHERE id = ANY($1)', [uniq]);
    return new Map((r.rows || []).map((p) => [p.id, p.canonical_name]));
  }

  _shape(summary, prodName) {
    return {
      batch_id: summary.batch_id,
      batch_number: summary.batch_number,
      status: summary.status,
      product: { id: summary.product_id, canonical_name: prodName || null },
      started_at: toNyIso(summary.started_at),
      finished_at: toNyIso(summary.finished_at),
      total_seconds: Number(summary.total_seconds || 0),
      event_count: Number(summary.event_count || 0),
      people: summary.people || [],
      phases: summary.phases || [],
      bottles: Number(summary.bottles || 0),
    };
  }

  /** Lotes in_progress, com resumo (pessoas, tempo total, fases). */
  async activeBatches() {
    // AUDITORIA 07-03 (Bruno: "todo botão funciona de verdade?"): a versão
    // antiga rodava getSummary() SEQUENCIAL por lote (N+1 pesado, com dedup de
    // cowork) — com 113 lotes in_progress acumulados o endpoint passava de 15s
    // e TRAVAVA o modal de metas / picker de lotes do dashboard. Agora: 4
    // queries AGREGADAS pro conjunto inteiro (mesmo shape de saída). O resumo
    // fiel (cowork-dedup §6.11) continua no /batches/:id (drill-down).
    const base = await this.db.query(
      `SELECT pb.id AS batch_id, pb.batch_number, pb.status, pb.product_id, pb.started_at, pb.finished_at
       FROM v3.product_batches pb
       WHERE pb.status = 'in_progress' AND pb.deleted_at IS NULL
       ORDER BY pb.started_at DESC NULLS LAST`);
    if (!base.rows.length) return { active: [] };
    const ids = base.rows.map((b) => b.batch_id);
    const WORK = `GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(e.ended_at, NOW()) - e.started_at)) - COALESCE(e.total_paused_seconds, 0))`;
    const [evAgg, phAgg, btAgg] = await Promise.all([
      this.db.query(
        `SELECT e.product_batch_id AS bid, COUNT(*)::int AS event_count,
                COALESCE(SUM(${WORK}), 0)::bigint AS total_seconds,
                ARRAY_AGG(DISTINCT p.display_name) FILTER (WHERE p.display_name IS NOT NULL) AS people
         FROM v3.events e LEFT JOIN v3.persons p ON p.id = e.person_id
         WHERE e.deleted_at IS NULL AND e.product_batch_id = ANY($1::int[])
         GROUP BY 1`, [ids]),
      this.db.query(
        `SELECT e.product_batch_id AS bid, at.display_name AS activity, COALESCE(SUM(${WORK}), 0)::bigint AS seconds
         FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
         WHERE e.deleted_at IS NULL AND e.product_batch_id = ANY($1::int[])
         GROUP BY 1, 2`, [ids]),
      this.db.query(
        `SELECT pc.product_batch_id AS bid, COALESCE(SUM(pc.bottles), 0)::int AS bottles
         FROM v3.production_counts pc
         WHERE COALESCE(pc.kind, 'bottles') = 'bottles' AND pc.deleted_at IS NULL AND pc.superseded_by IS NULL
           AND pc.product_batch_id = ANY($1::int[])
         GROUP BY 1`, [ids]),
    ]);
    const ev = new Map(evAgg.rows.map((x) => [x.bid, x]));
    const bt = new Map(btAgg.rows.map((x) => [x.bid, x.bottles]));
    const ph = new Map();
    for (const x of phAgg.rows) {
      if (!ph.has(x.bid)) ph.set(x.bid, []);
      ph.get(x.bid).push({ activity: x.activity, seconds: Number(x.seconds) });
    }
    const names = await this._productNames(base.rows.map((b) => b.product_id));
    return {
      active: base.rows.map((b) => this._shape({
        ...b,
        total_seconds: (ev.get(b.batch_id) || {}).total_seconds || 0,
        event_count: (ev.get(b.batch_id) || {}).event_count || 0,
        people: (ev.get(b.batch_id) || {}).people || [],
        phases: (ph.get(b.batch_id) || []).sort((a, c) => c.seconds - a.seconds),
        bottles: bt.get(b.batch_id) || 0,
      }, names.get(b.product_id))),
    };
  }

  /** Resumo de um lote específico. */
  async batchSummary(batchId) {
    const s = await this.batchService.getSummary(batchId);
    const names = await this._productNames([s.product_id]);
    return this._shape(s, names.get(s.product_id));
  }
}

module.exports = { BatchesRepo };
