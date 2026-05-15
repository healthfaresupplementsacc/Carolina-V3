'use strict';
/**
 * Re-runs the parser + handlers over every message of a given ET day, using
 * the CURRENT supplement catalog and parser code. Catches messages that
 * silently failed to produce a task because of catalog gaps (Apple Cider /
 * Potassium / Citrus / Feminiva) or the ORDERS_START_REGEX bug.
 *
 * Usage:
 *   railway run --service ProductionLineService node scripts/reprocess-day.js [--date=YYYY-MM-DD] [--dry-run]
 *
 * Default date: today (ET).
 * Default mode: NOT dry-run — pass --dry-run to preview without writing.
 *
 * Side effects when not in dry-run:
 *   - Creates missing rows in tasks / orders_sessions via the normal
 *     handlers (handleStart / handleFinish / handleOrdersStart / etc).
 *   - Updates messages.parsed_type for rows whose parse output changed.
 *   - Writes one admin_audit_log row PER message reprocessed, action
 *     'reprocess_day', so the change is auditable.
 *
 * Slack outbound is completely suppressed during the run via a monkey-
 * patch on slack/client.js — postMessage / postToChannel / addReaction /
 * postImage all become no-ops that just record into an in-memory array
 * for the final summary. Silent mode in the DB is NOT touched.
 *
 * Idempotency:
 *   The script checks if a row with slack_start_ts === msg.slack_ts
 *   already exists in tasks/orders_sessions/etc. If yes, the handler is
 *   skipped for that message (treat as already processed). This means
 *   rerunning is safe.
 */

const path = require('path');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dateArg = (args.find((a) => a.startsWith('--date=')) || '').replace('--date=', '');

const todayEt = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const targetDate = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : todayEt();

console.log(`reprocess-day.js — target date: ${targetDate} (${dryRun ? 'DRY RUN' : 'REAL RUN'})`);

// ─── Monkey-patch slack/client.js BEFORE requiring downstream modules ────
const slackClient = require('../src/slack/client');
const blockedCalls = []; // collect what would have been posted
function noopPost(label) {
  return async (...args) => {
    blockedCalls.push({ label, args: args.map((a) => (typeof a === 'string' ? a.slice(0, 100) : a)) });
    return 'reprocess-' + Date.now();
  };
}
slackClient.postMessage   = noopPost('postMessage');
slackClient.postToChannel = noopPost('postToChannel');
slackClient.addReaction   = async () => undefined;
slackClient.postImage     = async () => ({ silent: true });

// Also force isSilent to return false so the wrappers' own guard doesn't
// double-handle. (Doesn't matter functionally since we replaced everything,
// but keeps behavior simple.)
slackClient.invalidateSilentCache();

// ─── Now require everything else (uses the patched client via require cache)
const { Pool } = require('pg');
const { parseMessage } = require('../src/parser');
const taskEngine     = require('../src/tasks');
const ordersEngine   = require('../src/orders');
const formulationEng = require('../src/formulation');
const { auditAction } = require('../src/admin/audit');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const dateExpr = `'${targetDate}'::date`;

  const rowsRes = await pool.query(
    `SELECT slack_ts, user_id, user_name, text, parsed_type, raw_json
     FROM messages
     WHERE (created_at AT TIME ZONE 'America/New_York')::date = ${dateExpr}
       AND text IS NOT NULL
     ORDER BY slack_ts ASC`
  );
  console.log(`\nMessages found for ${targetDate}: ${rowsRes.rows.length}`);

  const summary = {
    examined: 0,
    parseTypeChanged: 0,
    handlerInvoked: 0,
    skippedAlreadyProcessed: 0,
    skippedIgnoreOrUnknown: 0,
    errors: [],
    typeChanges: [],
    handlersByType: {},
  };

  for (const row of rowsRes.rows) {
    summary.examined++;
    const ts = row.slack_ts;
    const text = row.text;
    const oldType = row.parsed_type || 'unknown';

    const msg = {
      ts,
      user: row.user_id || 'U08JC85HMNE',
      username: row.user_name || '',
      text,
    };
    let parsed;
    try { parsed = parseMessage(msg); }
    catch (err) {
      summary.errors.push({ ts, error: 'parse: ' + err.message });
      continue;
    }
    const newType = parsed?.type || 'unknown';

    const typeChanged = oldType !== newType;
    if (typeChanged) {
      summary.parseTypeChanged++;
      summary.typeChanges.push({ ts, oldType, newType, text: text.slice(0, 80) });
    }

    // Skip non-action types — but record if the TYPE changed (we still want
    // to update messages.parsed_type so the column reflects reality).
    if (!parsed || newType === 'ignore' || newType === 'unknown' || newType === 'note') {
      summary.skippedIgnoreOrUnknown++;
      if (typeChanged && !dryRun) {
        try {
          await pool.query('UPDATE messages SET parsed_type = $1 WHERE slack_ts = $2', [newType, ts]);
        } catch (err) {
          summary.errors.push({ ts, error: 'update_parsed_type: ' + err.message });
        }
      }
      continue;
    }

    // Idempotency: did this slack_ts already produce its expected DB row?
    const alreadyHas = await alreadyProduced(parsed, ts);
    if (alreadyHas) {
      summary.skippedAlreadyProcessed++;
      continue;
    }

    if (dryRun) {
      summary.handlerInvoked++;
      summary.handlersByType[newType] = (summary.handlersByType[newType] || 0) + 1;
      continue;
    }

    // Real run — invoke the handler
    try {
      await dispatch(parsed, msg);
      summary.handlerInvoked++;
      summary.handlersByType[newType] = (summary.handlersByType[newType] || 0) + 1;
      if (typeChanged) {
        await pool.query('UPDATE messages SET parsed_type = $1 WHERE slack_ts = $2', [newType, ts]);
      }
      // Audit
      await auditAction({
        req: null, source: 'cron',
        action: 'reprocess_day',
        entityType: 'message',
        entityId: ts,
        before: { parsed_type: oldType, text: text.slice(0, 200) },
        after:  { parsed_type: newType, dispatched_to: newType, supplement: parsed.supplement || null, operator: parsed.operator || null },
      });
    } catch (err) {
      summary.errors.push({ ts, error: 'dispatch: ' + err.message });
    }
  }

  await pool.end();

  console.log('\n==== SUMMARY ====');
  console.log(`Examined           : ${summary.examined}`);
  console.log(`Parsed type changed: ${summary.parseTypeChanged}`);
  console.log(`Handlers invoked   : ${summary.handlerInvoked} ${dryRun ? '(would invoke)' : ''}`);
  console.log(`Already processed  : ${summary.skippedAlreadyProcessed}`);
  console.log(`Ignore/unknown     : ${summary.skippedIgnoreOrUnknown}`);
  console.log(`Errors             : ${summary.errors.length}`);
  console.log(`\nHandlers by type:`);
  for (const [t, n] of Object.entries(summary.handlersByType)) console.log(`  ${t}: ${n}`);
  if (summary.typeChanges.length > 0) {
    console.log(`\nType changes (first 20):`);
    for (const c of summary.typeChanges.slice(0, 20)) {
      console.log(`  [${c.ts}] ${c.oldType} → ${c.newType}: ${c.text}`);
    }
  }
  if (summary.errors.length > 0) {
    console.log(`\nErrors (first 10):`);
    for (const e of summary.errors.slice(0, 10)) console.log(`  [${e.ts}] ${e.error}`);
  }
  console.log(`\nSlack calls that WOULD have gone out (suppressed): ${blockedCalls.length}`);
  for (const c of blockedCalls.slice(0, 10)) {
    console.log(`  [${c.label}] ${JSON.stringify(c.args).slice(0, 140)}`);
  }
  if (dryRun) console.log('\n(dry run — nothing was written)');
}

async function alreadyProduced(parsed, ts) {
  switch (parsed.type) {
    case 'start':
    case 'finish': {
      const r = await pool.query('SELECT 1 FROM tasks WHERE slack_start_ts = $1 OR slack_end_ts = $1 LIMIT 1', [ts]);
      return r.rows.length > 0;
    }
    case 'orders_start':
    case 'orders_finish':
    case 'orders_continue': {
      const r = await pool.query('SELECT 1 FROM orders_sessions WHERE slack_start_ts = $1 OR slack_end_ts = $1 LIMIT 1', [ts]);
      return r.rows.length > 0;
    }
    case 'formulation_start':
    case 'formulation_finish': {
      const r = await pool.query('SELECT 1 FROM formulation_sessions WHERE slack_start_ts = $1 OR slack_end_ts = $1 LIMIT 1', [ts]);
      return r.rows.length > 0;
    }
    case 'count': {
      const r = await pool.query('SELECT 1 FROM production_counts WHERE slack_ts = $1 LIMIT 1', [ts]);
      return r.rows.length > 0;
    }
    case 'pause_start':
    case 'pause_end': {
      const r = await pool.query('SELECT 1 FROM pauses WHERE slack_ts = $1 LIMIT 1', [ts]);
      return r.rows.length > 0;
    }
    default:
      return false;
  }
}

async function dispatch(parsed, msg) {
  switch (parsed.type) {
    case 'orders_start':    return ordersEngine.handleOrdersStart(parsed, msg);
    case 'orders_finish':   return ordersEngine.handleOrdersFinish(parsed, msg);
    case 'orders_continue': return ordersEngine.handleOrdersStart({ ...parsed, ts: msg.ts }, msg);
    case 'formulation_start':  return formulationEng.handleFormulationStart(parsed, msg);
    case 'formulation_finish': return formulationEng.handleFormulationFinish(parsed, msg);
    default:                return taskEngine.handleParsed(parsed, msg);
  }
}

main().catch((err) => {
  console.error('FATAL:', err.stack || err.message);
  pool.end().catch(() => {});
  process.exit(1);
});
