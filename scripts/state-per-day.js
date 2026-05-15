'use strict';
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  for (const date of ['2026-05-13', '2026-05-14', '2026-05-15']) {
    console.log(`\n=== ${date} (ET) ===`);

    const tasks = await p.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE status = 'open')::int    AS open,
              COUNT(*) FILTER (WHERE status = 'closed')::int  AS closed,
              COUNT(*) FILTER (WHERE status = 'deleted')::int AS deleted
       FROM tasks
       WHERE (started_at AT TIME ZONE 'America/New_York')::date = $1::date
         AND operator NOT LIKE '%AdminValidate%'`,
      [date]
    );
    console.log('tasks  :', JSON.stringify(tasks.rows[0]));

    const orders = await p.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE status = 'open')::int    AS open,
              COUNT(*) FILTER (WHERE status = 'closed')::int  AS closed,
              COUNT(*) FILTER (WHERE status = 'deleted' OR deleted_at IS NOT NULL)::int AS deleted
       FROM orders_sessions
       WHERE (started_at AT TIME ZONE 'America/New_York')::date = $1::date
         AND operator NOT LIKE '%AdminValidate%'`,
      [date]
    );
    console.log('orders :', JSON.stringify(orders.rows[0]));

    const counts = await p.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(count) FILTER (WHERE deleted_at IS NULL), 0)::int AS total_bottles
       FROM production_counts
       WHERE (reported_at AT TIME ZONE 'America/New_York')::date = $1::date
         AND operator NOT LIKE '%AdminValidate%'`,
      [date]
    );
    console.log('counts :', JSON.stringify(counts.rows[0]));

    const pauses = await p.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active
       FROM pauses
       WHERE (started_at AT TIME ZONE 'America/New_York')::date = $1::date
         AND operator NOT LIKE '%AdminValidate%'`,
      [date]
    );
    console.log('pauses :', JSON.stringify(pauses.rows[0]));

    const formul = await p.query(
      `SELECT COUNT(*)::int AS n
       FROM formulation_sessions
       WHERE (started_at AT TIME ZONE 'America/New_York')::date = $1::date`,
      [date]
    );
    console.log('formul :', JSON.stringify(formul.rows[0]));
  }

  console.log('\n=== reprocess_day audit rows (cumulative since today) ===');
  const aud = await p.query(
    `SELECT COUNT(*)::int AS n FROM admin_audit_log
     WHERE action = 'reprocess_day' AND created_at >= CURRENT_DATE`
  );
  console.log('reprocess_day audit rows today:', aud.rows[0].n);

  await p.end();
})().catch((e) => { console.error('FATAL:', e.message); p.end().catch(()=>{}); process.exit(1); });
