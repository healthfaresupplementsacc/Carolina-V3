'use strict';
/**
 * TAREFA 2 — cleanup de batches/fases/ad-hoc abertos há > 8h (lixo do
 * dia 18). Soft-close (NÃO deleta): status='closed', ended_at=NOW,
 * notes += ' [auto_cleanup_>8h]'. Para workflow_instance, fecha também
 * as phase_instances filhas abertas + os oal abertos delas (operador
 * não fica preso). Idempotente (só toca quem ainda está aberto).
 *
 * SEGURANÇA: --dry-run default. --apply exige ADMIN_CONFIRMED=TRUE
 * (mesma trava dos outros cleanups). Bruno aprova via dry-run report.
 * Audita action='operator.cleanup_stale_>8h_apply'.
 *
 *   railway run ... node scripts/cleanup-stale-batches.js            # dry-run
 *   ADMIN_CONFIRMED=TRUE railway run ... node scripts/cleanup-stale-batches.js --apply
 */
const { Pool } = require('pg');
const APPLY = process.argv.includes('--apply');
const H = "started_at < NOW() - INTERVAL '8 hours'";

const SQL = {
  wf: `SELECT id, product_name, batch_number, status,
         round(EXTRACT(EPOCH FROM (NOW()-started_at))/3600.0,1) age_h
       FROM workflow_instances
       WHERE status IN ('open','active') AND ended_at IS NULL AND ${H}
       ORDER BY started_at`,
  phStandalone: `SELECT pi.id, pi.phase_name,
         round(EXTRACT(EPOCH FROM (NOW()-pi.started_at))/3600.0,1) age_h
       FROM phase_instances pi
       WHERE pi.status='open' AND pi.ended_at IS NULL AND pi.${H}
         AND pi.workflow_instance_id NOT IN (
           SELECT id FROM workflow_instances
           WHERE status IN ('open','active') AND ended_at IS NULL AND ${H})
       ORDER BY pi.started_at`,
  ah: `SELECT id, task_name,
         round(EXTRACT(EPOCH FROM (NOW()-started_at))/3600.0,1) age_h
       FROM ad_hoc_task_instances
       WHERE status='open' AND ended_at IS NULL AND ${H}
       ORDER BY started_at`,
};

async function findStale(db) {
  return {
    workflows: (await db.query(SQL.wf)).rows,
    phasesStandalone: (await db.query(SQL.phStandalone)).rows,
    adhoc: (await db.query(SQL.ah)).rows,
  };
}

async function cleanup({ apply = false, db, source = 'script' } = {}) {
  db = db || require('../src/db');
  const stale = await findStale(db);
  const total = stale.workflows.length + stale.phasesStandalone.length + stale.adhoc.length;
  if (!apply || total === 0) return { ...stale, total, applied: false };

  let auditAction;
  try { ({ auditAction } = require('../src/admin/audit')); } catch (_) { auditAction = null; }
  const NOTE = " [auto_cleanup_>8h]";
  const done = { workflows: [], child_phases: [], phasesStandalone: [], adhoc: [] };

  await db.query('BEGIN');
  try {
    for (const w of stale.workflows) {
      // child open phases of this workflow → close + close their open oal
      const kids = await db.query(
        `SELECT id FROM phase_instances WHERE workflow_instance_id=$1 AND status='open' AND ended_at IS NULL`,
        [w.id]);
      for (const k of kids.rows) {
        await db.query(
          `UPDATE operator_activity_log
             SET ended_at = COALESCE(ended_at, NOW()),
                 duration_seconds = COALESCE(duration_seconds, 0), updated_at = NOW()
           WHERE phase_instance_id=$1 AND ended_at IS NULL`, [k.id]);
        await db.query(
          `UPDATE phase_instances
             SET status='closed', ended_at=NOW(),
                 notes = COALESCE(notes,'') || $2, updated_at=NOW()
           WHERE id=$1 AND status='open'`, [k.id, NOTE]);
        done.child_phases.push(k.id);
      }
      await db.query(
        `UPDATE workflow_instances
           SET status='closed', ended_at=NOW(),
               notes = COALESCE(notes,'') || $2, updated_at=NOW()
         WHERE id=$1 AND status IN ('open','active')`, [w.id, NOTE]);
      done.workflows.push(w.id);
    }
    for (const ph of stale.phasesStandalone) {
      await db.query(
        `UPDATE operator_activity_log SET ended_at=COALESCE(ended_at,NOW()),
            duration_seconds=COALESCE(duration_seconds,0), updated_at=NOW()
         WHERE phase_instance_id=$1 AND ended_at IS NULL`, [ph.id]);
      await db.query(
        `UPDATE phase_instances SET status='closed', ended_at=NOW(),
            notes=COALESCE(notes,'')||$2, updated_at=NOW()
         WHERE id=$1 AND status='open'`, [ph.id, NOTE]);
      done.phasesStandalone.push(ph.id);
    }
    for (const a of stale.adhoc) {
      await db.query(
        `UPDATE ad_hoc_task_instances SET status='closed', ended_at=NOW(),
            notes=COALESCE(notes,'')||$2, updated_at=NOW()
         WHERE id=$1 AND status='open'`, [a.id, NOTE]);
      done.adhoc.push(a.id);
    }
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; }

  if (auditAction) {
    try {
      await auditAction({
        action: 'operator.cleanup_stale_>8h_apply', entityType: 'database',
        entityId: 'stale_batches', source,
        before: { found: { workflows: stale.workflows.map((x) => x.id),
          phasesStandalone: stale.phasesStandalone.map((x) => x.id),
          adhoc: stale.adhoc.map((x) => x.id) } },
        after: { closed: done },
      });
    } catch (_) {}
  }
  return { ...stale, total, applied: true, done };
}

module.exports = { findStale, cleanup, SQL };

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  (async () => {
    const { Pool: P } = require('pg');
    const pool = new P({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      const rep = await cleanup({ apply: false, db: pool });
      console.log(`==== CLEANUP STALE >8h ${apply ? 'APPLY' : 'DRY-RUN'} ====`);
      console.log(`workflows: ${rep.workflows.length} | phases standalone: ${rep.phasesStandalone.length} | ad-hoc: ${rep.adhoc.length}`);
      for (const w of rep.workflows) console.log(`  wf #${w.id} ${w.product_name || '(sem produto)'} ${w.batch_number || ''} ${w.age_h}h [${w.status}]`);
      for (const x of rep.phasesStandalone) console.log(`  phase #${x.id} ${x.phase_name} ${x.age_h}h`);
      for (const x of rep.adhoc) console.log(`  adhoc #${x.id} ${x.task_name} ${x.age_h}h`);
      if (!apply) { console.log('\nDRY-RUN — nada fechado. Aprovação do Bruno + ADMIN_CONFIRMED=TRUE p/ --apply.'); return; }
      if (process.env.ADMIN_CONFIRMED !== 'TRUE') { console.error('\nRECUSADO: --apply exige ADMIN_CONFIRMED=TRUE.'); process.exitCode = 2; return; }
      const r = await cleanup({ apply: true, db: pool, source: 'script' });
      console.log(`\nAPLICADO: wf=${r.done.workflows.length} child_phases=${r.done.child_phases.length} phases=${r.done.phasesStandalone.length} adhoc=${r.done.adhoc.length} (auditado).`);
    } catch (e) { console.error('FATAL:', e.message); process.exitCode = 1; }
    finally { await pool.end().catch(() => {}); }
  })();
}
