'use strict';
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const today = "(NOW() AT TIME ZONE 'America/New_York')::date";

  console.log('=== TASKS hoje (real ops, excluindo AdminValidateTest) ===');
  const tasks = await p.query(
    `SELECT id, operator, supplement_name, task_type, status, started_at, ended_at
     FROM tasks
     WHERE (started_at AT TIME ZONE 'America/New_York')::date = ${today}
       AND operator NOT LIKE '%AdminValidate%'
       AND status != 'deleted'
     ORDER BY started_at ASC`
  );
  console.log(`count: ${tasks.rows.length}`);
  console.table(tasks.rows);

  console.log('\n=== ORDERS_SESSIONS hoje (sem deleted) ===');
  const orders = await p.query(
    `SELECT id, operator, helpers, order_count, status, deleted_at, started_at, ended_at, duration_seconds
     FROM orders_sessions
     WHERE (started_at AT TIME ZONE 'America/New_York')::date = ${today}
       AND operator NOT LIKE '%AdminValidate%'
       AND (deleted_at IS NULL)
       AND (status IS NULL OR status != 'deleted')
     ORDER BY started_at ASC`
  );
  console.log(`count: ${orders.rows.length}`);
  console.table(orders.rows);

  console.log('\n=== PENDING_QUESTIONS ATIVAS (app_state pending_q_*) ===');
  const pending = await p.query(
    `SELECT key, LEFT(value, 200) AS value, updated_at FROM app_state
     WHERE key LIKE 'pending_q_%' ORDER BY updated_at DESC`
  );
  console.log(`count: ${pending.rows.length}`);
  for (const r of pending.rows) {
    console.log(`  ${r.key}: ${r.value}`);
    console.log(`    updated_at: ${r.updated_at}`);
  }

  console.log('\n=== audit_log reprocess_day entries ===');
  const audit = await p.query(
    `SELECT COUNT(*)::int AS n FROM admin_audit_log WHERE action = 'reprocess_day' AND created_at::date = CURRENT_DATE`
  );
  console.log(`reprocess_day audit rows today: ${audit.rows[0].n}`);

  console.log('\n=== silent_log hoje ===');
  const silent = await p.query(
    `SELECT COUNT(*)::int AS n FROM silent_log WHERE created_at::date = CURRENT_DATE`
  );
  console.log(`silent_log rows today: ${silent.rows[0].n}`);

  console.log('\n=== silent_mode flag ===');
  const flag = await p.query(`SELECT value, updated_at FROM app_state WHERE key = 'silent_mode'`);
  console.table(flag.rows);

  await p.end();
})().catch((e) => { console.error(e.message); p.end().catch(()=>{}); process.exit(1); });
