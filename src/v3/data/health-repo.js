'use strict';
/**
 * HEALTHFARE V3 — Bloco 0 — HealthRepo (leitura).
 *
 * Saúde do worker Observer: heartbeat, fila, erros, provider, modo.
 * Read-only. Não conhece HTML — devolve objeto JS puro.
 */

const { toNyIso } = require('./ny-date');

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
        last_tick_at: toNyIso(lastTick),       // idade calculada no valor cru acima
        tick_age_seconds: tickAge,
      },
      queue: queueN,
      errors: errN,
      last_processed_at: toNyIso(lastProcessed),
      provider: provider || null,
      mode: mode || null,
    };
  }

  /**
   * E7-cérebro #4 — Events auto-fechados pelo safetyAutoClose num dia NY.
   * Cada um vira uma "notificação" pro card de Atenção do dashboard.
   * Vasculha audit_log pelo metadata.reason='auto_closed_eod' + ny_date.
   *
   * @param {string} dateInput  YYYY-MM-DD NY
   * @returns {Promise<{ date: string, events: Array }>}
   */
  async autoClosedEvents(dateInput) {
    const { resolveDate } = require('./ny-date');
    const d = resolveDate(dateInput);
    const r = await this.db.query(
      `SELECT a.target_id AS event_id,
              a.created_at,
              a.metadata,
              e.person_id, e.activity_type_id, e.started_at, e.ended_at,
              p.display_name AS person_name,
              at.slug AS activity_slug, at.display_name AS activity_name
       FROM v3.audit_log a
       LEFT JOIN v3.events e         ON e.id = a.target_id
       LEFT JOIN v3.persons p        ON p.id = e.person_id
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       WHERE a.action = 'event.closed'
         AND a.target_type = 'event'
         AND a.metadata->>'reason' = 'auto_closed_eod'
         AND a.metadata->>'ny_date' = $1
       ORDER BY a.created_at DESC`, [d]);
    return {
      date: d,
      events: r.rows.map((row) => ({
        event_id: row.event_id,
        person_id: row.person_id,
        person_name: row.person_name,
        activity_slug: row.activity_slug,
        activity_name: row.activity_name,
        started_at: toNyIso(row.started_at),
        ended_at: toNyIso(row.ended_at),
        kind: row.metadata && row.metadata.kind,
        end_hour: row.metadata && row.metadata.end_hour,
        auto_closed_at: row.created_at,
      })),
    };
  }
}

module.exports = { HealthRepo };
