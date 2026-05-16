'use strict';
/**
 * OPERATOR-CRUD (PARTE D) — expire temporary helpers.
 *
 * A helper is a temporary employee (is_temporary=true) with an
 * expires_at date. Once that date passes it should stop appearing on
 * the board and in the line. This deactivates them (soft — never
 * deletes; history is preserved) and audits action='operator.expired'.
 *
 * Idempotent: only touches is_active=true helpers whose expires_at is
 * already in the past, and the WHERE is re-checked so a second run is a
 * no-op. Runs daily at 03:30 ET via scheduler.runDailyCleanup.
 *
 * Usage:
 *   node scripts/expire-helpers.js            # dry-run
 *   node scripts/expire-helpers.js --apply    # write
 */

const EXPIRED_SQL = `
  SELECT id, name, expires_at
  FROM operators
  WHERE is_temporary = TRUE
    AND is_active = TRUE
    AND expires_at IS NOT NULL
    AND expires_at < NOW()
  ORDER BY expires_at ASC`;

async function findExpiredHelpers(db) {
  const r = await db.query(EXPIRED_SQL);
  return r.rows;
}

/**
 * @param {object} opts
 * @param {boolean} opts.apply  false = dry-run (no writes)
 * @param {object}  opts.db     db with .query (defaults to src/db)
 * @param {string}  opts.source audit source ('cron' | 'script')
 * @returns {Promise<{count:number, helpers:Array, applied:boolean}>}
 */
async function expireHelpers({ apply = false, db, source = 'script' } = {}) {
  db = db || require('../src/db');
  const helpers = await findExpiredHelpers(db);
  if (!apply || helpers.length === 0) {
    return { count: helpers.length, helpers, applied: false };
  }
  let auditAction;
  try { ({ auditAction } = require('../src/admin/audit')); } catch (_) { auditAction = null; }

  for (const h of helpers) {
    await db.query(
      `UPDATE operators
       SET active = FALSE, is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND is_temporary = TRUE AND is_active = TRUE`,
      [h.id]
    );
    if (auditAction) {
      try {
        await auditAction({
          action: 'operator.expired', entityType: 'operator',
          entityId: h.id, source,
          before: { name: h.name, expires_at: h.expires_at, is_active: true },
          after: { is_active: false, reason: 'helper_expired' },
        });
      } catch (_) { /* audit must never block the cleanup */ }
    }
  }
  return { count: helpers.length, helpers, applied: true };
}

module.exports = { findExpiredHelpers, expireHelpers, EXPIRED_SQL };

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
      const res = await expireHelpers({ apply, db: pool, source: 'script' });
      console.log(`[expire-helpers] ${apply ? 'APPLIED' : 'DRY-RUN'} — ${res.count} helper(s):`);
      for (const h of res.helpers) {
        console.log(`  #${h.id} ${h.name} (expirou ${h.expires_at})`);
      }
      if (!apply && res.count > 0) console.log('[expire-helpers] re-run with --apply to deactivate them.');
    } catch (e) {
      console.error('[expire-helpers] FATAL:', e.message);
      process.exitCode = 1;
    } finally {
      await pool.end().catch(() => {});
    }
  })();
}
