'use strict';
/**
 * Orders engine — tracks Simone's picking & packing sessions.
 * Morning batch: when she prints orders (~9am)
 * Afternoon batch: second print ~11am
 * Each "imprimindo as ordens - N" starts a new session.
 */

const db = require('./db');
// Avoid circular dep: require lazily inside the handler.
function getTaskEngine() { return require('./tasks'); }

/**
 * Start a new orders session.
 * If there's already an open session (started within the last 8h by a different operator),
 * this person is added as a helper rather than opening a duplicate session.
 */
async function handleOrdersStart(parsed, rawMsg) {
  const { operator, orderCount, ts } = parsed;
  const msgTs = rawMsg.ts || ts;
  const startedAt = new Date(parseFloat(msgTs) * 1000).toISOString();

  // B6: starting orders ends any open break for this operator.
  if (operator) {
    try { await getTaskEngine().closeOpenBreakFor(operator, startedAt, 'auto_new_task'); }
    catch (err) { console.error('[Orders] closeOpenBreakFor error:', err.message); }
  }

  // Check for an already-open session in the last 8 hours
  const existing = await db.query(
    `SELECT id, operator, helpers, order_count FROM orders_sessions
     WHERE status = 'open'
       AND started_at > NOW() - INTERVAL '8 hours'
     ORDER BY started_at DESC LIMIT 1`
  );

  if (existing.rows.length > 0) {
    const session = existing.rows[0];
    if (session.operator !== operator && operator) {
      // Different person — add as helper
      const helpers = session.helpers
        ? session.helpers.split(',').map(h => h.trim()).filter(Boolean)
        : [];
      if (!helpers.includes(operator)) {
        helpers.push(operator);
        await db.query(
          'UPDATE orders_sessions SET helpers = $1, updated_at = NOW() WHERE id = $2',
          [helpers.join(', '), session.id]
        );
        console.log(`[Orders] ${operator} joined as helper for session #${session.id}`);
      }
      return; // don't create a new session
    }
    // Same operator starting again (e.g. second batch) — fall through to create new session
  }

  // Determine batch label based on time of day (Eastern)
  const hourEdt = new Date(startedAt).toLocaleString('en-US', {
    hour: 'numeric', hour12: false, timeZone: 'America/New_York',
  });
  const batchLabel = parseInt(hourEdt) < 10 ? 'morning' : 'afternoon';

  await db.query(
    `INSERT INTO orders_sessions
       (operator, order_count, batch_label, started_at, status, slack_start_ts)
     VALUES ($1, $2, $3, $4, 'open', $5)`,
    [operator, orderCount, batchLabel, startedAt, msgTs]
  );

  console.log(`[Orders] Started: ${operator} — ${orderCount} orders (${batchLabel})`);
}

/**
 * Close the most recent open orders session for this operator.
 */
async function handleOrdersFinish(parsed, rawMsg) {
  const { operator, ts } = parsed;
  const msgTs = rawMsg.ts || ts;
  const endedAt = new Date(parseFloat(msgTs) * 1000).toISOString();

  let result = await db.query(
    `SELECT id, started_at FROM orders_sessions
     WHERE status = 'open'
       AND (operator = $1 OR $1 IS NULL)
     ORDER BY started_at DESC LIMIT 1`,
    [operator]
  );

  // Cross-operator fallback: Ana finishes a session Simone started (or vice-versa)
  if (result.rows.length === 0 && operator) {
    console.log(`[Orders] Cross-operator fallback for finish — looking for any open session`);
    result = await db.query(
      `SELECT id, started_at FROM orders_sessions
       WHERE status = 'open'
         AND started_at > NOW() - INTERVAL '8 hours'
       ORDER BY started_at DESC LIMIT 1`
    );
  }

  if (result.rows.length === 0) {
    console.warn(`[Orders] No open orders session to close for ${operator}`);
    return;
  }

  const session = result.rows[0];
  const durationSeconds = Math.round(
    (new Date(endedAt) - new Date(session.started_at)) / 1000
  );

  await db.query(
    `UPDATE orders_sessions SET
       ended_at = $1, duration_seconds = $2, status = 'closed',
       slack_end_ts = $3, updated_at = NOW()
     WHERE id = $4`,
    [endedAt, durationSeconds, msgTs, session.id]
  );

  console.log(`[Orders] Finished session #${session.id}, ${durationSeconds}s`);
}

/**
 * Get orders sessions for a given ET date (defaults to today).
 * @param {string|null} date - 'YYYY-MM-DD' in ET, or null for today
 */
async function getTodayOrders(date) {
  const dateExpr = date
    ? `'${date}'::date`
    : `(NOW() AT TIME ZONE 'America/New_York')::date`;
  const result = await db.query(
    `SELECT *,
       ROUND(order_count::numeric / NULLIF(duration_seconds / 3600.0, 0), 0) as orders_per_hour
     FROM orders_sessions
     WHERE (started_at AT TIME ZONE 'America/New_York')::date = ${dateExpr}
     ORDER BY started_at ASC`
  );
  return result.rows;
}

module.exports = { handleOrdersStart, handleOrdersFinish, getTodayOrders };
