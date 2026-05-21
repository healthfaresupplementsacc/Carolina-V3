'use strict';
/**
 * HEALTHFARE V3 — Bloco 0 — MessagesRepo (leitura).
 *
 * O "shadow" das mensagens: o que o V3 entendeu de cada mensagem
 * do canal. Read-only. Datas em America/New_York.
 */

const { resolveDate } = require('./ny-date');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clampLimit(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
}

/** Extrai o resumo do llm_result num shape estável. */
function shapeMessage(m) {
  const lr = m.llm_result || {};
  return {
    id: m.id,
    slack_ts: m.slack_ts,
    slack_user_id: m.slack_user_id,
    raw_text: m.raw_text,
    created_at: m.created_at || null,
    person: m.person_id
      ? { person_id: m.person_id, display_name: m.person_name || null }
      : null,
    processed: !!m.llm_processed_at,
    provider: m.llm_provider_used || null,
    processing_error: m.processing_error || null,
    interpretation: lr.interpretation || null,
    categorization: lr.categorization || null,
    confidence: lr.confidence_overall || (lr.skipped ? 'skipped' : null),
    skipped: lr.skipped || null,
    action_count: Array.isArray(lr.actions) ? lr.actions.length : 0,
    cost_estimate_usd: Number(lr.cost_estimate_usd || 0),
  };
}

class MessagesRepo {
  constructor(deps = {}) {
    this.db = deps.db;
  }

  /** Mensagens de um dia (NY), mais recentes primeiro. */
  async messagesByDay(date, opts = {}) {
    const d = resolveDate(date);
    const limit = clampLimit(opts.limit);
    const r = await this.db.query(
      `SELECT m.id, m.slack_ts, m.slack_user_id, m.raw_text, m.created_at,
              m.llm_result, m.llm_processed_at, m.llm_provider_used,
              m.processing_error, m.person_id, p.display_name AS person_name
       FROM v3.messages m
       LEFT JOIN v3.persons p ON p.id = m.person_id
       WHERE (m.created_at AT TIME ZONE 'America/New_York')::date = $1
       ORDER BY m.created_at DESC
       LIMIT $2`, [d, limit]);
    return { date: d, count: r.rows.length, messages: (r.rows || []).map(shapeMessage) };
  }

  /** Uma mensagem por id. @returns {object|null} */
  async messageById(id) {
    const r = await this.db.query(
      `SELECT m.id, m.slack_ts, m.slack_user_id, m.raw_text, m.created_at,
              m.llm_result, m.llm_processed_at, m.llm_provider_used,
              m.processing_error, m.person_id, p.display_name AS person_name
       FROM v3.messages m
       LEFT JOIN v3.persons p ON p.id = m.person_id
       WHERE m.id = $1`, [id]);
    return r.rows[0] ? shapeMessage(r.rows[0]) : null;
  }
}

module.exports = { MessagesRepo, clampLimit, DEFAULT_LIMIT, MAX_LIMIT };
