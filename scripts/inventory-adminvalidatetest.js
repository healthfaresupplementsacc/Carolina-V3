'use strict';
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const NAME = 'AdminValidateTest';
  const SUPP_LIKE = 'TestSupp_%';
  const MERGE_A_LIKE = 'MergeA_%';
  const MERGE_B_LIKE = 'MergeB_%';
  const CURL_LIKE = '_AdminValidateTest_curl%';
  const SUPP_AV_LIKE = 'TestSupp_AV_%';

  console.log('==== INVENTORY of AdminValidateTest test data ====\n');

  console.log('=== operators ===');
  console.table((await p.query(
    `SELECT id, name, slack_user_id, is_shared_account, active, role, created_at
     FROM operators WHERE name = $1`, [NAME]
  )).rows);

  console.log('\n=== tasks ===');
  console.table((await p.query(
    `SELECT id, operator, supplement_name, batch_number, task_type, status, started_at, ended_at
     FROM tasks
     WHERE operator = $1
        OR supplement_name LIKE $2
        OR supplement_name LIKE $3
        OR supplement_name LIKE $4
        OR supplement_name LIKE $5
     ORDER BY id`,
    [NAME, SUPP_LIKE, MERGE_A_LIKE, MERGE_B_LIKE, CURL_LIKE]
  )).rows);

  console.log('\n=== orders_sessions ===');
  console.table((await p.query(
    `SELECT id, operator, helpers, order_count, status, deleted_at, started_at
     FROM orders_sessions
     WHERE operator = $1 OR helpers ILIKE $2
     ORDER BY id`, [NAME, '%' + NAME + '%']
  )).rows);

  console.log('\n=== production_counts ===');
  console.table((await p.query(
    `SELECT id, supplement_name, count, operator, deleted_at, reported_at
     FROM production_counts
     WHERE operator = $1
        OR supplement_name LIKE $2
        OR supplement_name LIKE $3
     ORDER BY id`, [NAME, SUPP_LIKE, SUPP_AV_LIKE]
  )).rows);

  console.log('\n=== pauses ===');
  console.table((await p.query(
    `SELECT id, operator, reason, started_at, ended_at, ended_reason, deleted_at
     FROM pauses
     WHERE operator = $1
     ORDER BY id`, [NAME]
  )).rows);

  console.log('\n=== supplement_catalog (TestSupp_*, MergeA/B_*) ===');
  console.table((await p.query(
    `SELECT id, canonical_name, aliases, created_at FROM supplement_catalog
     WHERE canonical_name LIKE $1 OR canonical_name LIKE $2 OR canonical_name LIKE $3 OR canonical_name LIKE $4 OR canonical_name LIKE $5
     ORDER BY id`,
    [SUPP_LIKE, SUPP_AV_LIKE, MERGE_A_LIKE, MERGE_B_LIKE, CURL_LIKE]
  )).rows);

  console.log('\n=== task_aliases (canonical/alias mentioning Test/Merge) ===');
  console.table((await p.query(
    `SELECT id, canonical_term, alias_term, learned_from_task_id, learned_at
     FROM task_aliases
     WHERE canonical_term LIKE '%Test%' OR canonical_term LIKE '%Merge%'
        OR alias_term LIKE '%Test%' OR alias_term LIKE '%Merge%'
     ORDER BY id`
  )).rows);

  console.log('\n=== admin_audit_log entry_id pointing to AdminValidateTest entities (count) ===');
  const auditCount = await p.query(
    `SELECT entity_type, action, COUNT(*)::int AS n
     FROM admin_audit_log
     WHERE entity_id IS NOT NULL AND (
        (after_data::text ILIKE '%AdminValidateTest%' OR after_data::text ILIKE '%TestSupp_%' OR after_data::text ILIKE '%Merge_%')
     )
     GROUP BY entity_type, action ORDER BY n DESC`
  );
  console.table(auditCount.rows);

  await p.end();
})().catch((e) => { console.error('FATAL:', e.message); p.end().catch(()=>{}); process.exit(1); });
