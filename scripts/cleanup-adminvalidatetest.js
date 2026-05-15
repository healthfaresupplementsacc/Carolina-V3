'use strict';
/**
 * Coordinated cleanup of AdminValidateTest leftovers.
 *
 *  - tasks/pauses/production_counts already soft-deleted by previous runs
 *    of admin-validate. We just stamp a '[test-data]' marker in their
 *    description/notes so future archaeology is unambiguous.
 *  - orders_sessions #6 is still 'open' — close it + soft-delete + stamp.
 *  - task_aliases learned from test merges ('MergeA_*' ↔ 'MergeB_*') are
 *    hard-deleted: they are pure noise and may pollute future merge
 *    learning. No real users referenced these terms.
 *
 * Idempotent: re-running is a no-op.
 */

const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const NAME = 'AdminValidateTest';
const MARK = '[test-data]';

(async () => {
  console.log('==== CLEANUP RUN ====\n');

  // 1. Stamp tasks
  const tasks = await p.query(
    `UPDATE tasks
     SET description = CASE
           WHEN description IS NULL OR description = '' THEN $2
           WHEN description LIKE $3 THEN description
           ELSE $2 || ' ' || description
         END,
         updated_at = NOW()
     WHERE operator = $1 AND status != 'deleted'
     RETURNING id`,
    [NAME, MARK, MARK + '%']
  );
  const stampTasks = await p.query(
    `UPDATE tasks
     SET description = CASE
           WHEN description IS NULL OR description = '' THEN $2
           WHEN description LIKE $3 THEN description
           ELSE $2 || ' ' || description
         END,
         updated_at = NOW()
     WHERE operator = $1
     RETURNING id`,
    [NAME, MARK, MARK + '%']
  );
  console.log(`tasks stamped with [test-data]: ${stampTasks.rows.length}`);

  // 2. Close + soft-delete orders_session #6 (and any other AdminValidateTest one still open)
  const closeOrders = await p.query(
    `UPDATE orders_sessions
     SET status = 'deleted',
         ended_at = COALESCE(ended_at, NOW()),
         deleted_at = COALESCE(deleted_at, NOW()),
         updated_at = NOW()
     WHERE operator = $1
       AND (status != 'deleted' OR deleted_at IS NULL)
     RETURNING id`,
    [NAME]
  );
  console.log(`orders_sessions closed + soft-deleted: ${closeOrders.rows.length}`);

  // 3. Stamp pauses reason field
  const stampPauses = await p.query(
    `UPDATE pauses
     SET reason = CASE
           WHEN reason IS NULL OR reason = '' THEN $2
           WHEN reason LIKE $3 THEN reason
           ELSE $2 || ' ' || reason
         END
     WHERE operator = $1
     RETURNING id`,
    [NAME, MARK, MARK + '%']
  );
  console.log(`pauses stamped: ${stampPauses.rows.length}`);

  // 4. Hard-delete polluted task_aliases (MergeA_* ↔ MergeB_*)
  const deletedAliases = await p.query(
    `DELETE FROM task_aliases
     WHERE canonical_term LIKE 'MergeA_%' OR alias_term LIKE 'MergeB_%'
        OR canonical_term LIKE 'MergeB_%' OR alias_term LIKE 'MergeA_%'
        OR canonical_term LIKE 'TestSupp_%' OR alias_term LIKE 'TestSupp_%'
        OR canonical_term LIKE '_AdminValidateTest_%' OR alias_term LIKE '_AdminValidateTest_%'
     RETURNING id, canonical_term, alias_term`
  );
  console.log(`task_aliases hard-deleted: ${deletedAliases.rows.length}`);
  for (const r of deletedAliases.rows) {
    console.log(`  #${r.id}: ${r.canonical_term} ↔ ${r.alias_term}`);
  }

  // 5. Confirm post-state
  console.log('\n==== POST-CLEANUP STATE ====');
  console.log('orders_sessions still active for AdminValidateTest:');
  console.table((await p.query(
    `SELECT id, operator, status, deleted_at FROM orders_sessions
     WHERE operator = $1 AND (status != 'deleted' OR deleted_at IS NULL)`, [NAME]
  )).rows);
  console.log('task_aliases mentioning Test/Merge:');
  console.table((await p.query(
    `SELECT id, canonical_term, alias_term FROM task_aliases
     WHERE canonical_term LIKE '%Test%' OR canonical_term LIKE '%Merge%'
        OR alias_term LIKE '%Test%' OR alias_term LIKE '%Merge%'`
  )).rows);
  console.log('tasks NOT stamped with [test-data]:');
  console.table((await p.query(
    `SELECT id, operator, description FROM tasks
     WHERE operator = $1 AND (description IS NULL OR description NOT LIKE $2)`,
    [NAME, MARK + '%']
  )).rows);

  await p.end();
})().catch((e) => { console.error('FATAL:', e.message); p.end().catch(()=>{}); process.exit(1); });
