'use strict';
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  // The EXACT Bug-4 union query (date=null branch)
  const q = `
    SELECT pi.id, pi.phase_name, pi.batch_number, pi.started_at,
           wi.product_name, o.name AS operator_name,
           (pi.started_at AT TIME ZONE 'America/New_York')::date AS pi_et_date,
           (NOW() AT TIME ZONE 'America/New_York')::date AS today_et
    FROM phase_instances pi
    JOIN workflow_instances wi ON wi.id = pi.workflow_instance_id
    LEFT JOIN operators o ON o.id = pi.started_by_operator_id
    WHERE pi.status = 'open' AND pi.ended_at IS NULL
      AND pi.legacy_id IS NULL
      AND (pi.started_at AT TIME ZONE 'America/New_York')::date = (NOW() AT TIME ZONE 'America/New_York')::date
      AND NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.status = 'open'
          AND COALESCE(t.operator,'') = COALESCE(o.name,'')
          AND COALESCE(t.supplement_name,'') = COALESCE(wi.product_name,'')
          AND ABS(EXTRACT(EPOCH FROM (t.started_at - pi.started_at))) < 180
      )
    ORDER BY pi.started_at DESC`;
  const r = await p.query(q);
  console.log('Bug-4 union query (WITH date filter) returned', r.rows.length, 'rows:');
  console.table(r.rows);

  // Same query WITHOUT the date filter
  const q2 = q.replace(/AND \(pi\.started_at AT TIME ZONE 'America\/New_York'\)::date = \(NOW\(\) AT TIME ZONE 'America\/New_York'\)::date/, '');
  const r2 = await p.query(q2);
  console.log('\nSame query WITHOUT date filter returned', r2.rows.length, 'rows:');
  console.table(r2.rows);

  await p.end();
})().catch((e) => { console.error('FATAL:', e.message); p.end().catch(() => {}); process.exit(1); });
