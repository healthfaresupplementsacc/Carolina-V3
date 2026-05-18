'use strict';
/**
 * FASE 1 — Canonical dispatcher.
 *
 * THE single writer of the ISA-88 data model. Parser, App Home wizards
 * and Carolina tools all normalize their input to an EventoCanônico
 * (event-schema.js) and call dispatch(). This module:
 *
 *   1. Is idempotent by `source_id` (slack_ts | wizard_event_id |
 *      tool_call_id). `dispatcher_index` maps source_id → the row it
 *      produced. Re-dispatch / Slack edit / reprocess = UPDATE that row,
 *      NEVER a new one. (Resolves L-06: edit → N rows.)
 *   2. Closes/locates the phase the event REFERENCES (target_phase_id
 *      first), not "newest open phase matching the template".
 *      (Resolves "F: LIMPEZA fechou Rutin".)
 *   3. NEVER guesses the operator. operator_id === null → persists what
 *      it can and flags needsDisambiguation so Carolina asks in the
 *      admin chat (Part 6). No reaction/confirmation without a record.
 *   4. NEVER discards a message: type 'note' always lands in
 *      operator_notes, even with a null operator.
 *   5. Audits EVERY upsert (admin_audit_log, action 'dispatcher.upsert').
 *
 * The engine (src/workflow/engine.js) still owns every low-level
 * transition + the operator_activity_log invariant. This module only
 * orchestrates + records idempotency.
 */

const db = require('../db');
const engine = require('../workflow/engine');
const { auditAction } = require('../admin/audit');
const wfDispatcher = require('../workflow/dispatcher');
const { validateEvent, isFinishLike, isStartLike } = require('./event-schema');

// Types that cannot be persisted to ISA-88 without a resolved operator
// (operator_activity_log.operator_id is NOT NULL). 'note' is exempt — it
// is always persisted (never discarded), operator or not.
const OPERATOR_REQUIRED = new Set([
  'start',
  'finish',
  'count',
  'break_start',
  'break_end',
  'helping_start',
  'helping_end',
  'ad_hoc_start',
  'ad_hoc_finish',
]);

async function getIndexRow(sourceId) {
  const r = await db.query(
    `SELECT source_id, source_type, target_table, target_id
       FROM dispatcher_index WHERE source_id = $1`,
    [sourceId]
  );
  return r.rows[0] || null;
}

async function upsertIndex(sourceId, sourceType, targetTable, targetId) {
  await db.query(
    `INSERT INTO dispatcher_index (source_id, source_type, target_table, target_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_id) DO UPDATE
       SET target_table = EXCLUDED.target_table,
           target_id    = EXCLUDED.target_id,
           updated_at   = NOW()`,
    [sourceId, sourceType, targetTable, Number(targetId)]
  );
}

async function audit(ev, op, target, extra) {
  await auditAction({
    action: 'dispatcher.upsert',
    entityType: 'dispatcher',
    entityId: ev.source_id,
    before: null,
    after: {
      op,
      source: `${ev.source_type}:${ev.source_id}`,
      type: ev.type,
      operator_id: ev.operator_id,
      target_table: target?.table || null,
      target_id: target?.id != null ? String(target.id) : null,
      ...(extra || {}),
    },
    source: 'dispatcher',
  });
}

/**
 * Resolve workflow + phase template ids for a start/finish-like event.
 * Prefers the EventoCanônico's explicit workflow_template/phase_template;
 * falls back to the existing parser→template heuristic so parser events
 * that only carry a supplement still route.
 */
async function resolveTemplateForEvent(ev, ctx) {
  if (ev.workflow_template && ev.phase_template) {
    const key = `${ev.workflow_template}::${ev.phase_template}`;
    const phaseTemplateId = ctx.phaseByKey[key] || null;
    return {
      workflowName: ev.workflow_template,
      phaseName: ev.phase_template,
      phaseTemplateId,
      fallbackNoContext: false,
    };
  }
  // Parser-sourced event without explicit templates: reuse the heuristic.
  const parsedLike = {
    type:
      ev.type === 'ad_hoc_start' || ev.type === 'ad_hoc_finish'
        ? 'start'
        : ev.type,
    taskType: ev.metadata?.taskType || null,
    supplement: ev.supplement || null,
    batch: ev.batch || null,
    _phaseHint: ev.phase_template || ev.metadata?.phaseHint || null,
  };
  return wfDispatcher.resolveTemplate(parsedLike, ctx);
}

/**
 * Locate the phase_instance a finish/helping event refers to.
 * Priority: explicit target_phase_id → workflow/phase/supplement/batch
 * match (never a blind "newest open matching template").
 */
async function locateTargetPhase(ev, ctx) {
  if (ev.target_phase_id) {
    const r = await db.query(
      `SELECT id, workflow_instance_id, status FROM phase_instances WHERE id = $1`,
      [ev.target_phase_id]
    );
    if (r.rows[0]) return r.rows[0];
  }
  const tpl = await resolveTemplateForEvent(ev, ctx);
  if (!tpl || !tpl.workflowName || !tpl.phaseName) return null;
  return wfDispatcher.findOpenPhaseInstance({
    workflowName: tpl.workflowName,
    phaseName: tpl.phaseName,
    supplement: ev.supplement || null,
    batch: ev.batch || null,
    ctx,
  });
}

// ─── CREATE path (first time a source_id is seen) ───────────────────────────

async function createForEvent(ev, ctx) {
  const when = ev.timestamp;
  const opId = ev.operator_id;

  switch (ev.type) {
    case 'note': {
      // NEVER discarded. operator_id may be null.
      const sourceMap = {
        parser: 'channel',
        app_home: 'app_home',
        carolina_tool: 'admin',
      };
      const ins = await db.query(
        `INSERT INTO operator_notes (operator_id, text, source, created_at)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()))
         RETURNING id`,
        [opId, ev.raw_text || ev.metadata?.note || '(nota vazia)',
         sourceMap[ev.source_type] || 'channel', when]
      );
      return { table: 'operator_notes', id: ins.rows[0].id, kind: 'note' };
    }

    case 'break_start': {
      const r = await engine.startBreak({
        operatorId: opId,
        reason: ev.metadata?.reason || null,
        when,
        slackTs: ev.source_type === 'parser' ? ev.source_id : null,
      });
      return { table: 'pauses', id: r.pauseId, kind: 'break_start', result: r };
    }

    case 'break_end': {
      const r = await engine.endBreak({ operatorId: opId, when });
      return {
        table: 'pauses',
        id: r.pauseId || null,
        kind: 'break_end',
        result: r,
      };
    }

    case 'helping_start': {
      const target = await locateTargetPhase(ev, ctx);
      if (!target) return { skip: true, reason: 'no open phase to help on' };
      const r = await engine.joinPhase({
        phaseInstanceId: target.id,
        operatorId: opId,
        when,
      });
      return {
        table: 'operator_activity_log',
        id: r.oalId,
        kind: 'helping_start',
        result: r,
      };
    }

    case 'helping_end': {
      const r = await engine.leaveCurrent({ operatorId: opId, when });
      return {
        table: 'operator_activity_log',
        id: r.previousOalId || null,
        kind: 'helping_end',
        result: r,
      };
    }

    case 'ad_hoc_start': {
      const r = await engine.startAdHocTask({
        taskName: ev.ad_hoc_task || 'Outro',
        operatorId: opId,
        text: ev.raw_text || null,
        notes: ev.metadata?.notes || ev.raw_text || null,
        when,
      });
      return {
        table: 'ad_hoc_task_instances',
        id: r.adHocTaskInstanceId,
        kind: 'ad_hoc_start',
        result: r,
      };
    }

    case 'ad_hoc_finish': {
      let instanceId = ev.target_phase_id || null; // reused field carries ad-hoc id
      if (!instanceId) {
        const open = await db.query(
          `SELECT ati.id FROM ad_hoc_task_instances ati
            WHERE ati.status = 'open'
              AND ($1::int IS NULL OR ati.started_by_operator_id = $1)
              AND ($2::text IS NULL OR LOWER(ati.task_name) = LOWER($2))
            ORDER BY ati.started_at DESC LIMIT 1`,
          [opId, ev.ad_hoc_task || null]
        );
        instanceId = open.rows[0]?.id || null;
      }
      if (!instanceId) return { skip: true, reason: 'no open ad-hoc to finish' };
      const r = await engine.closeAdHocTask({
        adHocTaskInstanceId: instanceId,
        closedByOperatorId: opId,
        when,
      });
      return {
        table: 'ad_hoc_task_instances',
        id: instanceId,
        kind: 'ad_hoc_finish',
        result: r,
      };
    }

    case 'count': {
      const r0 = await engine.startAdHocTask({
        taskName: 'Reporte no sistema',
        operatorId: opId,
        text: ev.raw_text || null,
        when,
      });
      const r1 = await engine.closeAdHocTask({
        adHocTaskInstanceId: r0.adHocTaskInstanceId,
        closedByOperatorId: opId,
        when,
      });
      return {
        table: 'ad_hoc_task_instances',
        id: r0.adHocTaskInstanceId,
        kind: 'count',
        result: { ...r0, ...r1 },
      };
    }

    case 'start': {
      const tpl = await resolveTemplateForEvent(ev, ctx);
      if (!tpl || !tpl.phaseTemplateId) {
        // No real phase signal → ad-hoc "Outro" with the raw text as the
        // note. NEVER a phantom "Linha de Produção".
        if (tpl && tpl.fallbackNoContext) {
          const cur = await engine.getCurrentActivity(opId);
          if (cur) return { skip: true, reason: 'start sem contexto; operador já ativo' };
          const r = await engine.startAdHocTask({
            taskName: 'Outro',
            operatorId: opId,
            text: ev.raw_text || null,
            notes: ev.raw_text || null,
            when,
          });
          return {
            table: 'ad_hoc_task_instances',
            id: r.adHocTaskInstanceId,
            kind: 'adhoc_outro_no_context',
            result: r,
          };
        }
        return { skip: true, reason: 'unknown phase template' };
      }
      const wf = await engine.findOrCreateWorkflowInstance({
        workflowTemplateId: ctx.wfByName[tpl.workflowName],
        productName: ev.supplement || null,
        batchNumber: ev.batch || null,
        startedByOperatorId: opId,
        when,
      });
      const phase = await engine.startPhase({
        workflowInstanceId: wf.workflowInstanceId,
        phaseTemplateId: tpl.phaseTemplateId,
        operatorId: opId,
        batchNumber: ev.batch || null,
        when,
        notes: ev.metadata?.notes || null,
      });
      return {
        table: 'phase_instances',
        id: phase.phaseInstanceId,
        kind: 'phase_start',
        result: { workflowInstanceId: wf.workflowInstanceId, ...phase },
      };
    }

    case 'finish': {
      const target = await locateTargetPhase(ev, ctx);
      if (!target) return { skip: true, reason: 'no open phase to close' };
      const r = await engine.closePhase({
        phaseInstanceId: target.id,
        closedByOperatorId: opId,
        when,
      });
      return {
        table: 'phase_instances',
        id: target.id,
        kind: 'phase_close',
        result: r,
      };
    }

    default:
      return { skip: true, reason: `unhandled type: ${ev.type}` };
  }
}

// ─── UPDATE path (source_id already seen — edit / reprocess) ─────────────────
//
// The whole point of L-06: a Slack edit or a reprocess of the SAME
// source_id must mutate the row it already produced, never spawn new
// rows. We touch only mutable fields (operator reassignment, supplement,
// batch, notes/text). Structural type changes are recorded in metadata
// rather than re-deriving the graph (kept conservative on purpose).

async function updateForEvent(ev, idx) {
  const t = idx.target_table;
  const id = idx.target_id;
  const opId = ev.operator_id;

  if (t === 'operator_notes') {
    await db.query(
      `UPDATE operator_notes
          SET text = $1, operator_id = COALESCE($2, operator_id)
        WHERE id = $3 AND deleted_at IS NULL`,
      [ev.raw_text || ev.metadata?.note || '(nota vazia)', opId, id]
    );
    return { table: t, id };
  }

  if (t === 'phase_instances') {
    // Reassign operator (L-08) + correct supplement/batch (L-06) on the
    // existing phase instead of opening a duplicate.
    const ph = await db.query(
      `SELECT workflow_instance_id, status FROM phase_instances WHERE id = $1`,
      [id]
    );
    const wfId = ph.rows[0]?.workflow_instance_id || null;
    if (opId) {
      await db.query(
        `UPDATE phase_instances SET started_by_operator_id = $1, updated_at = NOW()
          WHERE id = $2`,
        [opId, id]
      );
      await db.query(
        `UPDATE operator_activity_log SET operator_id = $1, updated_at = NOW()
          WHERE phase_instance_id = $2 AND role = 'starter'`,
        [opId, id]
      );
    }
    if (wfId && (ev.supplement || ev.batch)) {
      await db.query(
        `UPDATE workflow_instances
            SET product_name = COALESCE($1, product_name),
                batch_number = COALESCE($2, batch_number),
                updated_at = NOW()
          WHERE id = $3`,
        [ev.supplement || null, ev.batch || null, wfId]
      );
    }
    if (ev.batch) {
      await db.query(
        `UPDATE phase_instances SET batch_number = $1, updated_at = NOW() WHERE id = $2`,
        [ev.batch, id]
      );
    }
    return { table: t, id };
  }

  if (t === 'ad_hoc_task_instances') {
    if (opId) {
      await db.query(
        `UPDATE ad_hoc_task_instances SET started_by_operator_id = $1, updated_at = NOW()
          WHERE id = $2`,
        [opId, id]
      );
    }
    if (ev.ad_hoc_task) {
      await db.query(
        `UPDATE ad_hoc_task_instances SET task_name = $1, updated_at = NOW() WHERE id = $2`,
        [ev.ad_hoc_task, id]
      );
    }
    return { table: t, id };
  }

  if (t === 'pauses') {
    if (opId) {
      await db.query(
        `UPDATE pauses SET operator = (SELECT name FROM operators WHERE id = $1)
          WHERE id = $2`,
        [opId, id]
      );
    }
    return { table: t, id };
  }

  // operator_activity_log and anything else: reassign operator if given.
  if (t === 'operator_activity_log' && opId) {
    await db.query(
      `UPDATE operator_activity_log SET operator_id = $1, updated_at = NOW() WHERE id = $2`,
      [opId, id]
    );
  }
  return { table: t, id };
}

/**
 * Dispatch one EventoCanônico. Idempotent by source_id.
 *
 * Returns:
 *   { dispatched:true, upsert:'create'|'update', target_table, target_id, kind, result }
 *   { dispatched:false, reason, needsDisambiguation? , event? }
 *
 * needsDisambiguation=true means operator_id was null on an
 * operator-required type — the caller (Part 6) must ask in the admin
 * chat. NOTHING is silently dropped: the originating message still lives
 * in `messages`, and 'note' events are always persisted regardless.
 */
async function dispatch(ev) {
  const v = validateEvent(ev);
  if (!v.ok) {
    return { dispatched: false, reason: 'invalid event', errors: v.errors };
  }

  // Ambiguous operator on an operator-required type: do not guess, do
  // not fabricate ISA-88 rows (oal.operator_id is NOT NULL). Flag for
  // admin-chat disambiguation; the message itself is already persisted
  // by the caller.
  if (ev.operator_id == null && OPERATOR_REQUIRED.has(ev.type)) {
    return {
      dispatched: false,
      reason: 'ambiguous operator (operator_id null)',
      needsDisambiguation: true,
      event: ev,
    };
  }

  const idx = await getIndexRow(ev.source_id);
  const ctx = await wfDispatcher.getTemplateContext();

  // ── UPDATE (source_id already produced a row) ──
  if (idx) {
    const target = await updateForEvent(ev, idx);
    await upsertIndex(ev.source_id, ev.source_type, target.table, target.id);
    await audit(ev, 'update', target);
    return {
      dispatched: true,
      upsert: 'update',
      target_table: target.table,
      target_id: target.id,
      kind: 'reprocess_update',
    };
  }

  // ── CREATE ──
  const out = await createForEvent(ev, ctx);
  if (out.skip) {
    return { dispatched: false, reason: out.reason };
  }
  // Index only when we have a concrete row id. A handful of engine ops
  // (e.g. break_end with no prior pause) act without yielding a fresh
  // PK — still audited, just not idempotency-tracked.
  if (Number.isFinite(Number(out.id)) && Number(out.id) > 0) {
    await upsertIndex(ev.source_id, ev.source_type, out.table, out.id);
  }
  await audit(ev, 'create', out);
  return {
    dispatched: true,
    upsert: 'create',
    target_table: out.table,
    target_id: out.id,
    kind: out.kind,
    result: out.result || null,
  };
}

/** Never-throws wrapper for poller / wizard / tool usage. */
async function safeDispatch(ev) {
  try {
    return await dispatch(ev);
  } catch (err) {
    console.error(
      '[CanonicalDispatcher] error:',
      err.message,
      '— event:',
      JSON.stringify({ source_id: ev?.source_id, type: ev?.type }).slice(0, 200)
    );
    return { dispatched: false, error: err.message };
  }
}

module.exports = {
  dispatch,
  safeDispatch,
  // exported for tests / Part 3-5 callers
  getIndexRow,
  resolveTemplateForEvent,
  locateTargetPhase,
};
