'use strict';
/**
 * HEALTHFARE V3 — Bloco 0 — MetricsRepo (leitura).
 *
 * Métricas do LLM: total processado, erros, custo, distribuição por
 * confiança e por categorização. Read-only.
 *
 *   metricsByDay(date)     — um dia (NY), p/ a API de dados.
 *   metricsRange(from,to)  — intervalo cru de created_at (from/to
 *                            opcionais; sem ambos = tudo), p/ o
 *                            endpoint HTML llm-metrics.
 */

const { resolveDate } = require('./ny-date');

class MetricsRepo {
  constructor(deps = {}) {
    this.db = deps.db;
  }

  /** Agrega linhas {llm_result, processing_error} no shape de métricas. */
  _aggregate(rows, label) {
    const m = Object.assign({}, label, {
      total_processed: 0,
      errors: 0,
      cost_estimate_usd: 0,
      by_confidence: {},
      by_categorization: {},
    });
    for (const row of (rows || [])) {
      if (row.processing_error) { m.errors += 1; continue; }
      m.total_processed += 1;
      const lr = row.llm_result || {};
      const conf = lr.confidence_overall || (lr.skipped ? 'skipped' : 'outro');
      m.by_confidence[conf] = (m.by_confidence[conf] || 0) + 1;
      const cat = lr.categorization || (lr.skipped ? 'skipped' : 'outro');
      m.by_categorization[cat] = (m.by_categorization[cat] || 0) + 1;
      m.cost_estimate_usd += Number(lr.cost_estimate_usd || 0);
    }
    m.cost_estimate_usd = +m.cost_estimate_usd.toFixed(6);
    m.avg_cost_per_msg = m.total_processed
      ? +(m.cost_estimate_usd / m.total_processed).toFixed(6)
      : 0;
    return m;
  }

  /** Métricas de um dia (NY). */
  async metricsByDay(date) {
    const d = resolveDate(date);
    const r = await this.db.query(
      `SELECT llm_result, processing_error
       FROM v3.messages
       WHERE (created_at AT TIME ZONE 'America/New_York')::date = $1
         AND (llm_processed_at IS NOT NULL OR processing_error IS NOT NULL)`, [d]);
    return this._aggregate(r.rows, { date: d });
  }

  /**
   * Métricas num intervalo de created_at. from/to opcionais (string
   * de data/timestamp). Sem nenhum dos dois = todas as mensagens.
   */
  async metricsRange(from, to) {
    const cond = ['(llm_processed_at IS NOT NULL OR processing_error IS NOT NULL)'];
    const params = [];
    if (from) { params.push(from); cond.push(`created_at >= $${params.length}`); }
    if (to) { params.push(to); cond.push(`created_at <= $${params.length}`); }
    const r = await this.db.query(
      `SELECT llm_result, processing_error FROM v3.messages WHERE ${cond.join(' AND ')}`, params);
    return this._aggregate(r.rows, { from: from || null, to: to || null });
  }
}

module.exports = { MetricsRepo };
