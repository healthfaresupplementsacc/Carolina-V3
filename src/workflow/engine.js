'use strict';
/**
 * Entrega 3 — Workflow engine.
 *
 * Single source of truth for transitions: starting a phase, joining a
 * phase, leaving for another activity, closing a phase. Each primitive
 * keeps the operator_activity_log invariant intact:
 *   "Each operator_id has AT MOST ONE row with ended_at IS NULL".
 *
 * Functions in this module DO NOT post to Slack. The wrappers in
 * src/workflow/announce.js do that (Fase 8). Engine only touches the DB.
 */

const db = require('../db');

/**
 * Close the operator's currently active operator_activity_log row.
 * Returns { id, activity_type, phase_instance_id, ad_hoc_task_instance_id }
 * of the row that was closed, or null if none was active.
 *
 * If `linkToNewLogId` is given, the closed row's left_for_id is set so
 * the dashboard can show the transition pair.
 */
async function closeActiveOal(operatorId, when, linkToNewLogId = null) {
  const cur = await db.query(
    `SELECT id, activity_type, phase_instance_id, ad_hoc_task_instance_id, pause_id, started_at
     FROM operator_activity_log
     WHERE operator_id = $1 AND ended_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [operatorId]
  );
  if (cur.rows.length === 0) return null;
  const prev = cur.rows[0];
  await db.query(
    `UPDATE operator_activity_log
     SET ended_at = $1::timestamptz,
         duration_seconds = EXTRACT(EPOCH FROM ($1::timestamptz - started_at))::int,
         left_for_id = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [when, linkToNewLogId, prev.id]
  );
  return prev;
}

/**
 * Open a new operator_activity_log row. Caller is responsible for having
 * already closed any previous active row (typically via closeActiveOal).
 */
async function openOal({
  operatorId, activityType,
  phaseInstanceId = null, adHocTaskInstanceId = null, pauseId = null,
  role = null, comeBackFromId = null, when = null, notes = null,
}) {
  const r = await db.query(
    `INSERT INTO operator_activity_log
       (operator_id, activity_type, phase_instance_id, ad_hoc_task_instance_id,
        pause_id, started_at, role, came_back_from_id, notes)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7, $8, $9)
     RETURNING id`,
    [operatorId, activityType, phaseInstanceId, adHocTaskInstanceId,
     pauseId, when, role, comeBackFromId, notes]
  );
  return r.rows[0].id;
}

/**
 * Check soft prerequisites for a phase_template. Returns:
 *   { ok: true,  violatedPrereqs: [] }                 — all good
 *   { ok: false, violatedPrereqs: [phase_names...], block: bool }
 *
 * When block=true (soft_prereq=false on the template), the caller MUST
 * reject the start. When block=false (soft), caller is free to proceed
 * but should call announcePrereqWarning so admin gets a heads-up.
 */
async function checkPrereqs(workflowInstanceId, phaseTemplateId) {
  const tpl = await db.query(
    `SELECT prerequisite_phase_ids, prerequisite_mode, soft_prereq
     FROM phase_templates WHERE id = $1`,
    [phaseTemplateId]
  );
  if (tpl.rows.length === 0) return { ok: true, violatedPrereqs: [], block: false };
  const { prerequisite_phase_ids, prerequisite_mode, soft_prereq } = tpl.rows[0];
  const prereqIds = Array.isArray(prerequisite_phase_ids) ? prerequisite_phase_ids
                  : JSON.parse(prerequisite_phase_ids || '[]');
  if (prereqIds.length === 0) return { ok: true, violatedPrereqs: [], block: false };

  // Find which of the prereq phases are already closed for this workflow
  const closed = await db.query(
    `SELECT pt.id, pt.name
     FROM phase_templates pt
     JOIN phase_instances pi ON pi.phase_template_id = pt.id
                            AND pi.workflow_instance_id = $1
                            AND pi.status = 'closed'
     WHERE pt.id = ANY($2::int[])
     GROUP BY pt.id, pt.name`,
    [workflowInstanceId, prereqIds]
  );
  const closedIds = new Set(closed.rows.map((r) => r.id));

  let ok;
  let violated = [];
  if (prerequisite_mode === 'any') {
    ok = closedIds.size >= 1;
    if (!ok) {
      const allNames = await db.query(
        `SELECT name FROM phase_templates WHERE id = ANY($1::int[])`,
        [prereqIds]
      );
      violated = allNames.rows.map((r) => r.name);
    }
  } else {
    // mode = 'all'
    const missing = prereqIds.filter((id) => !closedIds.has(id));
    ok = missing.length === 0;
    if (!ok) {
      const names = await db.query(
        `SELECT name FROM phase_templates WHERE id = ANY($1::int[])`,
        [missing]
      );
      violated = names.rows.map((r) => r.name);
    }
  }
  return { ok, violatedPrereqs: violated, block: !ok && soft_prereq === false };
}

/**
 * Start a phase: opens phase_instance + operator_activity_log row for the
 * starter. Returns { phaseInstanceId, oalId, prereqWarning }. prereqWarning
 * is the list of unmet soft prereqs (call announcePrereqWarning on it).
 *
 * Caller decides the workflow_instance_id (typically by detecting an
 * existing open workflow_instance OR creating a new one — see
 * findOrCreateWorkflowInstance).
 */
async function startPhase({
  workflowInstanceId, phaseTemplateId, operatorId,
  batchNumber = null, when = null, notes = null,
}) {
  if (!Number.isFinite(workflowInstanceId)) throw new Error('workflowInstanceId required');
  if (!Number.isFinite(phaseTemplateId))    throw new Error('phaseTemplateId required');
  if (!Number.isFinite(operatorId))         throw new Error('operatorId required');

  const prereq = await checkPrereqs(workflowInstanceId, phaseTemplateId);
  if (prereq.block) {
    const err = new Error(
      `Pré-requisitos não atendidos: ${prereq.violatedPrereqs.join(', ')}`
    );
    err.code = 'PREREQ_BLOCKED';
    err.violatedPrereqs = prereq.violatedPrereqs;
    throw err;
  }

  const tpl = await db.query('SELECT name FROM phase_templates WHERE id = $1', [phaseTemplateId]);
  const phaseName = tpl.rows[0]?.name || null;

  // Idempotency: if there's already an OPEN phase_instance for this
  // workflow+template with the same starter, return it instead.
  const existing = await db.query(
    `SELECT id FROM phase_instances
     WHERE workflow_instance_id = $1 AND phase_template_id = $2 AND status = 'open'
     ORDER BY id DESC LIMIT 1`,
    [workflowInstanceId, phaseTemplateId]
  );
  let phaseInstanceId;
  if (existing.rows.length > 0) {
    phaseInstanceId = existing.rows[0].id;
  } else {
    const ins = await db.query(
      `INSERT INTO phase_instances
         (workflow_instance_id, phase_template_id, phase_name, batch_number,
          started_at, started_by_operator_id, notes, status)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6, $7, 'open')
       RETURNING id`,
      [workflowInstanceId, phaseTemplateId, phaseName, batchNumber,
       when, operatorId, notes]
    );
    phaseInstanceId = ins.rows[0].id;
  }

  const prev = await closeActiveOal(operatorId, when || new Date().toISOString());
  const oalId = await openOal({
    operatorId, activityType: 'phase',
    phaseInstanceId, role: existing.rows.length > 0 ? 'joiner' : 'starter',
    comeBackFromId: prev?.id || null, when,
  });
  if (prev) {
    await db.query(
      `UPDATE operator_activity_log SET left_for_id = $1 WHERE id = $2`,
      [oalId, prev.id]
    );
  }

  return {
    phaseInstanceId, oalId, joined: existing.rows.length > 0,
    prereqWarning: prereq.ok ? null : prereq.violatedPrereqs,
  };
}

/**
 * Operator joins an already-open phase. Closes any current activity and
 * opens a new oal row pointing at the phase. The phase_instance itself
 * doesn't change (still owned by its starter).
 */
async function joinPhase({ phaseInstanceId, operatorId, when = null }) {
  if (!Number.isFinite(phaseInstanceId)) throw new Error('phaseInstanceId required');
  if (!Number.isFinite(operatorId))      throw new Error('operatorId required');

  const ph = await db.query(
    `SELECT id, status FROM phase_instances WHERE id = $1`,
    [phaseInstanceId]
  );
  if (ph.rows.length === 0 || ph.rows[0].status !== 'open') {
    throw new Error('phase_instance not open');
  }

  const prev = await closeActiveOal(operatorId, when || new Date().toISOString());
  const oalId = await openOal({
    operatorId, activityType: 'phase',
    phaseInstanceId, role: 'joiner',
    comeBackFromId: prev?.id || null, when,
  });
  if (prev) {
    await db.query(
      `UPDATE operator_activity_log SET left_for_id = $1 WHERE id = $2`,
      [oalId, prev.id]
    );
  }
  return { oalId };
}

/**
 * Operator leaves their current activity without starting a new one
 * (transitions to idle). The phase or ad-hoc itself stays open if there
 * are other operators in it.
 */
async function leaveCurrent({ operatorId, when = null, goToIdle = true }) {
  if (!Number.isFinite(operatorId)) throw new Error('operatorId required');
  const prev = await closeActiveOal(operatorId, when || new Date().toISOString());
  if (!prev) return { previousOalId: null, newOalId: null };
  let newOalId = null;
  if (goToIdle) {
    newOalId = await openOal({
      operatorId, activityType: 'idle',
      comeBackFromId: prev.id, when,
    });
    await db.query(
      `UPDATE operator_activity_log SET left_for_id = $1 WHERE id = $2`,
      [newOalId, prev.id]
    );
  }
  return { previousOalId: prev.id, newOalId };
}

/**
 * Close a phase: mark the phase_instance status='closed' and close every
 * active operator_activity_log row that points at it. Optionally records
 * final_bottle_count and the closer's id.
 *
 * Returns the list of operator ids that were active when the phase closed
 * so the caller can render "Trabalharam juntos: X, Y, Z".
 */
async function closePhase({
  phaseInstanceId, closedByOperatorId = null, finalBottleCount = null, when = null,
}) {
  if (!Number.isFinite(phaseInstanceId)) throw new Error('phaseInstanceId required');
  const endedAt = when || new Date().toISOString();

  const ph = await db.query(
    `SELECT id, status, started_at, workflow_instance_id, phase_name
     FROM phase_instances WHERE id = $1`,
    [phaseInstanceId]
  );
  if (ph.rows.length === 0) throw new Error('phase_instance not found');
  if (ph.rows[0].status !== 'open') {
    return { alreadyClosed: true, participants: [] };
  }

  // Close the phase
  await db.query(
    `UPDATE phase_instances
     SET status = 'closed',
         ended_at = $1::timestamptz,
         closed_by_operator_id = $2,
         final_bottle_count = COALESCE($3, final_bottle_count),
         updated_at = NOW()
     WHERE id = $4`,
    [endedAt, closedByOperatorId, finalBottleCount, phaseInstanceId]
  );

  // Close every active oal row pointing at this phase
  const closeRes = await db.query(
    `UPDATE operator_activity_log
     SET ended_at = $1::timestamptz,
         duration_seconds = EXTRACT(EPOCH FROM ($1::timestamptz - started_at))::int,
         updated_at = NOW()
     WHERE phase_instance_id = $2 AND ended_at IS NULL
     RETURNING id, operator_id`,
    [endedAt, phaseInstanceId]
  );

  // Collect everyone who participated (closed or otherwise)
  const everyone = await db.query(
    `SELECT DISTINCT oal.operator_id, o.name
     FROM operator_activity_log oal
     JOIN operators o ON o.id = oal.operator_id
     WHERE oal.phase_instance_id = $1`,
    [phaseInstanceId]
  );

  return {
    alreadyClosed: false,
    workflowInstanceId: ph.rows[0].workflow_instance_id,
    phaseName: ph.rows[0].phase_name,
    closedOalRows: closeRes.rows,
    participants: everyone.rows.map((r) => ({ id: r.operator_id, name: r.name })),
  };
}

/**
 * Find or create a workflow_instance for a given (template, product, batch).
 * When an active instance already matches, returns its id with `created=false`.
 * This is the primitive App Home uses when an operator starts a phase: the
 * system tries to reuse a running batch rather than open a duplicate.
 */
async function findOrCreateWorkflowInstance({
  workflowTemplateId, productId = null, productName = null,
  batchNumber = null, startedByOperatorId = null, when = null,
  destination = null, passNumber = null,
}) {
  if (!Number.isFinite(workflowTemplateId)) throw new Error('workflowTemplateId required');

  // Try matching active instance by product+batch first (when both set)
  if (productId || productName) {
    const params = [workflowTemplateId];
    let cond = `workflow_template_id = $1 AND status = 'active'`;
    if (Number.isFinite(productId)) {
      cond += ` AND product_id = $${params.length + 1}`;
      params.push(productId);
    } else {
      cond += ` AND product_name = $${params.length + 1}`;
      params.push(productName);
    }
    if (batchNumber) {
      cond += ` AND batch_number = $${params.length + 1}`;
      params.push(batchNumber);
    }
    const existing = await db.query(
      `SELECT id FROM workflow_instances WHERE ${cond} ORDER BY id DESC LIMIT 1`,
      params
    );
    if (existing.rows.length > 0) {
      return { workflowInstanceId: existing.rows[0].id, created: false };
    }
  }

  const ins = await db.query(
    `INSERT INTO workflow_instances
       (workflow_template_id, product_id, product_name, batch_number,
        destination, pass_number, started_at, started_by_operator_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()), $8, 'active')
     RETURNING id`,
    [workflowTemplateId, productId, productName, batchNumber,
     destination, passNumber, when, startedByOperatorId]
  );
  return { workflowInstanceId: ins.rows[0].id, created: true };
}

/**
 * Find or create an ad_hoc_tasks entry by name. When the name is not in
 * the catalog, creates it with admin_approved=false so the admin chat
 * alert can surface it for review (Princípio R4 / R8).
 *
 * Match is case-insensitive on name to avoid duplicate "Limpeza" vs
 * "limpeza" entries.
 */
async function findOrCreateAdHocTask({ name, createdByOperatorId = null }) {
  if (!name || !name.trim()) throw new Error('name required');
  const trimmed = name.trim();
  const existing = await db.query(
    `SELECT id, name, admin_approved FROM ad_hoc_tasks
     WHERE LOWER(name) = LOWER($1) AND is_active = TRUE
     ORDER BY admin_approved DESC, id ASC
     LIMIT 1`,
    [trimmed]
  );
  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, name: existing.rows[0].name,
             adminApproved: existing.rows[0].admin_approved, created: false };
  }
  const ins = await db.query(
    `INSERT INTO ad_hoc_tasks (name, is_active, admin_approved, created_by_operator_id)
     VALUES ($1, TRUE, FALSE, $2)
     RETURNING id, name`,
    [trimmed, createdByOperatorId]
  );
  return { id: ins.rows[0].id, name: ins.rows[0].name,
           adminApproved: false, created: true };
}

/**
 * Try to extract a Formulação (FO-NNNN) batch identifier from a message
 * and find a workflow_instance + Contagem phase to link a "Reporte no
 * sistema" instance to. Returns:
 *   { matched: true, workflowInstanceId, phaseInstanceId? }   when found
 *   { matched: false }                                        otherwise
 *
 * Implements the "fallback duplo" approved by Bruno: if we can tie the
 * Reporte to a real batch's Contagem, we do; otherwise the ad-hoc
 * instance stands alone.
 */
async function resolveReporteLink({ text }) {
  if (!text) return { matched: false };
  const m = text.match(/FO[-\s]?\d{4,6}/i);
  if (!m) return { matched: false };
  const foCode = m[0].toUpperCase().replace(/\s/g, '').replace(/^FO(\d)/, 'FO-$1');

  // Most batches use FO-00xxx in the existing data; match either the raw
  // suffix (00614) or the full code in workflow_instances.batch_number.
  const tail = foCode.replace(/^FO-?/, '');
  const wf = await db.query(
    `SELECT id FROM workflow_instances
     WHERE status IN ('active', 'closed')
       AND (batch_number = $1 OR batch_number = $2 OR batch_number LIKE $3)
     ORDER BY started_at DESC LIMIT 1`,
    [foCode, tail, `%${tail}%`]
  );
  if (wf.rows.length === 0) return { matched: false };
  const workflowInstanceId = wf.rows[0].id;

  // Find a Contagem phase_instance on this workflow (open or closed)
  const ph = await db.query(
    `SELECT pi.id FROM phase_instances pi
     JOIN phase_templates pt ON pt.id = pi.phase_template_id
     WHERE pi.workflow_instance_id = $1
       AND pt.name = 'Contagem'
       AND pi.status <> 'deleted'
     ORDER BY pi.started_at DESC LIMIT 1`,
    [workflowInstanceId]
  );
  return {
    matched: true,
    workflowInstanceId,
    phaseInstanceId: ph.rows[0]?.id || null,
  };
}

/**
 * Start an ad-hoc task instance for an operator. Closes the operator's
 * previous activity and opens a new oal row of activity_type='ad_hoc'.
 *
 * Optionally tries to link to a workflow_instance via `text` (used by
 * "Reporte no sistema" — if the message mentions FO-NNNN and we can
 * find the batch, fill linked_workflow_instance_id + linked_phase_instance_id).
 */
async function startAdHocTask({
  taskName, operatorId, text = null, when = null, notes = null,
  createdByOperatorId = null,
}) {
  if (!Number.isFinite(operatorId)) throw new Error('operatorId required');
  const task = await findOrCreateAdHocTask({
    name: taskName, createdByOperatorId: createdByOperatorId || operatorId,
  });

  let linkedWorkflowInstanceId = null, linkedPhaseInstanceId = null;
  if (/^reporte/i.test(task.name) || /quantidade.*sistema/i.test(text || '')) {
    const link = await resolveReporteLink({ text });
    if (link.matched) {
      linkedWorkflowInstanceId = link.workflowInstanceId;
      linkedPhaseInstanceId = link.phaseInstanceId;
    }
  }

  const ins = await db.query(
    `INSERT INTO ad_hoc_task_instances
       (ad_hoc_task_id, task_name, status, started_at, started_by_operator_id,
        linked_workflow_instance_id, linked_phase_instance_id, notes)
     VALUES ($1, $2, 'open', COALESCE($3::timestamptz, NOW()), $4, $5, $6, $7)
     RETURNING id`,
    [task.id, task.name, when, operatorId,
     linkedWorkflowInstanceId, linkedPhaseInstanceId, notes]
  );
  const adHocTaskInstanceId = ins.rows[0].id;

  const prev = await closeActiveOal(operatorId, when || new Date().toISOString());
  const oalId = await openOal({
    operatorId, activityType: 'ad_hoc', adHocTaskInstanceId,
    role: 'starter', comeBackFromId: prev?.id || null, when,
  });
  if (prev) {
    await db.query(
      `UPDATE operator_activity_log SET left_for_id = $1 WHERE id = $2`,
      [oalId, prev.id]
    );
  }

  return {
    adHocTaskInstanceId, oalId, taskId: task.id, taskName: task.name,
    isPending: !task.adminApproved,
    isNewTaskInCatalog: task.created,
    linkedWorkflowInstanceId, linkedPhaseInstanceId,
  };
}

async function closeAdHocTask({
  adHocTaskInstanceId, closedByOperatorId = null, when = null,
}) {
  if (!Number.isFinite(adHocTaskInstanceId)) throw new Error('adHocTaskInstanceId required');
  const endedAt = when || new Date().toISOString();
  const cur = await db.query(
    `SELECT id, status FROM ad_hoc_task_instances WHERE id = $1`,
    [adHocTaskInstanceId]
  );
  if (cur.rows.length === 0) throw new Error('ad_hoc_task_instance not found');
  if (cur.rows[0].status !== 'open') {
    return { alreadyClosed: true, participants: [] };
  }
  await db.query(
    `UPDATE ad_hoc_task_instances
     SET status = 'closed', ended_at = $1::timestamptz, closed_by_operator_id = $2, updated_at = NOW()
     WHERE id = $3`,
    [endedAt, closedByOperatorId, adHocTaskInstanceId]
  );
  const closed = await db.query(
    `UPDATE operator_activity_log
     SET ended_at = $1::timestamptz,
         duration_seconds = EXTRACT(EPOCH FROM ($1::timestamptz - started_at))::int,
         updated_at = NOW()
     WHERE ad_hoc_task_instance_id = $2 AND ended_at IS NULL
     RETURNING id, operator_id`,
    [endedAt, adHocTaskInstanceId]
  );
  const everyone = await db.query(
    `SELECT DISTINCT oal.operator_id, o.name
     FROM operator_activity_log oal
     JOIN operators o ON o.id = oal.operator_id
     WHERE oal.ad_hoc_task_instance_id = $1`,
    [adHocTaskInstanceId]
  );
  return {
    alreadyClosed: false,
    closedOalRows: closed.rows,
    participants: everyone.rows.map((r) => ({ id: r.operator_id, name: r.name })),
  };
}

/**
 * Operator starts a break. Closes whatever they were doing, opens a
 * 'break' oal row pointing at the new pauses row. The pauses table
 * stays the legacy/canonical store of break info (reason, slack_ts);
 * oal just mirrors the time-slice for timeline math.
 */
async function startBreak({
  operatorId, reason = null, when = null, slackTs = null,
}) {
  if (!Number.isFinite(operatorId)) throw new Error('operatorId required');
  const ts = when || new Date().toISOString();

  // Insert pauses row (legacy table — preserved for backward-compat).
  // task_id stays null in the new model (engine handles association via oal).
  const pauseRes = await db.query(
    `INSERT INTO pauses (operator, reason, started_at, slack_ts)
     SELECT name, $2, $3::timestamptz, $4 FROM operators WHERE id = $1
     RETURNING id`,
    [operatorId, reason, ts, slackTs]
  );
  const pauseId = pauseRes.rows[0]?.id || null;

  const prev = await closeActiveOal(operatorId, ts);
  const oalId = await openOal({
    operatorId, activityType: 'break',
    pauseId, role: null, comeBackFromId: prev?.id || null, when: ts, notes: reason,
  });
  if (prev) {
    await db.query(
      `UPDATE operator_activity_log SET left_for_id = $1 WHERE id = $2`,
      [oalId, prev.id]
    );
  }
  return { pauseId, oalId, previousOalId: prev?.id || null };
}

/**
 * Operator returns from break. Closes the 'break' oal and pauses row,
 * opens an 'idle' oal so the operator becomes available again. Caller
 * can then immediately call startPhase / joinPhase / startAdHocTask if
 * they meant to resume work.
 */
async function endBreak({ operatorId, when = null }) {
  if (!Number.isFinite(operatorId)) throw new Error('operatorId required');
  const ts = when || new Date().toISOString();

  // Find current break oal
  const cur = await db.query(
    `SELECT id, pause_id, started_at
     FROM operator_activity_log
     WHERE operator_id = $1 AND ended_at IS NULL AND activity_type = 'break'
     ORDER BY id DESC LIMIT 1`,
    [operatorId]
  );
  if (cur.rows.length === 0) return { wasOnBreak: false };
  const prev = cur.rows[0];

  await db.query(
    `UPDATE operator_activity_log
     SET ended_at = $1::timestamptz,
         duration_seconds = EXTRACT(EPOCH FROM ($1::timestamptz - started_at))::int,
         updated_at = NOW()
     WHERE id = $2`,
    [ts, prev.id]
  );
  if (prev.pause_id) {
    await db.query(
      `UPDATE pauses SET ended_at = $1::timestamptz, ended_reason = 'manual_return'
       WHERE id = $2 AND ended_at IS NULL`,
      [ts, prev.pause_id]
    );
  }
  const idleOal = await openOal({
    operatorId, activityType: 'idle',
    comeBackFromId: prev.id, when: ts,
  });
  await db.query(
    `UPDATE operator_activity_log SET left_for_id = $1 WHERE id = $2`,
    [idleOal, prev.id]
  );
  return {
    wasOnBreak: true, previousOalId: prev.id, idleOalId: idleOal,
    pauseId: prev.pause_id,
    durationSeconds: Math.round((new Date(ts) - new Date(prev.started_at)) / 1000),
  };
}

/**
 * Get the operator's current activity (single row). Returns null when
 * they have nothing open (clocked out / never clocked in today).
 */
async function getCurrentActivity(operatorId) {
  const r = await db.query(
    `SELECT oal.id, oal.activity_type, oal.started_at, oal.role,
            oal.phase_instance_id, oal.ad_hoc_task_instance_id, oal.pause_id,
            pi.phase_name, pi.batch_number,
            wi.product_name, wi.id AS workflow_instance_id,
            ati.task_name AS ad_hoc_name
     FROM operator_activity_log oal
     LEFT JOIN phase_instances pi ON pi.id = oal.phase_instance_id
     LEFT JOIN workflow_instances wi ON wi.id = pi.workflow_instance_id
     LEFT JOIN ad_hoc_task_instances ati ON ati.id = oal.ad_hoc_task_instance_id
     WHERE oal.operator_id = $1 AND oal.ended_at IS NULL
     ORDER BY oal.id DESC LIMIT 1`,
    [operatorId]
  );
  return r.rows[0] || null;
}

/**
 * F2 — persist a note. Auto-links to the author's currently-open
 * phase/workflow (from operator_activity_log) when there is one.
 * F3 — announces it (channel via postMessage → silent_log when muted,
 * plus an admin mirror).
 */
async function addNote({ operatorId, text, when = null }) {
  if (!Number.isFinite(operatorId)) throw new Error('operatorId required');
  const body = String(text || '').trim();
  if (!body) throw new Error('note text required');

  // Find the author's active activity to auto-link the note.
  const act = await db.query(
    `SELECT phase_instance_id, ad_hoc_task_instance_id
     FROM operator_activity_log
     WHERE operator_id = $1 AND ended_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [operatorId]
  );
  let linkedPhase = act.rows[0]?.phase_instance_id || null;
  let linkedWf = null;
  if (linkedPhase) {
    const w = await db.query(
      `SELECT workflow_instance_id FROM phase_instances WHERE id = $1`,
      [linkedPhase]
    );
    linkedWf = w.rows[0]?.workflow_instance_id || null;
  }

  const ins = await db.query(
    `INSERT INTO operator_notes
       (operator_id, text, linked_phase_instance_id, linked_workflow_instance_id, source, created_at)
     VALUES ($1, $2, $3, $4, 'app_home', COALESCE($5::timestamptz, NOW()))
     RETURNING id`,
    [operatorId, body, linkedPhase, linkedWf, when]
  );

  const opRow = await db.query(`SELECT name FROM operators WHERE id = $1`, [operatorId]);
  try {
    await require('./announce').note({ operatorName: opRow.rows[0]?.name, text: body });
  } catch (e) { /* announce is best-effort */ }

  return { noteId: ins.rows[0].id, linkedPhaseInstanceId: linkedPhase };
}

module.exports = {
  closeActiveOal, openOal, checkPrereqs,
  startPhase, joinPhase, leaveCurrent, closePhase,
  findOrCreateWorkflowInstance,
  findOrCreateAdHocTask, resolveReporteLink,
  startAdHocTask, closeAdHocTask,
  startBreak, endBreak, getCurrentActivity,
  addNote,
};
