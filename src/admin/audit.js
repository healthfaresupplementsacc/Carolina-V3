'use strict';
/**
 * Admin audit logging.
 *
 * Every write coming through an /admin/* endpoint MUST funnel through
 * auditAction() so the admin_audit_log table has a complete chronology.
 *
 * Failing to write the audit row is NOT fatal — we log the error but never
 * let an audit failure rollback a real admin action.
 */

const db = require('../db');

/**
 * Record one admin action.
 *
 * @param {object}  args
 * @param {object}  [args.req]         Express req (used only to extract IP/UA into request_meta).
 * @param {string}  args.action        Dot-namespaced action key (e.g. 'task.edit').
 * @param {string}  args.entityType    'task' | 'pause' | 'orders_session' | 'production_count'
 *                                     | 'operator' | 'supplement' | 'note' | 'broadcast'
 *                                     | 'app_state' | 'merge' | 'cleanup'.
 * @param {string|number} [args.entityId]   PK of the row, or another identifier (e.g. supplement name).
 * @param {any}     [args.before]      State BEFORE the change (JSON-serializable).
 * @param {any}     [args.after]       State AFTER the change.
 * @param {string}  [args.source='api']  'api' | 'slack_admin' | 'cron' | 'system'.
 * @param {string}  [args.adminUser]   Identifier for the admin (PIN-auth has none — leave null).
 * @returns {Promise<number|null>}     audit_log.id, or null if write failed.
 */
async function auditAction({
  req, action, entityType, entityId,
  before, after, source = 'api', adminUser = null,
}) {
  try {
    const meta = req
      ? {
          ip: req.ip || req.headers?.['x-forwarded-for'] || null,
          ua: req.headers?.['user-agent']?.slice(0, 200) || null,
          path: req.originalUrl || null,
          method: req.method || null,
        }
      : null;

    const result = await db.query(
      `INSERT INTO admin_audit_log
         (admin_user, action, entity_type, entity_id, before_data, after_data, source, request_meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        adminUser,
        action,
        entityType,
        entityId == null ? null : String(entityId),
        before == null ? null : JSON.stringify(before),
        after  == null ? null : JSON.stringify(after),
        source,
        meta == null ? null : JSON.stringify(meta),
      ]
    );
    return result.rows[0]?.id || null;
  } catch (err) {
    // Audit must never block a real admin action — just shout in the logs.
    console.error('[Audit] write failed:', err.message, { action, entityType, entityId });
    return null;
  }
}

/**
 * Convenience: read one row by id so the caller can stuff it into 'before'.
 * Returns null when not found (so the caller doesn't have to defensively check).
 */
async function snapshotRow(table, idColumn, idValue) {
  // table/idColumn are NEVER user-controlled — they come from the calling
  // endpoint code, not from req.body. Safe to interpolate.
  try {
    const r = await db.query(
      `SELECT * FROM ${table} WHERE ${idColumn} = $1 LIMIT 1`,
      [idValue]
    );
    return r.rows[0] || null;
  } catch (err) {
    console.error('[Audit] snapshotRow failed:', err.message);
    return null;
  }
}

/**
 * Centralized PIN check. Each admin route calls this first.
 * Configurable via ADMIN_PIN env var; falls back to legacy '510510'
 * so existing dashboard PIN entry keeps working until the env is set.
 */
function getAdminPin() {
  return process.env.ADMIN_PIN || '510510';
}

function checkPin(req) {
  const supplied = String(req.body?.pin ?? req.query?.pin ?? '');
  return supplied === getAdminPin();
}

module.exports = { auditAction, snapshotRow, getAdminPin, checkPin };
