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
function getSlackClient() { return require('./slack/client'); }

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// B7: ask whether the second operator is joining the open Ordens session
// rather than starting a fresh one. Wait up to 20min for a reply (B18 window).
const ASK_JOIN_ORDERS_MSGS = [
  (op, owner) => `${op}, tá ajudando a ${owner} no packing das ordens, ou é outra impressão?`,
  (op, owner) => `${op} — você entrou nas ordens da ${owner} ou começou uma sessão separada?`,
  (op, owner) => `${op}, é ajuda na sessão da ${owner} ou tá fazendo uma nova?`,
  (op, owner) => `oi ${op}, você está junto com ${owner} nas ordens ou é separado?`,
  (op, owner) => `${op}, confirmando: ajudando ${owner} nas ordens, ou outra sessão?`,
];

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
    if (session.operator !== operator && operator && !parsed._bypassJoin) {
      // B7: don't silently auto-add. Ask the joiner whether they're helping
      // or starting a separate session. The reply (within 20min) is handled
      // by tasks.handlePendingResponse → confirm_join_orders case.
      try {
        await getSlackClient().postMessage(pick(ASK_JOIN_ORDERS_MSGS)(operator, session.operator));
        await getTaskEngine().storePendingQuestion(operator, {
          questionType: 'confirm_join_orders',
          ordersSessionId: session.id,
          ordersOwner: session.operator,
          pendingStart: { operator, orderCount, ts: msgTs },
        });
      } catch (err) {
        console.error('[Orders] ask-join error:', err.message);
      }
      console.log(`[Orders] ${operator} → asked if joining session #${session.id} (${session.operator})`);
      return;
    }
    if (session.operator !== operator && operator && parsed._bypassJoin) {
      // User answered 'no' (separate session) — fall through to create one.
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
  // Filter out soft-deleted rows. Two paths can mark a row deleted:
  //   - PUT /admin/order/:id with { status: 'deleted' } (frontend [Excluir] button)
  //   - direct deleted_at = NOW() update (admin-validate cleanup, future tooling)
  // The listing must drop both. (Bug found in prod: AdminValidateTest rows
  // stuck in the UI because this query didn't filter either.)
  const result = await db.query(
    `SELECT *,
       ROUND(order_count::numeric / NULLIF(duration_seconds / 3600.0, 0), 0) as orders_per_hour
     FROM orders_sessions
     WHERE (started_at AT TIME ZONE 'America/New_York')::date = ${dateExpr}
       AND (status IS NULL OR status != 'deleted')
       AND deleted_at IS NULL
     ORDER BY started_at ASC`
  );
  return result.rows;
}

/**
 * B14: total order_count across all orders_sessions for a given day.
 * Returns { total, sessionCount } so the dashboard/EOD can show
 * 'Ordens de hoje: N em M sessões' even when the 2nd-print count was
 * added later — previously only individual sessions were visible.
 */
async function getDayOrdersTotal(date) {
  const dateExpr = date
    ? `'${date}'::date`
    : `(NOW() AT TIME ZONE 'America/New_York')::date`;
  // Match getTodayOrders filtering so the dashboard total and the row list
  // agree: deleted sessions don't contribute.
  const result = await db.query(
    `SELECT
       COALESCE(SUM(order_count), 0)::int AS total,
       COUNT(*)::int AS session_count
     FROM orders_sessions
     WHERE (started_at AT TIME ZONE 'America/New_York')::date = ${dateExpr}
       AND (status IS NULL OR status != 'deleted')
       AND deleted_at IS NULL`
  );
  const row = result.rows[0] || { total: 0, session_count: 0 };
  return { total: row.total, sessionCount: row.session_count };
}

module.exports = { handleOrdersStart, handleOrdersFinish, getTodayOrders, getDayOrdersTotal };
