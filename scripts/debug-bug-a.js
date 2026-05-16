'use strict';
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  console.log('=== workflow_instances batch 1121 ===');
  const wi = await p.query("SELECT id, product_name, batch_number, status, started_at, ended_at, started_by_operator_id, legacy_id FROM workflow_instances WHERE batch_number = '1121' OR product_name ILIKE '%TESTE%' ORDER BY id DESC LIMIT 5");
  console.table(wi.rows);

  console.log('=== phase_instances for those workflows ===');
  if (wi.rows.length) {
    const ids = wi.rows.map((r) => r.id);
    const ph = await p.query(
      `SELECT id, workflow_instance_id, phase_name, status, started_at, ended_at, started_by_operator_id, legacy_id
       FROM phase_instances WHERE workflow_instance_id = ANY($1::int[]) ORDER BY id DESC LIMIT 10`, [ids]);
    console.table(ph.rows);
  }

  console.log('=== ALL open phase_instances (status=open, ended_at null) ===');
  const allOpen = await p.query(
    `SELECT pi.id, pi.phase_name, pi.status, pi.ended_at, pi.legacy_id, pi.started_by_operator_id,
            wi.product_name, wi.batch_number, o.name AS op
     FROM phase_instances pi
     JOIN workflow_instances wi ON wi.id = pi.workflow_instance_id
     LEFT JOIN operators o ON o.id = pi.started_by_operator_id
     WHERE pi.status = 'open' AND pi.ended_at IS NULL
     ORDER BY pi.id DESC LIMIT 15`);
  console.table(allOpen.rows);

  console.log('=== legacy tasks open (for dedup NOT EXISTS check) ===');
  const t = await p.query("SELECT id, operator, supplement_name, status, started_at FROM tasks WHERE status='open' ORDER BY id DESC LIMIT 10");
  console.table(t.rows);

  await p.end();
})().catch((e) => { console.error('FATAL:', e.message); p.end().catch(() => {}); process.exit(1); });
