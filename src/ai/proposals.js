'use strict';
/**
 * BLOCO C / P4 — Carolina autonomous proposal store.
 *
 * The W6 single-proposal flow (ai/admin-tools.js, app_state 'ai_proposal')
 * stays the execution path: when a proposal is accepted, admin-tools
 * resolveProposal() runs the audited EXEC. This module is the durable,
 * multi-row, *expiring* ledger on top of it — so the cron (P3) can stack
 * several detections, the admin can list what's pending, and stale
 * proposals auto-expire (default 24h, configurable in P7 via app_state
 * 'proposal_window_minutes').
 *
 * status: pending | accepted | rejected | expired
 */
const db = require('../db');

const WINDOW_KEY = 'proposal_window_minutes';
const DEFAULT_WINDOW_MIN = 24 * 60; // 24h (P4 default)

async function getWindowMinutes() {
  try {
    const r = await db.query('SELECT value FROM app_state WHERE key = $1', [WINDOW_KEY]);
    const n = parseInt(r.rows[0] && r.rows[0].value, 10);
    if (!Number.isFinite(n)) return DEFAULT_WINDOW_MIN;
    return Math.min(7 * 24 * 60, Math.max(5, n)); // 5min .. 7d
  } catch (_) { return DEFAULT_WINDOW_MIN; }
}

/** Auto-expire pending proposals older than the configured window. */
async function expireOld() {
  const win = await getWindowMinutes();
  const r = await db.query(
    `UPDATE carolina_proposals
     SET status = 'expired', resolved_at = NOW(), resolved_by = 'system'
     WHERE status = 'pending'
       AND created_at < NOW() - ($1 || ' minutes')::interval
     RETURNING id`,
    [String(win)]
  );
  return r.rows.length;
}

/**
 * Create a proposal. De-dupes: if an identical pending proposal already
 * exists for the same type + target, returns it instead of stacking.
 */
async function create({ proposalType, targetEntityType = null, targetEntityId = null, proposedAction, source = 'cron' }) {
  if (!proposalType) throw new Error('proposalType required');
  await expireOld();
  const dup = await db.query(
    `SELECT * FROM carolina_proposals
     WHERE status = 'pending' AND proposal_type = $1
       AND COALESCE(target_entity_type,'') = COALESCE($2,'')
       AND COALESCE(target_entity_id,'')   = COALESCE($3,'')
     ORDER BY id DESC LIMIT 1`,
    [proposalType, targetEntityType, targetEntityId == null ? null : String(targetEntityId)]
  );
  if (dup.rows[0]) return { ...dup.rows[0], _deduped: true };
  const r = await db.query(
    `INSERT INTO carolina_proposals
       (proposal_type, target_entity_type, target_entity_id, proposed_action, status, source)
     VALUES ($1,$2,$3,$4,'pending',$5)
     RETURNING *`,
    [proposalType, targetEntityType, targetEntityId == null ? null : String(targetEntityId),
     JSON.stringify(proposedAction || {}), source]
  );
  return r.rows[0];
}

async function listPending() {
  await expireOld();
  const r = await db.query(
    `SELECT * FROM carolina_proposals WHERE status = 'pending'
     ORDER BY created_at ASC, id ASC`
  );
  return r.rows;
}

/** Most recent still-pending proposal (used to resolve "fecha essa"/"ignora"). */
async function getLatestPending() {
  const rows = await listPending();
  return rows.length ? rows[rows.length - 1] : null;
}

async function getById(id) {
  const r = await db.query('SELECT * FROM carolina_proposals WHERE id = $1', [id]);
  return r.rows[0] || null;
}

/** Resolve one pending proposal. status ∈ accepted|rejected. */
async function resolve(id, status, resolvedBy = 'slack_admin') {
  const r = await db.query(
    `UPDATE carolina_proposals
     SET status = $2, resolved_at = NOW(), resolved_by = $3
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, status, resolvedBy]
  );
  return r.rows[0] || null;
}

/** Resolve the latest pending proposal (no id needed). */
async function resolveLatest(status, resolvedBy = 'slack_admin') {
  const p = await getLatestPending();
  if (!p) return null;
  return resolve(p.id, status, resolvedBy);
}

module.exports = {
  WINDOW_KEY, DEFAULT_WINDOW_MIN, getWindowMinutes,
  expireOld, create, listPending, getLatestPending, getById,
  resolve, resolveLatest,
};
