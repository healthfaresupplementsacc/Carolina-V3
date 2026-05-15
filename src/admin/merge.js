'use strict';
/**
 * Task merge — admin selects 2+ tasks that should have been a single one
 * (e.g. someone closed/reopened or sent S twice for the same activity).
 *
 * Rule per master doc §16.2.1 / Entrega 2 §4:
 *   - Survivor = task with the OLDEST started_at.
 *   - ended_at = MOST RECENT ended_at among inputs (NULL if any still open).
 *   - operator = survivor's operator.
 *   - helpers  = union of all distinct (helpers + non-survivor operators).
 *   - production_counts re-point task_id to the survivor.
 *   - Non-survivors are soft-deleted (status='deleted') with a
 *     description prefix noting the merge.
 *   - task_aliases learns the synonym pairs when terms differ.
 */

const db = require('../db');
const { auditAction } = require('./audit');

async function mergeTasks(taskIds, req) {
  if (!Array.isArray(taskIds) || taskIds.length < 2) {
    throw Object.assign(new Error('Forneça pelo menos 2 task IDs'), { status: 400 });
  }
  const uniqIds = [...new Set(taskIds.map((x) => parseInt(x)).filter((x) => !isNaN(x)))];
  if (uniqIds.length < 2) {
    throw Object.assign(new Error('IDs duplicados ou inválidos'), { status: 400 });
  }

  const result = await db.query(
    `SELECT id, operator, supplement_name, batch_number, description, task_type,
            helpers, started_at, ended_at, status, slack_start_ts, slack_end_ts
     FROM tasks
     WHERE id = ANY($1::int[])
     ORDER BY started_at ASC`,
    [uniqIds]
  );
  const tasks = result.rows;
  if (tasks.length !== uniqIds.length) {
    throw Object.assign(new Error('Uma ou mais tasks não encontradas'), { status: 404 });
  }
  for (const t of tasks) {
    if (t.status === 'deleted') {
      throw Object.assign(new Error(`Task #${t.id} já está deletada`), { status: 400 });
    }
  }

  // Survivor: oldest started_at. The query already orders ASC.
  const survivor = tasks[0];
  const others = tasks.slice(1);

  // Most-recent ended_at across all. NULL if any is still open.
  const anyOpen = tasks.some((t) => !t.ended_at);
  const latestEnded = anyOpen
    ? null
    : tasks.reduce((acc, t) => (acc == null || new Date(t.ended_at) > new Date(acc) ? t.ended_at : acc), null);

  // Helpers: union of (existing helpers + other tasks' operators + other tasks' helpers)
  const helperSet = new Set();
  for (const t of tasks) {
    const fromHelpers = (t.helpers || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const h of fromHelpers) helperSet.add(h);
    if (t.id !== survivor.id && t.operator) helperSet.add(t.operator);
  }
  if (survivor.operator) helperSet.delete(survivor.operator); // starter isn't a helper of themselves
  const mergedHelpers = [...helperSet].join(', ') || null;

  // Apply the merge inside a logical transaction. node-postgres is single-pool
  // here so we serialize the statements rather than wrap in BEGIN/COMMIT —
  // good enough for an admin operation and matches the rest of api.js style.

  // 1. Update the survivor
  await db.query(
    `UPDATE tasks
     SET ended_at = ${latestEnded ? "($1::timestamp AT TIME ZONE 'America/New_York')" : 'ended_at'},
         duration_seconds = ${latestEnded
           ? "EXTRACT(EPOCH FROM (($1::timestamp AT TIME ZONE 'America/New_York') - started_at))::int"
           : 'duration_seconds'},
         active_duration_seconds = ${latestEnded
           ? "EXTRACT(EPOCH FROM (($1::timestamp AT TIME ZONE 'America/New_York') - started_at))::int"
           : 'active_duration_seconds'},
         helpers = $${latestEnded ? 2 : 1},
         status  = ${anyOpen ? "'open'" : "'closed'"},
         updated_at = NOW()
     WHERE id = $${latestEnded ? 3 : 2}`,
    latestEnded ? [latestEnded, mergedHelpers, survivor.id] : [mergedHelpers, survivor.id]
  );

  // 2. Re-point production_counts of others → survivor
  if (others.length > 0) {
    await db.query(
      `UPDATE production_counts SET task_id = $1 WHERE task_id = ANY($2::int[])`,
      [survivor.id, others.map((t) => t.id)]
    );
  }

  // 3. Soft-delete the non-survivors with a merge marker on description.
  for (const t of others) {
    const newDesc = `[merged into #${survivor.id}] ${t.description || ''}`.trim();
    await db.query(
      `UPDATE tasks SET status = 'deleted', description = $1, updated_at = NOW() WHERE id = $2`,
      [newDesc, t.id]
    );
  }

  // 4. Learn aliases. For each non-survivor, if their canonical noun
  //    (supplement_name, else description) differs from survivor's, store
  //    survivor as canonical and the other as alias.
  const survivorTerm = (survivor.supplement_name || survivor.description || '').trim().toLowerCase();
  const learnedAliases = [];
  if (survivorTerm) {
    for (const t of others) {
      const otherTerm = (t.supplement_name || t.description || '').trim().toLowerCase();
      if (otherTerm && otherTerm !== survivorTerm) {
        try {
          await db.query(
            `INSERT INTO task_aliases (canonical_term, alias_term, learned_from_task_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (canonical_term, alias_term) DO NOTHING`,
            [survivor.supplement_name || survivor.description, t.supplement_name || t.description, survivor.id]
          );
          learnedAliases.push({ canonical: survivorTerm, alias: otherTerm });
        } catch (err) {
          console.error('[Merge] alias insert failed:', err.message);
        }
      }
    }
  }

  // 5. Audit a single 'task.merge' entry with full before/after.
  const afterRow = await db.query('SELECT * FROM tasks WHERE id = $1', [survivor.id]);
  await auditAction({
    req,
    action: 'task.merge',
    entityType: 'task',
    entityId: survivor.id,
    before: { tasks },
    after: {
      survivor_id: survivor.id,
      merged_ids: others.map((t) => t.id),
      survivor_row: afterRow.rows[0] || null,
      learned_aliases: learnedAliases,
    },
  });

  return {
    survivor_id: survivor.id,
    merged_ids: others.map((t) => t.id),
    learned_aliases: learnedAliases,
  };
}

module.exports = { mergeTasks };
