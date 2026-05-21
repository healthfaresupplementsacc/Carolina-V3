'use strict';
/**
 * HEALTHFARE V3 — Bloco 0 — HealthRepo (leitura).
 *
 * Saúde do worker Observer: heartbeat, fila, erros, provider, modo.
 * Read-only. Não conhece HTML — devolve objeto JS puro.
 */

const TICK_ALIVE_SEC = 120;        // heartbeat recente → worker vivo
const FALLBACK_ALIVE_MS = 15 * 60000; // sem heartbeat: última msg processada <15min

class HealthRepo {
  /** @param {object} deps  deps.db = pool/cliente pg; deps.now p/ teste */
  constructor(deps = {}) {
    this.db = deps.db;
    this._now = deps.now || Date.now;
  }

  /** @returns {Promise<object>} estado de saúde do V3 */
  async workerHealth() {
    const [queue, last, errs, settings] = await Promise.all([
      this.db.query('SELECT COUNT(*) c FROM v3.messages WHERE llm_processed_at IS NULL'),
      this.db.query('SELECT MAX(llm_processed_at) mx FROM v3.messages'),
      this.db.query('SELECT COUNT(*) c FROM v3.messages WHERE processing_error IS NOT NULL'),
      this.db.query(
        "SELECT key, value FROM v3.settings WHERE key IN ('llm_provider','llm_observer_mode','observer_last_tick_at')"),
    ]);

    let provider = null;
    let mode = null;
    let lastTick = null;
    for (const row of (settings.rows || [])) {
      const v = typeof row.value === 'string' ? row.value.replace(/"/g, '') : row.value;
      if (row.key === 'llm_provider') provider = v;
      if (row.key === 'llm_observer_mode') mode = v;
      if (row.key === 'observer_last_tick_at') lastTick = v;
    }

    // COUNT/MAX sempre retornam 1 row em Postgres real; guarda mesmo assim.
    const queueN = parseInt((queue.rows[0] || {}).c || 0, 10);
    const errN = parseInt((errs.rows[0] || {}).c || 0, 10);
    const lastProcessed = (last.rows[0] || {}).mx || null;
    const tickAge = lastTick
      ? Math.round((this._now() - new Date(lastTick).getTime()) / 1000)
      : null;
    // vivo = heartbeat recente; fallback = última msg processada recente.
    const alive = tickAge != null
      ? tickAge < TICK_ALIVE_SEC
      : (lastProcessed != null && (this._now() - new Date(lastProcessed).getTime()) < FALLBACK_ALIVE_MS);

    return {
      worker: {
        alive,
        last_tick_at: lastTick || null,
        tick_age_seconds: tickAge,
      },
      queue: queueN,
      errors: errN,
      last_processed_at: lastProcessed,
      provider: provider || null,
      mode: mode || null,
    };
  }
}

module.exports = { HealthRepo };
