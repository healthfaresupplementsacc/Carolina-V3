'use strict';
/**
 * BUG GHOST — close "ghost" workflow_instances: started > 24h ago, still
 * 'active', and with NO recently-active child phase (no children, or
 * every child phase is also stale/closed). These are old test runs that
 * were never closed; they polluted App Home ("iniciado 75h atrás" with
 * no owner) and Carolina's "19 workflows ativos".
 *
 * Idempotent (only touches status='active'); --dry-run by default.
 *
 * Usage:
 *   node scripts/cleanup-ghost-workflows.js            # dry-run
 *   node scripts/cleanup-ghost-workflows.js --apply    # write
 *   (also runs daily at 03:30 ET via scheduler.runDailyCleanup)
 */

// BUG GHOST-2 — the >24h-only rule left recent junk batches alive
// ("iniciado 2h/3h atrás" with no real work). Refined: a workflow is a
// ghost when it's active+open AND either
//   (a) it's older than 24h (regardless of children), OR
//   (b) it has NO currently-open child phase AND is older than 2h
//       (started, nobody working it, just sitting there).
// Still idempotent (only status='active'); age_hours + reason surface
// in the dry-run so we can see WHO would be closed and how old.
const GHOST_SQL = `
  SELECT wi.id, wi.product_name, wi.batch_number, wi.started_at,
         round(EXTRACT(EPOCH FROM (NOW() - wi.started_at)) / 3600.0, 1) AS age_hours,
         CASE WHEN wi.started_at < NOW() - INTERVAL '24 hours'
              THEN 'older_than_24h' ELSE 'no_open_phase_over_2h' END AS reason
  FROM workflow_instances wi
  WHERE wi.status = 'active' AND wi.ended_at IS NULL
    AND (
      wi.started_at < NOW() - INTERVAL '24 hours'
      OR (
        wi.started_at < NOW() - INTERVAL '2 hours'
        AND NOT EXISTS (
          SELECT 1 FROM phase_instances pi
          WHERE pi.workflow_instance_id = wi.id
            AND pi.status = 'open' AND pi.ended_at IS NULL
        )
      )
    )
  ORDER BY wi.started_at ASC`;

async function findGhosts(db) {
  const r = await db.query(GHOST_SQL);
  return r.rows;
}

/**
 * @param {object} opts
 * @param {boolean} opts.apply  false = dry-run (no writes)
 * @param {object}  opts.db     db with .query (defaults to src/db)
 * @param {string}  opts.source audit source ('cron' | 'script')
 * @returns {Promise<{count:number, ghosts:Array}>}
 */
async function cleanupGhostWorkflows({ apply = false, db, source = 'script' } = {}) {
  db = db || require('../src/db');
  const ghosts = await findGhosts(db);
  if (!apply || ghosts.length === 0) return { count: ghosts.length, ghosts, applied: false };

  let auditAction;
  try { ({ auditAction } = require('../src/admin/audit')); } catch (_) { auditAction = null; }

  for (const g of ghosts) {
    const before = { status: 'active', ended_at: null };
    await db.query(
      `UPDATE workflow_instances
       SET status = 'closed',
           ended_at = started_at + INTERVAL '5 minutes',
           notes = COALESCE(notes, '') || ' [auto_cleanup_ghost]',
           updated_at = NOW()
       WHERE id = $1 AND status = 'active'`,
      [g.id]
    );
    if (auditAction) {
      try {
        await auditAction({
          action: 'ghost_cleanup', entityType: 'workflow_instance',
          entityId: g.id, source,
          before, after: { status: 'closed', reason: '[auto_cleanup_ghost]' },
        });
      } catch (_) { /* audit must never block cleanup */ }
    }
  }
  return { count: ghosts.length, ghosts, applied: true };
}

module.exports = { findGhosts, cleanupGhostWorkflows, GHOST_SQL };

// ─── CLI ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const apply = process.argv.includes('--apply');
  (async () => {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    try {
      const res = await cleanupGhostWorkflows({ apply, db: pool, source: 'script' });
      console.log(`[ghost-cleanup] ${apply ? 'APPLIED' : 'DRY-RUN'} — ${res.count} ghost workflow(s):`);
      for (const g of res.ghosts) {
        console.log(`  #${g.id} ${g.product_name || '?'} ${g.batch_number || ''} `
          + `— ${g.age_hours != null ? g.age_hours + 'h' : '?'} old [${g.reason || '?'}] `
          + `(started ${g.started_at})`);
      }
      if (!apply && res.count > 0) console.log('[ghost-cleanup] re-run with --apply to close them.');
    } catch (e) {
      console.error('[ghost-cleanup] FATAL:', e.message);
      process.exitCode = 1;
    } finally {
      await pool.end().catch(() => {});
    }
  })();
}
