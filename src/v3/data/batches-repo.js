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
    const active = await this.batchService.listActive();
    if (!active.length) return { active: [] };
    const summaries = [];
    for (const b of active) {
      summaries.push(await this.batchService.getSummary(b.id));
    }
    const names = await this._productNames(summaries.map((s) => s.product_id));
    return { active: summaries.map((s) => this._shape(s, names.get(s.product_id))) };
  }

  /** Resumo de um lote específico. */
  async batchSummary(batchId) {
    const s = await this.batchService.getSummary(batchId);
    const names = await this._productNames([s.product_id]);
    return this._shape(s, names.get(s.product_id));
  }
}

module.exports = { BatchesRepo };
