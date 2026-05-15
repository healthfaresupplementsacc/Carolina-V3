'use strict';
/**
 * Formulation engine — tracks Bruno and Vitor's formula/capsule work.
 * Detected from freetext: "fazendo a formula", "para capsula", "formulacao", etc.
 */

const db = require('./db');
function getTaskEngine() { return require('./tasks'); }

async function handleFormulationStart(parsed, rawMsg) {
  const { operator, supplement, batch, description, ts } = parsed;
  const msgTs = rawMsg.ts || ts;
  const startedAt = new Date(parseFloat(msgTs) * 1000).toISOString();

  // B6: formulating ends any open break for this operator.
  if (operator) {
    try { await getTaskEngine().closeOpenBreakFor(operator, startedAt, 'auto_new_task'); }
    catch (err) { console.error('[Formulation] closeOpenBreakFor error:', err.message); }
  }

  await db.query(
    `INSERT INTO formulation_sessions
       (operator, supplement_name, batch_number, description, started_at, status, slack_start_ts)
     VALUES ($1, $2, $3, $4, $5, 'open', $6)`,
    [operator, supplement, batch, description, startedAt, msgTs]
  );

  console.log(`[Formulation] Started: ${operator} — ${supplement || '?'} ${batch || ''}`);
}

async function handleFormulationFinish(parsed, rawMsg) {
  const { operator, supplement, ts } = parsed;
  const msgTs = rawMsg.ts || ts;
  const endedAt = new Date(parseFloat(msgTs) * 1000).toISOString();

  // Match most recent open session for this operator (+ supplement if known)
  let q = `SELECT id, started_at FROM formulation_sessions WHERE status = 'open'`;
  const params = [];
  if (operator) { q += ` AND operator = $${params.length + 1}`; params.push(operator); }
  if (supplement) { q += ` AND supplement_name = $${params.length + 1}`; params.push(supplement); }
  q += ` ORDER BY started_at DESC LIMIT 1`;

  const result = await db.query(q, params);
  if (result.rows.length === 0) {
    console.warn(`[Formulation] No open session to close for ${operator}`);
    return;
  }

  const session = result.rows[0];
  const durationSeconds = Math.round((new Date(endedAt) - new Date(session.started_at)) / 1000);

  await db.query(
    `UPDATE formulation_sessions SET
       ended_at = $1, duration_seconds = $2, status = 'closed',
       slack_end_ts = $3, updated_at = NOW()
     WHERE id = $4`,
    [endedAt, durationSeconds, msgTs, session.id]
  );

  console.log(`[Formulation] Finished session #${session.id}, ${durationSeconds}s`);
}

/**
 * Get formulation sessions for a given ET date (defaults to today).
 * @param {string|null} date - 'YYYY-MM-DD' in ET, or null for today
 */
async function getTodayFormulations(date) {
  const dateExpr = date
    ? `'${date}'::date`
    : `(NOW() AT TIME ZONE 'America/New_York')::date`;
  const result = await db.query(
    `SELECT *
     FROM formulation_sessions
     WHERE (started_at AT TIME ZONE 'America/New_York')::date = ${dateExpr}
     ORDER BY started_at ASC`
  );
  return result.rows;
}

module.exports = { handleFormulationStart, handleFormulationFinish, getTodayFormulations };
