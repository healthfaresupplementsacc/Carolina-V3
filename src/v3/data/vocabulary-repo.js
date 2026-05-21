'use strict';
/**
 * HEALTHFARE V3 — Bloco 0 — VocabularyRepo (leitura).
 *
 * Termos novos do vocabulário do time aguardando confirmação do
 * admin (3+ ocorrências, ainda não confirmados). Read-only.
 */

const { toNyIso } = require('./ny-date');

const MIN_OCCURRENCES = 3;

class VocabularyRepo {
  constructor(deps = {}) {
    this.db = deps.db;
  }

  /** Termos pendentes de confirmação. @returns {Promise<{terms:object[]}>} */
  async pending() {
    const r = await this.db.query(
      `SELECT term, occurrence_count, context_examples, meaning, first_seen_at
       FROM v3.vocabulary
       WHERE occurrence_count >= $1 AND admin_confirmed = false
       ORDER BY occurrence_count DESC`, [MIN_OCCURRENCES]);
    return {
      terms: (r.rows || []).map((v) => ({
        term: v.term,
        occurrence_count: Number(v.occurrence_count || 0),
        meaning: v.meaning || null,
        context_examples: v.context_examples || null,
        first_seen_at: toNyIso(v.first_seen_at),
      })),
    };
  }
}

module.exports = { VocabularyRepo, MIN_OCCURRENCES };
