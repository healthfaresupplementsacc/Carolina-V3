'use strict';
/**
 * Entrega 3 Fase 4 — Migrate legacy data into the ISA-88 model.
 *
 * Strategy:
 *   - tasks                  → workflow_instance + phase_instance (mapped by task_type)
 *   - orders_sessions        → workflow_instance "Picking & Packing" + phase Imprimir/Empacotar
 *   - formulation_sessions   → phase_instance "Formulação" attached to a workflow_instance
 *                              of "Produção de Suplemento" (or a fresh one if no match)
 *   - pauses                 → operator_activity_log row of activity_type='break'
 *
 * Idempotent: every new row records the source via (legacy_table, legacy_id).
 * Re-running the migration skips rows whose pair already exists in the
 * target table.
 *
 * Read-only on source tables — never UPDATE/DELETE them. They remain as
 * historical record.
 */

const db = require('./../db');

// Map task_type → (workflow_template name, phase_template name)
const TASK_TYPE_MAP = {
  producao:     { workflow: 'Produção de Suplemento', phase: 'Linha de Produção' },
  revisao:      { workflow: 'Produção de Suplemento', phase: 'Revisão' },
  limpeza:      null, // ad-hoc, not a phase
  packing:      { workflow: 'Picking & Packing',      phase: 'Empacotar' },
  linha_producao:{workflow: 'Produção de Suplemento', phase: 'Linha de Produção' },
  formulacao:   { workflow: 'Produção de Suplemento', phase: 'Formulação' },
  encapsulacao: { workflow: 'Produção de Suplemento', phase: 'Encapsulação' },
  label:        null, // ad-hoc / Envio phase
  outro:        null,
};

const STATUS_MAP = {
  open: 'open', closed: 'closed', abandoned: 'closed', deleted: 'deleted',
};

async function getTemplateIds() {
  const wf = await db.query(`SELECT id, name FROM workflow_templates`);
  const wfByName = Object.fromEntries(wf.rows.map((r) => [r.name, r.id]));
  const ph = await db.query(`
    SELECT pt.id, pt.name AS phase_name, wt.name AS workflow_name
    FROM phase_templates pt
    JOIN workflow_templates wt ON wt.id = pt.workflow_template_id
  `);
  const phaseByKey = {};
  for (const row of ph.rows) {
    phaseByKey[`${row.workflow_name}::${row.phase_name}`] = row.id;
  }
  const adhoc = await db.query(`SELECT id, name FROM ad_hoc_tasks`);
  const adhocByName = Object.fromEntries(adhoc.rows.map((r) => [r.name.toLowerCase(), r.id]));
  const operators = await db.query(`SELECT id, name FROM operators`);
  const opByName = Object.fromEntries(operators.rows.map((r) => [r.name, r.id]));
  return { wfByName, phaseByKey, adhocByName, opByName };
}

async function migrateTasks(state, opts = {}) {
  const { wfByName, phaseByKey, adhocByName, opByName } = state;
  const limit = opts.limit || 5000;
  const tasks = await db.query(`
    SELECT t.id, t.operator, t.supplement_name, t.batch_number, t.task_type,
           t.status, t.started_at, t.ended_at, t.closed_by, t.helpers,
           t.description, t.slack_start_ts, t.slack_end_ts,
           (SELECT count FROM production_counts pc WHERE pc.task_id = t.id LIMIT 1) AS final_bottle_count
    FROM tasks t
    WHERE NOT EXISTS (
      SELECT 1 FROM phase_instances pi WHERE pi.legacy_table = 'tasks' AND pi.legacy_id = t.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM ad_hoc_task_instances ati WHERE ati.legacy_table = 'tasks' AND ati.legacy_id = t.id
    )
    ORDER BY t.started_at ASC
    LIMIT $1
  `, [limit]);

  let phaseInstancesCreated = 0, adHocCreated = 0, workflowsCreated = 0, skipped = 0;

  for (const t of tasks.rows) {
    const map = TASK_TYPE_MAP[t.task_type];
    const status = STATUS_MAP[t.status] || 'closed';

    if (!map) {
      // task_type=limpeza|label|outro → ad-hoc instance
      let adHocName = (t.task_type === 'limpeza') ? 'Limpeza'
                    : (t.task_type === 'label')   ? 'Outro' // label has no ad-hoc; folded into Outro
                    : 'Outro';
      const taskId = adhocByName[adHocName.toLowerCase()];
      if (!taskId) { skipped++; continue; }
      await db.query(`
        INSERT INTO ad_hoc_task_instances
          (ad_hoc_task_id, task_name, status, started_at, ended_at,
           started_by_operator_id, closed_by_operator_id, notes,
           legacy_table, legacy_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'tasks', $9)
      `, [
        taskId, adHocName, status, t.started_at, t.ended_at,
        opByName[t.operator] || null,
        opByName[t.closed_by || t.operator] || null,
        t.description || null,
        t.id,
      ]);
      adHocCreated++;
      continue;
    }

    // Get or create the workflow_instance
    const wfTemplateId = wfByName[map.workflow];
    if (!wfTemplateId) { skipped++; continue; }
    const phaseTemplateId = phaseByKey[`${map.workflow}::${map.phase}`];
    if (!phaseTemplateId) { skipped++; continue; }

    // Match by product_name + batch_number (when both set). Otherwise create fresh.
    let workflowInstanceId = null;
    if (t.supplement_name) {
      const params = [wfTemplateId, t.supplement_name];
      let cond = `workflow_template_id = $1 AND product_name = $2`;
      if (t.batch_number) {
        cond += ` AND batch_number = $3`;
        params.push(t.batch_number);
      }
      const existing = await db.query(
        `SELECT id FROM workflow_instances WHERE ${cond} ORDER BY id ASC LIMIT 1`,
        params
      );
      if (existing.rows.length > 0) workflowInstanceId = existing.rows[0].id;
    }
    if (!workflowInstanceId) {
      const ins = await db.query(`
        INSERT INTO workflow_instances
          (workflow_template_id, product_name, batch_number, status,
           started_at, started_by_operator_id, legacy_table, legacy_id)
        VALUES ($1, $2, $3, $4, $5, $6, 'tasks', $7)
        RETURNING id
      `, [
        wfTemplateId, t.supplement_name || null, t.batch_number || null,
        (status === 'open') ? 'active' : 'closed',
        t.started_at, opByName[t.operator] || null, t.id,
      ]);
      workflowInstanceId = ins.rows[0].id;
      workflowsCreated++;
    }

    await db.query(`
      INSERT INTO phase_instances
        (workflow_instance_id, phase_template_id, phase_name, batch_number,
         status, started_at, ended_at,
         started_by_operator_id, closed_by_operator_id,
         final_bottle_count, notes, legacy_table, legacy_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'tasks', $12)
    `, [
      workflowInstanceId, phaseTemplateId, map.phase, t.batch_number || null,
      status, t.started_at, t.ended_at,
      opByName[t.operator] || null,
      opByName[t.closed_by || t.operator] || null,
      Number.isFinite(t.final_bottle_count) ? t.final_bottle_count : null,
      t.description || null,
      t.id,
    ]);
    phaseInstancesCreated++;
  }

  return { phaseInstancesCreated, adHocCreated, workflowsCreated, skipped, examined: tasks.rows.length };
}

async function migrateOrdersSessions(state, opts = {}) {
  const { wfByName, phaseByKey, opByName } = state;
  const limit = opts.limit || 5000;
  const sessions = await db.query(`
    SELECT id, operator, order_count, batch_label, started_at, ended_at,
           status, slack_start_ts, helpers
    FROM orders_sessions
    WHERE NOT EXISTS (
      SELECT 1 FROM workflow_instances wi
      WHERE wi.legacy_table = 'orders_sessions' AND wi.legacy_id = orders_sessions.id
    )
    ORDER BY started_at ASC
    LIMIT $1
  `, [limit]);
  const wfTemplateId = wfByName['Picking & Packing'];
  const printPhaseId = phaseByKey['Picking & Packing::Imprimir ordens'];
  if (!wfTemplateId || !printPhaseId) {
    return { workflowsCreated: 0, phaseInstancesCreated: 0, skipped: sessions.rows.length };
  }

  let workflowsCreated = 0, phaseInstancesCreated = 0;
  for (const s of sessions.rows) {
    const passNumber = s.batch_label === 'morning' ? 1 : (s.batch_label === 'afternoon' ? 2 : null);
    const wfStatus = s.status === 'open' ? 'active' : 'closed';
    const wfIns = await db.query(`
      INSERT INTO workflow_instances
        (workflow_template_id, pass_number, status, started_at, ended_at,
         started_by_operator_id, notes, legacy_table, legacy_id,
         meta)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'orders_sessions', $8, $9::jsonb)
      RETURNING id
    `, [
      wfTemplateId, passNumber, wfStatus, s.started_at, s.ended_at,
      opByName[s.operator] || null,
      s.helpers ? `helpers: ${s.helpers}` : null,
      s.id,
      JSON.stringify({ order_count: s.order_count, batch_label: s.batch_label }),
    ]);
    const wfId = wfIns.rows[0].id;
    workflowsCreated++;

    await db.query(`
      INSERT INTO phase_instances
        (workflow_instance_id, phase_template_id, phase_name,
         status, started_at, ended_at,
         started_by_operator_id, notes,
         legacy_table, legacy_id)
      VALUES ($1, $2, 'Imprimir ordens', $3, $4, $5, $6, $7, 'orders_sessions', $8)
    `, [
      wfId, printPhaseId,
      s.status === 'open' ? 'open' : 'closed',
      s.started_at, s.ended_at,
      opByName[s.operator] || null,
      s.order_count ? `order_count: ${s.order_count}` : null,
      s.id,
    ]);
    phaseInstancesCreated++;
  }
  return { workflowsCreated, phaseInstancesCreated, skipped: 0, examined: sessions.rows.length };
}

async function migrateFormulations(state, opts = {}) {
  const { wfByName, phaseByKey, opByName } = state;
  const limit = opts.limit || 5000;
  const rows = await db.query(`
    SELECT id, operator, supplement_name, batch_number, started_at, ended_at,
           status, description
    FROM formulation_sessions
    WHERE NOT EXISTS (
      SELECT 1 FROM phase_instances pi
      WHERE pi.legacy_table = 'formulation_sessions' AND pi.legacy_id = formulation_sessions.id
    )
    ORDER BY started_at ASC
    LIMIT $1
  `, [limit]);

  const wfTemplateId = wfByName['Produção de Suplemento'];
  const formPhaseId = phaseByKey['Produção de Suplemento::Formulação'];
  let workflowsCreated = 0, phaseInstancesCreated = 0, skipped = 0;
  for (const f of rows.rows) {
    if (!wfTemplateId || !formPhaseId) { skipped++; continue; }
    // Find or create workflow_instance for this supplement+batch
    let workflowInstanceId = null;
    if (f.supplement_name) {
      const params = [wfTemplateId, f.supplement_name];
      let cond = `workflow_template_id = $1 AND product_name = $2`;
      if (f.batch_number) { cond += ` AND batch_number = $3`; params.push(f.batch_number); }
      const e = await db.query(
        `SELECT id FROM workflow_instances WHERE ${cond} ORDER BY id ASC LIMIT 1`,
        params
      );
      if (e.rows.length > 0) workflowInstanceId = e.rows[0].id;
    }
    if (!workflowInstanceId) {
      const ins = await db.query(`
        INSERT INTO workflow_instances
          (workflow_template_id, product_name, batch_number, status,
           started_at, started_by_operator_id, legacy_table, legacy_id)
        VALUES ($1, $2, $3, $4, $5, $6, 'formulation_sessions', $7)
        RETURNING id
      `, [
        wfTemplateId, f.supplement_name || null, f.batch_number || null,
        (f.status === 'open') ? 'active' : 'closed',
        f.started_at, opByName[f.operator] || null, f.id,
      ]);
      workflowInstanceId = ins.rows[0].id;
      workflowsCreated++;
    }
    await db.query(`
      INSERT INTO phase_instances
        (workflow_instance_id, phase_template_id, phase_name, batch_number,
         status, started_at, ended_at,
         started_by_operator_id, notes, legacy_table, legacy_id)
      VALUES ($1, $2, 'Formulação', $3, $4, $5, $6, $7, $8, 'formulation_sessions', $9)
    `, [
      workflowInstanceId, formPhaseId, f.batch_number || null,
      (f.status === 'open') ? 'open' : 'closed',
      f.started_at, f.ended_at,
      opByName[f.operator] || null,
      f.description || null,
      f.id,
    ]);
    phaseInstancesCreated++;
  }
  return { workflowsCreated, phaseInstancesCreated, skipped, examined: rows.rows.length };
}

async function migratePauses(state, opts = {}) {
  const { opByName } = state;
  const limit = opts.limit || 5000;
  const rows = await db.query(`
    SELECT id, operator, reason, started_at, ended_at, ended_reason
    FROM pauses
    WHERE NOT EXISTS (
      SELECT 1 FROM operator_activity_log oal
      WHERE oal.pause_id = pauses.id
    )
    AND deleted_at IS NULL
    ORDER BY started_at ASC
    LIMIT $1
  `, [limit]);
  let oalCreated = 0, skipped = 0;
  for (const p of rows.rows) {
    const opId = opByName[p.operator];
    if (!opId) { skipped++; continue; }
    await db.query(`
      INSERT INTO operator_activity_log
        (operator_id, activity_type, pause_id, started_at, ended_at,
         duration_seconds, notes)
      VALUES ($1, 'break', $2, $3, $4,
              CASE WHEN $4::timestamptz IS NOT NULL
                   THEN EXTRACT(EPOCH FROM ($4::timestamptz - $3::timestamptz))::int
                   ELSE NULL END,
              $5)
    `, [opId, p.id, p.started_at, p.ended_at, p.reason]);
    oalCreated++;
  }
  return { oalCreated, skipped, examined: rows.rows.length };
}

/**
 * Migrate everything. Returns a summary. Safe to re-run — idempotent via
 * legacy_table+legacy_id existence checks.
 */
async function migrateAll(opts = {}) {
  const state = await getTemplateIds();
  const t = await migrateTasks(state, opts);
  const o = await migrateOrdersSessions(state, opts);
  const f = await migrateFormulations(state, opts);
  const p = await migratePauses(state, opts);
  return { tasks: t, orders_sessions: o, formulations: f, pauses: p };
}

module.exports = {
  TASK_TYPE_MAP, STATUS_MAP,
  getTemplateIds, migrateTasks, migrateOrdersSessions, migrateFormulations, migratePauses,
  migrateAll,
};
