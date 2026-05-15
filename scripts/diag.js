'use strict';
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const today = "(NOW() AT TIME ZONE 'America/New_York')::date";

  console.log('NOW UTC:', new Date().toISOString());
  console.log('NOW ET :', new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' }));

  console.log('\n=== TASKS today ET ===');
  const tasksRes = await p.query(
    `SELECT id, operator, supplement_name, task_type, status, started_at
     FROM tasks
     WHERE (started_at AT TIME ZONE 'America/New_York')::date = ${today}
     ORDER BY id DESC LIMIT 20`
  );
  console.log(`count: ${tasksRes.rows.length}`);
  console.table(tasksRes.rows);

  console.log('\n=== ORDERS today ET ===');
  const ordRes = await p.query(
    `SELECT id, operator, order_count, status, deleted_at, started_at
     FROM orders_sessions
     WHERE (started_at AT TIME ZONE 'America/New_York')::date = ${today}
     ORDER BY id DESC LIMIT 10`
  );
  console.log(`count: ${ordRes.rows.length}`);
  console.table(ordRes.rows);

  console.log('\n=== COUNTS today ET ===');
  console.table((await p.query(
    `SELECT COUNT(*)::int AS n FROM production_counts WHERE (reported_at AT TIME ZONE 'America/New_York')::date = ${today}`
  )).rows);

  console.log('\n=== app_state ===');
  console.table((await p.query(
    `SELECT key, LEFT(value, 40) AS value, updated_at FROM app_state
     WHERE key IN ('last_processed_ts','silent_mode','backfill_done') ORDER BY key`
  )).rows);

  console.log('\n=== silent_log last 10 ===');
  console.table((await p.query(
    `SELECT id, intended_action, LEFT(intended_text, 40) AS text, created_at FROM silent_log ORDER BY id DESC LIMIT 10`
  )).rows);

  console.log('\n=== messages by parsed_type today ===');
  console.table((await p.query(
    `SELECT parsed_type, COUNT(*)::int AS n FROM messages
     WHERE (created_at AT TIME ZONE 'America/New_York')::date = ${today}
     GROUP BY parsed_type ORDER BY n DESC`
  )).rows);

  await p.end();
})().catch((err) => {
  console.error('FATAL:', err.message);
  p.end().catch(() => {});
  process.exit(1);
});
