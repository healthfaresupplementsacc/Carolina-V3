'use strict';
/**
 * Bug 3 — one-shot cleanup of orphan instances created by the Entrega 3
 * legacy migration. Tasks that were never closed in the old model
 * produced workflow_instances / phase_instances / ad_hoc_task_instances
 * stuck "open" 24h+.
 *
 * Rules:
 *   - phase_instances open & started_at < NOW()-24h
 *       → status='closed', ended_at=started_at+1h,
 *         closed_by_operator_id=NULL, notes append '[auto_cleanup_legacy]'
 *   - same for ad_hoc_task_instances
 *   - workflow_instances whose every non-deleted phase is now closed
 *       → status='closed'
 *   - one admin_audit_log row per closed instance (action='legacy_cleanup')
 *
 * Idempotent: only touches rows still open & older than the cutoff.
 * dryRun=true returns the counts WITHOUT writing.
 */

const db = require('./../db');

async function cleanupLegacyOrphans({ dryRun = true, olderThanHours = 24 } = {}) {
  const cutoffSql = `NOW() - INTERVAL '${parseInt(olderThanHours)} hours'`;

  const phaseSel = await db.query(
    `SELECT id, workflow_instance_id, started_at FROM phase_instances
     WHERE status = 'open' AND started_at < ${cutoffSql}`
  );
  const adhocSel = await db.query(
    `SELECT id, started_at FROM ad_hoc_task_instances
     WHERE status = 'open' AND started_at < ${cutoffSql}`
  );

  if (dryRun) {
    // Predict which workflow_instances would close: those whose every
    // non-deleted phase is closed OR would be closed by this run.
    const closingPhaseIds = new Set(phaseSel.rows.map((r) => r.id));
    const wfIds = [...new Set(phaseSel.rows.map((r) => r.workflow_instance_id).filter(Boolean))];
    let wfWouldClose = 0;
    for (const wfId of wfIds) {
      const phs = await db.query(
        `SELECT id, status FROM phase_instances
         WHERE workflow_instance_id = $1 AND status <> 'deleted'`, [wfId]
      );
      const allClosed = phs.rows.every(
        (p) => p.status === 'closed' || closingPhaseIds.has(p.id)
      );
      const wfRow = await db.query(
        `SELECT status FROM workflow_instances WHERE id = $1`, [wfId]
      );
      if (allClosed && wfRow.rows[0] && wfRow.rows[0].status === 'active') wfWouldClose++;
    }
    return {
      dryRun: true,
      phases_to_close: phaseSel.rows.length,
      adhoc_to_close: adhocSel.rows.length,
      workflows_to_close: wfWouldClose,
    };
  }

  let phasesClosed = 0, adhocClosed = 0, wfClosed = 0;

  for (const ph of phaseSel.rows) {
    await db.query(
      `UPDATE phase_instances
       SET status = 'closed',
           ended_at = started_at + INTERVAL '1 hour',
           closed_by_operator_id = NULL,
           notes = COALESCE(notes,'') ||
             CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE ' ' END ||
             '[auto_cleanup_legacy]',
           updated_at = NOW()
       WHERE id = $1 AND status = 'open'`,
      [ph.id]
    );
    phasesClosed++;
    await db.query(
      `INSERT INTO admin_audit_log (action, entity_type, entity_id, before_data, after_data, source)
       VALUES ('legacy_cleanup', 'phase_instance', $1, $2, $3, 'system')`,
      [String(ph.id),
       JSON.stringify({ status: 'open', started_at: ph.started_at }),
       JSON.stringify({ status: 'closed', reason: 'auto_cleanup_legacy' })]
    );
  }

  for (const a of adhocSel.rows) {
    await db.query(
      `UPDATE ad_hoc_task_instances
       SET status = 'closed',
           ended_at = started_at + INTERVAL '1 hour',
           closed_by_operator_id = NULL,
           notes = COALESCE(notes,'') ||
             CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE ' ' END ||
             '[auto_cleanup_legacy]',
           updated_at = NOW()
       WHERE id = $1 AND status = 'open'`,
      [a.id]
    );
    adhocClosed++;
    await db.query(
      `INSERT INTO admin_audit_log (action, entity_type, entity_id, before_data, after_data, source)
       VALUES ('legacy_cleanup', 'ad_hoc_task_instance', $1, $2, $3, 'system')`,
      [String(a.id),
       JSON.stringify({ status: 'open', started_at: a.started_at }),
       JSON.stringify({ status: 'closed', reason: 'auto_cleanup_legacy' })]
    );
  }

  // Close workflow_instances whose every non-deleted phase is now closed
  const wfIds = [...new Set(phaseSel.rows.map((r) => r.workflow_instance_id).filter(Boolean))];
  for (const wfId of wfIds) {
    const phs = await db.query(
      `SELECT status FROM phase_instances
       WHERE workflow_instance_id = $1 AND status <> 'deleted'`, [wfId]
    );
    const allClosed = phs.rows.length > 0 && phs.rows.every((p) => p.status === 'closed');
    if (!allClosed) continue;
    const upd = await db.query(
      `UPDATE workflow_instances
       SET status = 'closed',
           ended_at = COALESCE(ended_at, NOW()),
           notes = COALESCE(notes,'') ||
             CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE ' ' END ||
             '[auto_cleanup_legacy]',
           updated_at = NOW()
       WHERE id = $1 AND status = 'active'
       RETURNING id`,
      [wfId]
    );
    if (upd.rows.length > 0) {
      wfClosed++;
      await db.query(
        `INSERT INTO admin_audit_log (action, entity_type, entity_id, before_data, after_data, source)
         VALUES ('legacy_cleanup', 'workflow_instance', $1, $2, $3, 'system')`,
        [String(wfId),
         JSON.stringify({ status: 'active' }),
         JSON.stringify({ status: 'closed', reason: 'all phases closed by auto_cleanup_legacy' })]
      );
    }
  }

  return {
    dryRun: false,
    phases_closed: phasesClosed,
    adhoc_closed: adhocClosed,
    workflows_closed: wfClosed,
  };
}

module.exports = { cleanupLegacyOrphans };
