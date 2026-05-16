'use strict';
/**
 * Entrega 3 — Backend API for the ISA-88 workflow model.
 *
 * Endpoints:
 *   GET    /api/workflow-templates                 (public, returns active by default)
 *   GET    /api/workflow-templates/:id             (with nested phases)
 *   POST   /api/admin/workflow-templates           (admin)
 *   PUT    /api/admin/workflow-templates/:id       (admin)
 *   DELETE /api/admin/workflow-templates/:id       (admin — soft via is_active=false)
 *
 * (more endpoints added by later commits in Fase 2)
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auditAction, snapshotRow, checkPin } = require('../admin/audit');

// ─── workflow_templates (Fase 2.1) ──────────────────────────────────────

// Public list — default is_active=true; admin can pass ?include_inactive=1.
router.get('/workflow-templates', async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === '1';
    const r = await db.query(
      `SELECT id, name, description, is_active, allows_product, created_at, updated_at
       FROM workflow_templates
       ${includeInactive ? '' : 'WHERE is_active = TRUE'}
       ORDER BY id ASC`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Public detail with phases nested in sequence order.
router.get('/workflow-templates/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const wf = await db.query('SELECT * FROM workflow_templates WHERE id = $1', [id]);
    if (wf.rows.length === 0) return res.status(404).json({ error: 'not found' });
    const ph = await db.query(
      `SELECT id, name, sequence_order, is_required, can_run_parallel, parallel_group,
              prerequisite_phase_ids, prerequisite_mode, soft_prereq, created_at, updated_at
       FROM phase_templates
       WHERE workflow_template_id = $1
       ORDER BY sequence_order ASC, id ASC`,
      [id]
    );
    res.json({ ...wf.rows[0], phases: ph.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/admin/workflow-templates', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const { name, description, allows_product } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });
    const r = await db.query(
      `INSERT INTO workflow_templates (name, description, allows_product, is_active)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id`,
      [name.trim(), description || null, !!allows_product]
    );
    const id = r.rows[0].id;
    const after = await snapshotRow('workflow_templates', 'id', id);
    await auditAction({ req, action: 'workflow_template.create', entityType: 'workflow_template',
                        entityId: id, before: null, after });
    res.json({ ok: true, id });
  } catch (err) {
    if (/duplicate key/.test(err.message)) return res.status(409).json({ error: 'name já existe' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/workflow-templates/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const before = await snapshotRow('workflow_templates', 'id', id);
    if (!before) return res.status(404).json({ error: 'not found' });

    const sets = ['updated_at = NOW()'];
    const params = [];
    const { name, description, allows_product, is_active } = req.body;
    if (name           !== undefined) { sets.push(`name = $${params.length + 1}`);           params.push(name.trim()); }
    if (description    !== undefined) { sets.push(`description = $${params.length + 1}`);    params.push(description || null); }
    if (allows_product !== undefined) { sets.push(`allows_product = $${params.length + 1}`); params.push(!!allows_product); }
    if (is_active      !== undefined) { sets.push(`is_active = $${params.length + 1}`);      params.push(!!is_active); }
    params.push(id);

    await db.query(`UPDATE workflow_templates SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const after = await snapshotRow('workflow_templates', 'id', id);
    await auditAction({ req, action: 'workflow_template.edit', entityType: 'workflow_template',
                        entityId: id, before, after });
    res.json({ ok: true });
  } catch (err) {
    if (/duplicate key/.test(err.message)) return res.status(409).json({ error: 'name já existe' });
    res.status(500).json({ error: err.message });
  }
});

// Soft delete via is_active=false. Hard delete would CASCADE through
// phase_templates and orphan workflow_instances → never. Returns a
// `warning` field counting active instances using this template.
router.delete('/admin/workflow-templates/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const before = await snapshotRow('workflow_templates', 'id', id);
    if (!before) return res.status(404).json({ error: 'not found' });

    const activeWf = await db.query(
      `SELECT COUNT(*)::int AS n FROM workflow_instances
       WHERE workflow_template_id = $1 AND status = 'active'`,
      [id]
    );
    const warning = activeWf.rows[0].n > 0
      ? `${activeWf.rows[0].n} instância(s) ativa(s) ainda usam esse template — elas continuam, mas novos batches só podem usar templates ativos.`
      : null;

    await db.query(
      `UPDATE workflow_templates SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
      [id]
    );
    const after = await snapshotRow('workflow_templates', 'id', id);
    await auditAction({ req, action: 'workflow_template.deactivate', entityType: 'workflow_template',
                        entityId: id, before, after });
    res.json({ ok: true, warning });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── phase_templates (Fase 2.2) ─────────────────────────────────────────

// Public list — filter by ?workflow_template_id=N. Returns sequence order.
router.get('/phase-templates', async (req, res) => {
  try {
    const wfId = req.query.workflow_template_id ? parseInt(req.query.workflow_template_id) : null;
    const params = [];
    let where = '';
    if (Number.isFinite(wfId)) { where = 'WHERE workflow_template_id = $1'; params.push(wfId); }
    const r = await db.query(
      `SELECT id, workflow_template_id, name, sequence_order, is_required,
              can_run_parallel, parallel_group, prerequisite_phase_ids,
              prerequisite_mode, soft_prereq, created_at, updated_at
       FROM phase_templates
       ${where}
       ORDER BY workflow_template_id ASC, sequence_order ASC, id ASC`,
      params
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/phase-templates/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const r = await db.query('SELECT * FROM phase_templates WHERE id = $1', [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Validate prereq references — every id in the array must exist and belong
// to the same workflow_template_id (so admin can't create a Revisão whose
// prereq is a phase from a different workflow).
async function validatePrereqIds(workflowTemplateId, prereqIds) {
  if (!Array.isArray(prereqIds) || prereqIds.length === 0) return { ok: true };
  const r = await db.query(
    `SELECT id FROM phase_templates
     WHERE id = ANY($1::int[]) AND workflow_template_id = $2`,
    [prereqIds, workflowTemplateId]
  );
  if (r.rows.length !== prereqIds.length) {
    return { ok: false, error: 'prerequisite_phase_ids contém id inválido (id não existe ou não pertence ao mesmo workflow)' };
  }
  return { ok: true };
}

router.post('/admin/phase-templates', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const {
      workflow_template_id, name, sequence_order, is_required,
      can_run_parallel, parallel_group, prerequisite_phase_ids,
      prerequisite_mode, soft_prereq,
    } = req.body;

    if (!Number.isFinite(workflow_template_id))
      return res.status(400).json({ error: 'workflow_template_id obrigatório' });
    if (!name || !name.trim())
      return res.status(400).json({ error: 'name é obrigatório' });

    // Confirm parent workflow exists
    const wf = await db.query('SELECT id FROM workflow_templates WHERE id = $1', [workflow_template_id]);
    if (wf.rows.length === 0) return res.status(400).json({ error: 'workflow_template_id não existe' });

    const mode = prerequisite_mode === 'any' ? 'any' : 'all';
    const ids = Array.isArray(prerequisite_phase_ids) ? prerequisite_phase_ids.map(Number).filter(Number.isFinite) : [];
    const check = await validatePrereqIds(workflow_template_id, ids);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const r = await db.query(
      `INSERT INTO phase_templates
         (workflow_template_id, name, sequence_order, is_required,
          can_run_parallel, parallel_group, prerequisite_phase_ids,
          prerequisite_mode, soft_prereq)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       RETURNING id`,
      [workflow_template_id, name.trim(), sequence_order || 0,
       is_required !== undefined ? !!is_required : true,
       !!can_run_parallel,
       parallel_group || null,
       JSON.stringify(ids),
       mode,
       soft_prereq !== undefined ? !!soft_prereq : true]
    );
    const id = r.rows[0].id;
    const after = await snapshotRow('phase_templates', 'id', id);
    await auditAction({ req, action: 'phase_template.create', entityType: 'phase_template',
                        entityId: id, before: null, after });
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/admin/phase-templates/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const before = await snapshotRow('phase_templates', 'id', id);
    if (!before) return res.status(404).json({ error: 'not found' });

    const sets = ['updated_at = NOW()'];
    const params = [];
    const {
      name, sequence_order, is_required, can_run_parallel, parallel_group,
      prerequisite_phase_ids, prerequisite_mode, soft_prereq,
    } = req.body;

    if (name              !== undefined) { sets.push(`name = $${params.length + 1}`);             params.push(name.trim()); }
    if (sequence_order    !== undefined) { sets.push(`sequence_order = $${params.length + 1}`);   params.push(parseInt(sequence_order) || 0); }
    if (is_required       !== undefined) { sets.push(`is_required = $${params.length + 1}`);     params.push(!!is_required); }
    if (can_run_parallel  !== undefined) { sets.push(`can_run_parallel = $${params.length + 1}`); params.push(!!can_run_parallel); }
    if (parallel_group    !== undefined) { sets.push(`parallel_group = $${params.length + 1}`);   params.push(parallel_group || null); }
    if (soft_prereq       !== undefined) { sets.push(`soft_prereq = $${params.length + 1}`);     params.push(!!soft_prereq); }
    if (prerequisite_mode !== undefined) {
      const mode = prerequisite_mode === 'any' ? 'any' : 'all';
      sets.push(`prerequisite_mode = $${params.length + 1}`);
      params.push(mode);
    }
    if (prerequisite_phase_ids !== undefined) {
      const ids = Array.isArray(prerequisite_phase_ids) ? prerequisite_phase_ids.map(Number).filter(Number.isFinite) : [];
      const check = await validatePrereqIds(before.workflow_template_id, ids);
      if (!check.ok) return res.status(400).json({ error: check.error });
      sets.push(`prerequisite_phase_ids = $${params.length + 1}::jsonb`);
      params.push(JSON.stringify(ids));
    }
    params.push(id);

    await db.query(`UPDATE phase_templates SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const after = await snapshotRow('phase_templates', 'id', id);
    await auditAction({ req, action: 'phase_template.edit', entityType: 'phase_template',
                        entityId: id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/admin/phase-templates/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const before = await snapshotRow('phase_templates', 'id', id);
    if (!before) return res.status(404).json({ error: 'not found' });

    // Reject if any other phase_template references this one as a prereq.
    const refs = await db.query(
      `SELECT id, name FROM phase_templates
       WHERE prerequisite_phase_ids @> $1::jsonb LIMIT 5`,
      [JSON.stringify([id])]
    );
    if (refs.rows.length > 0) {
      return res.status(409).json({
        error: 'Outras fases ainda dependem desta como pré-requisito',
        referenced_by: refs.rows,
      });
    }
    // Reject if there are open phase_instances of this template
    const openInst = await db.query(
      `SELECT COUNT(*)::int AS n FROM phase_instances
       WHERE phase_template_id = $1 AND status = 'open'`,
      [id]
    );
    if (openInst.rows[0].n > 0) {
      return res.status(409).json({
        error: `${openInst.rows[0].n} phase_instance(s) abertas usando este template — feche antes de deletar`,
      });
    }

    await db.query('DELETE FROM phase_templates WHERE id = $1', [id]);
    await auditAction({ req, action: 'phase_template.delete', entityType: 'phase_template',
                        entityId: id, before, after: null });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── workflow_instances (Fase 2.3) ──────────────────────────────────────

// GET /api/workflow-instances?status=active&workflow_template_id=N&date=YYYY-MM-DD
router.get('/workflow-instances', async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.status) {
      where.push(`status = $${params.length + 1}`);
      params.push(req.query.status);
    } else {
      where.push(`status <> 'deleted'`);
    }
    if (req.query.workflow_template_id) {
      where.push(`workflow_template_id = $${params.length + 1}`);
      params.push(parseInt(req.query.workflow_template_id));
    }
    if (req.query.date) {
      where.push(`(started_at AT TIME ZONE 'America/New_York')::date = $${params.length + 1}::date`);
      params.push(req.query.date);
    }
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const r = await db.query(
      `SELECT id, workflow_template_id, product_id, product_name, batch_number,
              batch_change_approved, destination, pass_number, status,
              started_at, ended_at, started_by_operator_id, notes, meta,
              legacy_table, legacy_id
       FROM workflow_instances
       WHERE ${where.join(' AND ')}
       ORDER BY started_at DESC
       LIMIT ${limit}`,
      params
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/workflow-instances/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const wf = await db.query('SELECT * FROM workflow_instances WHERE id = $1', [id]);
    if (wf.rows.length === 0) return res.status(404).json({ error: 'not found' });
    const phases = await db.query(
      `SELECT id, phase_template_id, phase_name, batch_number, batch_change_approved,
              status, started_at, ended_at, started_by_operator_id, closed_by_operator_id,
              final_bottle_count, notes
       FROM phase_instances
       WHERE workflow_instance_id = $1 AND status <> 'deleted'
       ORDER BY started_at ASC, id ASC`,
      [id]
    );
    res.json({ ...wf.rows[0], phases: phases.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/admin/workflow-instances', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const {
      workflow_template_id, product_id, product_name, batch_number,
      destination, pass_number, started_at, started_by_operator_id, notes,
    } = req.body;
    if (!Number.isFinite(workflow_template_id))
      return res.status(400).json({ error: 'workflow_template_id obrigatório' });

    const r = await db.query(
      `INSERT INTO workflow_instances
         (workflow_template_id, product_id, product_name, batch_number,
          destination, pass_number, started_at, started_by_operator_id, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()), $8, $9, 'active')
       RETURNING id`,
      [workflow_template_id, product_id || null, product_name || null,
       batch_number || null, destination || null,
       Number.isFinite(pass_number) ? pass_number : null,
       started_at || null, started_by_operator_id || null, notes || null]
    );
    const id = r.rows[0].id;
    const after = await snapshotRow('workflow_instances', 'id', id);
    await auditAction({ req, action: 'workflow_instance.create', entityType: 'workflow_instance',
                        entityId: id, before: null, after });
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT — accept any subset. batch_number changes trigger Princípio E:
// the column batch_change_approved flips to false, the engine emits an
// admin-chat alert (handled separately by the alert worker), and the
// dashboard shows a "⏳ batch alterado" badge until admin clears it.
router.put('/admin/workflow-instances/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const before = await snapshotRow('workflow_instances', 'id', id);
    if (!before) return res.status(404).json({ error: 'not found' });

    const sets = ['updated_at = NOW()'];
    const params = [];
    const {
      product_id, product_name, batch_number, destination, pass_number,
      started_at, ended_at, started_by_operator_id, notes, status,
      meta, batch_change_approved,
    } = req.body;

    if (product_id     !== undefined) { sets.push(`product_id = $${params.length + 1}`);     params.push(product_id || null); }
    if (product_name   !== undefined) { sets.push(`product_name = $${params.length + 1}`);   params.push(product_name || null); }
    if (destination    !== undefined) { sets.push(`destination = $${params.length + 1}`);    params.push(destination || null); }
    if (pass_number    !== undefined) { sets.push(`pass_number = $${params.length + 1}`);    params.push(Number.isFinite(pass_number) ? pass_number : null); }
    if (started_at)                   { sets.push(`started_at = $${params.length + 1}::timestamptz`); params.push(started_at); }
    if (ended_at !== undefined)       { sets.push(`ended_at = $${params.length + 1}::timestamptz`);   params.push(ended_at || null); }
    if (started_by_operator_id !== undefined) {
      sets.push(`started_by_operator_id = $${params.length + 1}`);
      params.push(started_by_operator_id || null);
    }
    if (notes !== undefined)          { sets.push(`notes = $${params.length + 1}`);   params.push(notes || null); }
    if (status !== undefined)         { sets.push(`status = $${params.length + 1}`);  params.push(status); }
    if (meta !== undefined)           { sets.push(`meta = $${params.length + 1}::jsonb`); params.push(JSON.stringify(meta || {})); }
    if (batch_change_approved !== undefined) {
      sets.push(`batch_change_approved = $${params.length + 1}`);
      params.push(!!batch_change_approved);
    }
    let batchChanged = false;
    if (batch_number !== undefined && batch_number !== before.batch_number) {
      sets.push(`batch_number = $${params.length + 1}`); params.push(batch_number || null);
      sets.push(`batch_change_approved = FALSE`);
      batchChanged = true;
    }
    params.push(id);
    await db.query(`UPDATE workflow_instances SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const after = await snapshotRow('workflow_instances', 'id', id);
    await auditAction({
      req,
      action: batchChanged ? 'workflow_instance.batch_changed' : 'workflow_instance.edit',
      entityType: 'workflow_instance', entityId: id, before, after,
    });
    res.json({ ok: true, batch_changed: batchChanged });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/admin/workflow-instances/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const before = await snapshotRow('workflow_instances', 'id', id);
    if (!before) return res.status(404).json({ error: 'not found' });
    await db.query(
      `UPDATE workflow_instances SET status = 'deleted', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    // Cascade soft delete to phase_instances of this workflow
    await db.query(
      `UPDATE phase_instances SET status = 'deleted', updated_at = NOW()
       WHERE workflow_instance_id = $1 AND status <> 'deleted'`,
      [id]
    );
    const after = await snapshotRow('workflow_instances', 'id', id);
    await auditAction({ req, action: 'workflow_instance.delete', entityType: 'workflow_instance',
                        entityId: id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/workflow-instances/merge — body: { pin, instance_ids: [a,b,c] }
// Survivor is the oldest active one. Other instances get status='deleted'
// with notes "[merged into #X]". phase_instances re-point to survivor.
router.post('/admin/workflow-instances/merge', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const ids = Array.isArray(req.body?.instance_ids) ? req.body.instance_ids.map(Number).filter(Number.isFinite) : [];
    if (ids.length < 2) return res.status(400).json({ error: 'precisa de 2+ instance_ids' });

    const rows = await db.query(
      `SELECT id, started_at, product_name, batch_number, status
       FROM workflow_instances
       WHERE id = ANY($1::int[])
       ORDER BY started_at ASC`,
      [ids]
    );
    if (rows.rows.length !== ids.length) {
      return res.status(400).json({ error: 'algum id não existe' });
    }
    const [survivor, ...others] = rows.rows;
    const survivorId = survivor.id;
    const mergedIds = others.map((r) => r.id);

    await db.query(
      `UPDATE phase_instances SET workflow_instance_id = $1, updated_at = NOW()
       WHERE workflow_instance_id = ANY($2::int[])`,
      [survivorId, mergedIds]
    );
    await db.query(
      `UPDATE workflow_instances
       SET status = 'deleted',
           notes = COALESCE(notes, '') || ' [merged into #' || $1 || ']',
           updated_at = NOW()
       WHERE id = ANY($2::int[])`,
      [survivorId, mergedIds]
    );

    await auditAction({
      req, action: 'workflow_instance.merge', entityType: 'workflow_instance',
      entityId: survivorId,
      before: { ids },
      after: { survivor_id: survivorId, merged_ids: mergedIds },
    });
    res.json({ ok: true, survivor_id: survivorId, merged_ids: mergedIds });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// W5 — POST /admin/phase-instances/merge (mirrors workflow merge).
// Oldest survives; others soft-deleted; oal rows + production_counts
// re-pointed to the survivor; task_aliases learns phase_name synonyms.
router.post('/admin/phase-instances/merge', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const ids = Array.isArray(req.body?.phase_ids)
      ? req.body.phase_ids.map(Number).filter(Number.isFinite) : [];
    if (ids.length < 2) return res.status(400).json({ error: 'precisa de 2+ phase_ids' });
    const rows = await db.query(
      `SELECT id, started_at, phase_name FROM phase_instances
       WHERE id = ANY($1::int[]) ORDER BY started_at ASC`, [ids]);
    if (rows.rows.length !== ids.length) {
      return res.status(400).json({ error: 'algum id não existe' });
    }
    const [survivor, ...others] = rows.rows;
    const survivorId = survivor.id;
    const mergedIds = others.map((r) => r.id);

    await db.query(
      `UPDATE operator_activity_log SET phase_instance_id = $1, updated_at = NOW()
       WHERE phase_instance_id = ANY($2::int[])`, [survivorId, mergedIds]);
    await db.query(
      `UPDATE production_counts SET phase_instance_id = $1
       WHERE phase_instance_id = ANY($2::int[])`, [survivorId, mergedIds]
    ).catch(() => {}); // production_counts may not have the column in all envs
    await db.query(
      `UPDATE phase_instances
       SET status = 'deleted',
           notes = COALESCE(notes,'') || ' [merged into #' || $1 || ']',
           updated_at = NOW()
       WHERE id = ANY($2::int[])`, [survivorId, mergedIds]);
    // Learn phase-name synonyms
    for (const o of others) {
      if (o.phase_name && survivor.phase_name &&
          o.phase_name.toLowerCase() !== survivor.phase_name.toLowerCase()) {
        await db.query(
          `INSERT INTO task_aliases (canonical_term, alias_term, learned_from_task_id)
           VALUES ($1, $2, $3) ON CONFLICT (canonical_term, alias_term) DO NOTHING`,
          [survivor.phase_name, o.phase_name, survivorId]
        ).catch(() => {});
      }
    }
    await auditAction({
      req, action: 'phase_instance.merge', entityType: 'phase_instance',
      entityId: survivorId, before: { ids },
      after: { survivor_id: survivorId, merged_ids: mergedIds },
    });
    res.json({ ok: true, survivor_id: survivorId, merged_ids: mergedIds });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── phase_instances (Fase 2.4) ─────────────────────────────────────────

router.get('/phase-instances', async (req, res) => {
  try {
    const where = ['pi.status <> \'deleted\''];
    const params = [];
    if (req.query.workflow_instance_id) {
      where.push(`pi.workflow_instance_id = $${params.length + 1}`);
      params.push(parseInt(req.query.workflow_instance_id));
    }
    if (req.query.status) {
      where[0] = `pi.status = $${params.length + 1}`;
      params.push(req.query.status);
    }
    if (req.query.date) {
      where.push(`(pi.started_at AT TIME ZONE 'America/New_York')::date = $${params.length + 1}::date`);
      params.push(req.query.date);
    }
    const limit = Math.min(parseInt(req.query.limit) || 300, 1000);
    const r = await db.query(
      `SELECT pi.id, pi.workflow_instance_id, pi.phase_template_id, pi.phase_name,
              pi.batch_number, pi.batch_change_approved, pi.status,
              pi.started_at, pi.ended_at, pi.started_by_operator_id,
              pi.closed_by_operator_id, pi.final_bottle_count, pi.notes,
              wi.product_name, wi.workflow_template_id
       FROM phase_instances pi
       LEFT JOIN workflow_instances wi ON wi.id = pi.workflow_instance_id
       WHERE ${where.join(' AND ')}
       ORDER BY pi.started_at DESC
       LIMIT ${limit}`,
      params
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/phase-instances/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const r = await db.query('SELECT * FROM phase_instances WHERE id = $1', [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/admin/phase-instances', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const {
      workflow_instance_id, phase_template_id, phase_name, batch_number,
      started_at, started_by_operator_id, notes,
    } = req.body;
    if (!Number.isFinite(workflow_instance_id))
      return res.status(400).json({ error: 'workflow_instance_id obrigatório' });

    // Resolve phase_name from phase_template if not provided
    let name = phase_name;
    if (!name && Number.isFinite(phase_template_id)) {
      const pt = await db.query('SELECT name FROM phase_templates WHERE id = $1', [phase_template_id]);
      name = pt.rows[0]?.name || null;
    }
    const r = await db.query(
      `INSERT INTO phase_instances
         (workflow_instance_id, phase_template_id, phase_name, batch_number,
          started_at, started_by_operator_id, notes, status)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6, $7, 'open')
       RETURNING id`,
      [workflow_instance_id, phase_template_id || null, name,
       batch_number || null, started_at || null, started_by_operator_id || null, notes || null]
    );
    const id = r.rows[0].id;
    const after = await snapshotRow('phase_instances', 'id', id);
    await auditAction({ req, action: 'phase_instance.create', entityType: 'phase_instance',
                        entityId: id, before: null, after });
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/admin/phase-instances/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const before = await snapshotRow('phase_instances', 'id', id);
    if (!before) return res.status(404).json({ error: 'not found' });

    const sets = ['updated_at = NOW()'];
    const params = [];
    const {
      phase_name, batch_number, started_at, ended_at, status,
      started_by_operator_id, closed_by_operator_id, final_bottle_count,
      notes, batch_change_approved, workflow_instance_id,
    } = req.body;

    if (phase_name        !== undefined) { sets.push(`phase_name = $${params.length + 1}`); params.push(phase_name || null); }
    if (started_at)                      { sets.push(`started_at = $${params.length + 1}::timestamptz`); params.push(started_at); }
    if (ended_at !== undefined)          { sets.push(`ended_at = $${params.length + 1}::timestamptz`);   params.push(ended_at || null); }
    if (status !== undefined)            { sets.push(`status = $${params.length + 1}`); params.push(status); }
    if (started_by_operator_id !== undefined) {
      sets.push(`started_by_operator_id = $${params.length + 1}`);
      params.push(started_by_operator_id || null);
    }
    if (closed_by_operator_id !== undefined) {
      sets.push(`closed_by_operator_id = $${params.length + 1}`);
      params.push(closed_by_operator_id || null);
    }
    if (final_bottle_count !== undefined) {
      sets.push(`final_bottle_count = $${params.length + 1}`);
      params.push(Number.isFinite(final_bottle_count) ? final_bottle_count : null);
    }
    if (notes !== undefined)             { sets.push(`notes = $${params.length + 1}`); params.push(notes || null); }
    if (batch_change_approved !== undefined) {
      sets.push(`batch_change_approved = $${params.length + 1}`);
      params.push(!!batch_change_approved);
    }
    // Allow admin to MOVE phase to a different workflow_instance
    let moved = false;
    if (workflow_instance_id !== undefined && workflow_instance_id !== before.workflow_instance_id) {
      sets.push(`workflow_instance_id = $${params.length + 1}`);
      params.push(workflow_instance_id);
      moved = true;
    }
    let batchChanged = false;
    if (batch_number !== undefined && batch_number !== before.batch_number) {
      sets.push(`batch_number = $${params.length + 1}`); params.push(batch_number || null);
      sets.push(`batch_change_approved = FALSE`);
      batchChanged = true;
    }
    params.push(id);

    await db.query(`UPDATE phase_instances SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const after = await snapshotRow('phase_instances', 'id', id);
    const action = batchChanged ? 'phase_instance.batch_changed'
                  : moved        ? 'phase_instance.moved'
                  :                'phase_instance.edit';
    await auditAction({ req, action, entityType: 'phase_instance',
                        entityId: id, before, after });
    res.json({ ok: true, moved, batch_changed: batchChanged });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/admin/phase-instances/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const before = await snapshotRow('phase_instances', 'id', id);
    if (!before) return res.status(404).json({ error: 'not found' });
    await db.query(
      `UPDATE phase_instances SET status = 'deleted', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    const after = await snapshotRow('phase_instances', 'id', id);
    await auditAction({ req, action: 'phase_instance.delete', entityType: 'phase_instance',
                        entityId: id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ad_hoc_tasks (Fase 2.5) ────────────────────────────────────────────

// GET /api/ad-hoc-tasks?include_inactive=1&pending_only=1
router.get('/ad-hoc-tasks', async (req, res) => {
  try {
    const where = [];
    if (req.query.include_inactive !== '1') where.push('is_active = TRUE');
    if (req.query.pending_only === '1') where.push('admin_approved = FALSE');
    const r = await db.query(
      `SELECT id, name, description, is_active, admin_approved,
              created_by_operator_id, created_at, updated_at
       FROM ad_hoc_tasks
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY admin_approved ASC, name ASC`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/admin/ad-hoc-tasks', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const { name, description, admin_approved } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });
    const r = await db.query(
      `INSERT INTO ad_hoc_tasks (name, description, is_active, admin_approved)
       VALUES ($1, $2, TRUE, $3)
       RETURNING id`,
      [name.trim(), description || null, admin_approved !== false]
    );
    const id = r.rows[0].id;
    const after = await snapshotRow('ad_hoc_tasks', 'id', id);
    await auditAction({ req, action: 'ad_hoc_task.create', entityType: 'ad_hoc_task',
                        entityId: id, before: null, after });
    res.json({ ok: true, id });
  } catch (err) {
    if (/duplicate key/.test(err.message)) return res.status(409).json({ error: 'name já existe' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/ad-hoc-tasks/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const before = await snapshotRow('ad_hoc_tasks', 'id', id);
    if (!before) return res.status(404).json({ error: 'not found' });

    const sets = ['updated_at = NOW()'];
    const params = [];
    const { name, description, is_active, admin_approved } = req.body;
    if (name           !== undefined) { sets.push(`name = $${params.length + 1}`);           params.push(name.trim()); }
    if (description    !== undefined) { sets.push(`description = $${params.length + 1}`);    params.push(description || null); }
    if (is_active      !== undefined) { sets.push(`is_active = $${params.length + 1}`);      params.push(!!is_active); }
    if (admin_approved !== undefined) { sets.push(`admin_approved = $${params.length + 1}`); params.push(!!admin_approved); }
    params.push(id);
    await db.query(`UPDATE ad_hoc_tasks SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

    const after = await snapshotRow('ad_hoc_tasks', 'id', id);
    const wasApproved = before.admin_approved;
    const nowApproved = after.admin_approved;
    const action = (!wasApproved && nowApproved) ? 'ad_hoc_task.approve' : 'ad_hoc_task.edit';
    await auditAction({ req, action, entityType: 'ad_hoc_task', entityId: id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/ad-hoc-tasks/:id/merge-into/:target — merge a pending
// ad-hoc into an existing approved one. Re-points all task_instances and
// deactivates the source.
router.post('/admin/ad-hoc-tasks/:id/merge-into/:target', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    const target = parseInt(req.params.target);
    if (!Number.isFinite(id) || !Number.isFinite(target) || id === target) {
      return res.status(400).json({ error: 'ids inválidos' });
    }
    const before = await snapshotRow('ad_hoc_tasks', 'id', id);
    const tgt = await snapshotRow('ad_hoc_tasks', 'id', target);
    if (!before || !tgt) return res.status(404).json({ error: 'not found' });

    await db.query(
      `UPDATE ad_hoc_task_instances
         SET ad_hoc_task_id = $1,
             task_name = $2,
             updated_at = NOW()
       WHERE ad_hoc_task_id = $3`,
      [target, tgt.name, id]
    );
    await db.query(
      `UPDATE ad_hoc_tasks
         SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
    await auditAction({
      req, action: 'ad_hoc_task.merge', entityType: 'ad_hoc_task',
      entityId: target,
      before: { source: before, target: tgt },
      after:  { merged_source_id: id, merged_into: target },
    });
    res.json({ ok: true, merged_into: target });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ad_hoc_task_instances (paired with task catalog) ───────────────────

router.get('/ad-hoc-task-instances', async (req, res) => {
  try {
    const where = ['ati.status <> \'deleted\''];
    const params = [];
    if (req.query.status) {
      where[0] = `ati.status = $${params.length + 1}`;
      params.push(req.query.status);
    }
    if (req.query.date) {
      where.push(`(ati.started_at AT TIME ZONE 'America/New_York')::date = $${params.length + 1}::date`);
      params.push(req.query.date);
    }
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const r = await db.query(
      `SELECT ati.id, ati.ad_hoc_task_id, ati.task_name, ati.status,
              ati.started_at, ati.ended_at,
              ati.started_by_operator_id, ati.closed_by_operator_id,
              ati.linked_workflow_instance_id, ati.linked_phase_instance_id, ati.notes,
              aht.admin_approved
       FROM ad_hoc_task_instances ati
       LEFT JOIN ad_hoc_tasks aht ON aht.id = ati.ad_hoc_task_id
       WHERE ${where.join(' AND ')}
       ORDER BY ati.started_at DESC
       LIMIT ${limit}`,
      params
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/admin/ad-hoc-task-instances/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const before = await snapshotRow('ad_hoc_task_instances', 'id', id);
    if (!before) return res.status(404).json({ error: 'not found' });

    const sets = ['updated_at = NOW()'];
    const params = [];
    const {
      status, started_at, ended_at, started_by_operator_id, closed_by_operator_id,
      linked_workflow_instance_id, linked_phase_instance_id, notes, ad_hoc_task_id, task_name,
    } = req.body;
    if (status !== undefined)        { sets.push(`status = $${params.length + 1}`); params.push(status); }
    if (started_at)                  { sets.push(`started_at = $${params.length + 1}::timestamptz`); params.push(started_at); }
    if (ended_at !== undefined)      { sets.push(`ended_at = $${params.length + 1}::timestamptz`);   params.push(ended_at || null); }
    if (started_by_operator_id !== undefined) {
      sets.push(`started_by_operator_id = $${params.length + 1}`);
      params.push(started_by_operator_id || null);
    }
    if (closed_by_operator_id !== undefined) {
      sets.push(`closed_by_operator_id = $${params.length + 1}`);
      params.push(closed_by_operator_id || null);
    }
    if (linked_workflow_instance_id !== undefined) {
      sets.push(`linked_workflow_instance_id = $${params.length + 1}`);
      params.push(linked_workflow_instance_id || null);
    }
    if (linked_phase_instance_id !== undefined) {
      sets.push(`linked_phase_instance_id = $${params.length + 1}`);
      params.push(linked_phase_instance_id || null);
    }
    if (notes !== undefined)         { sets.push(`notes = $${params.length + 1}`); params.push(notes || null); }
    if (ad_hoc_task_id !== undefined){ sets.push(`ad_hoc_task_id = $${params.length + 1}`); params.push(ad_hoc_task_id); }
    if (task_name !== undefined)     { sets.push(`task_name = $${params.length + 1}`); params.push(task_name); }
    params.push(id);
    await db.query(`UPDATE ad_hoc_task_instances SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

    const after = await snapshotRow('ad_hoc_task_instances', 'id', id);
    await auditAction({ req, action: 'ad_hoc_task_instance.edit', entityType: 'ad_hoc_task_instance',
                        entityId: id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/admin/ad-hoc-task-instances/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const before = await snapshotRow('ad_hoc_task_instances', 'id', id);
    if (!before) return res.status(404).json({ error: 'not found' });
    await db.query(
      `UPDATE ad_hoc_task_instances SET status = 'deleted', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    const after = await snapshotRow('ad_hoc_task_instances', 'id', id);
    await auditAction({ req, action: 'ad_hoc_task_instance.delete', entityType: 'ad_hoc_task_instance',
                        entityId: id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── operator_activity_log (Fase 2.6) ───────────────────────────────────

// ===== A3 — admin-only internal notes per instance =====
const ADMIN_NOTE_TABLES = {
  workflow_instance: 'workflow_instances',
  phase_instance: 'phase_instances',
  ad_hoc_task_instance: 'ad_hoc_task_instances',
};

// GET /api/admin/admin-note?pin&entity_type&entity_id  → { text }
router.get('/admin/admin-note', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  const tbl = ADMIN_NOTE_TABLES[req.query.entity_type];
  const eid = parseInt(req.query.entity_id);
  if (!tbl || !Number.isFinite(eid)) return res.status(400).json({ error: 'entity_type/entity_id inválido' });
  try {
    const r = await db.query(`SELECT admin_notes FROM ${tbl} WHERE id = $1`, [eid]);
    res.json({ text: r.rows[0]?.admin_notes || '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/admin-note  body: { pin, entity_type, entity_id, text }
router.post('/admin/admin-note', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  const { entity_type, entity_id, text } = req.body || {};
  const tbl = ADMIN_NOTE_TABLES[entity_type];
  const eid = parseInt(entity_id);
  if (!tbl || !Number.isFinite(eid)) return res.status(400).json({ error: 'entity_type/entity_id inválido' });
  try {
    const before = await db.query(`SELECT admin_notes FROM ${tbl} WHERE id = $1`, [eid]);
    if (before.rows.length === 0) return res.status(404).json({ error: 'not found' });
    await db.query(
      `UPDATE ${tbl} SET admin_notes = NULLIF($1,''), updated_at = NOW() WHERE id = $2`,
      [String(text || ''), eid]
    );
    await auditAction({
      req, action: before.rows[0].admin_notes ? 'admin_note.edit' : 'admin_note.create',
      entityType: entity_type, entityId: eid,
      before: { admin_notes: before.rows[0].admin_notes || null },
      after: { admin_notes: text || null },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/operator-activity-log?operator_id=N&date=YYYY-MM-DD&since=ISO&active_only=1
router.get('/operator-activity-log', async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.operator_id) {
      where.push(`oal.operator_id = $${params.length + 1}`);
      params.push(parseInt(req.query.operator_id));
    }
    if (req.query.date) {
      where.push(`(oal.started_at AT TIME ZONE 'America/New_York')::date = $${params.length + 1}::date`);
      params.push(req.query.date);
    }
    if (req.query.since) {
      where.push(`oal.started_at >= $${params.length + 1}::timestamptz`);
      params.push(req.query.since);
    }
    if (req.query.active_only === '1') where.push('oal.ended_at IS NULL');
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
    const r = await db.query(
      `SELECT oal.id, oal.operator_id, oal.activity_type,
              oal.phase_instance_id, oal.ad_hoc_task_instance_id, oal.pause_id,
              oal.started_at, oal.ended_at, oal.duration_seconds, oal.role,
              oal.left_for_id, oal.came_back_from_id, oal.notes,
              o.name AS operator_name,
              pi.phase_name, pi.batch_number AS phase_batch_number,
              wi.product_name, wi.id AS workflow_instance_id,
              ati.task_name AS ad_hoc_name
       FROM operator_activity_log oal
       LEFT JOIN operators o ON o.id = oal.operator_id
       LEFT JOIN phase_instances pi ON pi.id = oal.phase_instance_id
       LEFT JOIN workflow_instances wi ON wi.id = pi.workflow_instance_id
       LEFT JOIN ad_hoc_task_instances ati ON ati.id = oal.ad_hoc_task_instance_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY oal.started_at DESC, oal.id DESC
       LIMIT ${limit}`,
      params
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// A1 — POST a retroactive timeline entry for an operator.
router.post('/admin/operator-activity-log', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const {
      operator_id, activity_type, started_at, ended_at,
      phase_instance_id, ad_hoc_task_instance_id, pause_id, role, notes,
    } = req.body;
    if (!Number.isFinite(operator_id)) return res.status(400).json({ error: 'operator_id obrigatório' });
    if (!['phase', 'ad_hoc', 'break', 'idle'].includes(activity_type)) {
      return res.status(400).json({ error: 'activity_type inválido' });
    }
    if (!started_at) return res.status(400).json({ error: 'started_at obrigatório' });
    const ins = await db.query(
      `INSERT INTO operator_activity_log
         (operator_id, activity_type, phase_instance_id, ad_hoc_task_instance_id,
          pause_id, started_at, ended_at, role, notes,
          duration_seconds)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8,$9,
          CASE WHEN $7::timestamptz IS NOT NULL
               THEN EXTRACT(EPOCH FROM ($7::timestamptz - $6::timestamptz))::int END)
       RETURNING id`,
      [operator_id, activity_type, phase_instance_id || null,
       ad_hoc_task_instance_id || null, pause_id || null,
       started_at, ended_at || null, role || null, notes || null]
    );
    const after = await snapshotRow('operator_activity_log', 'id', ins.rows[0].id);
    await auditAction({ req, action: 'oal.create_retroactive',
                        entityType: 'operator_activity_log',
                        entityId: ins.rows[0].id, before: null, after });
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/admin/operator-activity-log/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const before = await snapshotRow('operator_activity_log', 'id', id);
    if (!before) return res.status(404).json({ error: 'not found' });

    const sets = ['updated_at = NOW()'];
    const params = [];
    const {
      activity_type, phase_instance_id, ad_hoc_task_instance_id, pause_id,
      started_at, ended_at, role, left_for_id, came_back_from_id, notes,
    } = req.body;
    if (activity_type !== undefined) {
      if (!['phase','ad_hoc','break','idle'].includes(activity_type)) {
        return res.status(400).json({ error: 'activity_type inválido' });
      }
      sets.push(`activity_type = $${params.length + 1}`); params.push(activity_type);
    }
    if (phase_instance_id !== undefined)        { sets.push(`phase_instance_id = $${params.length + 1}`);        params.push(phase_instance_id || null); }
    if (ad_hoc_task_instance_id !== undefined)  { sets.push(`ad_hoc_task_instance_id = $${params.length + 1}`);  params.push(ad_hoc_task_instance_id || null); }
    if (pause_id !== undefined)                 { sets.push(`pause_id = $${params.length + 1}`);                 params.push(pause_id || null); }
    if (started_at)                             { sets.push(`started_at = $${params.length + 1}::timestamptz`); params.push(started_at); }
    if (ended_at !== undefined)                 { sets.push(`ended_at = $${params.length + 1}::timestamptz`);   params.push(ended_at || null); }
    if (role !== undefined)                     { sets.push(`role = $${params.length + 1}`); params.push(role || null); }
    if (left_for_id !== undefined)              { sets.push(`left_for_id = $${params.length + 1}`); params.push(left_for_id || null); }
    if (came_back_from_id !== undefined)        { sets.push(`came_back_from_id = $${params.length + 1}`); params.push(came_back_from_id || null); }
    if (notes !== undefined)                    { sets.push(`notes = $${params.length + 1}`); params.push(notes || null); }

    params.push(id);
    await db.query(`UPDATE operator_activity_log SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    // Bug 2: recompute duration in a SECOND statement so it reads the
    // NEW row. In a single UPDATE every SET right-hand-side sees the OLD
    // row, so a retroactive started_at/ended_at edit (untracked break
    // started_at==ended_at) would keep duration 0. GREATEST guards a
    // backwards edit.
    await db.query(
      `UPDATE operator_activity_log
       SET duration_seconds = CASE
             WHEN ended_at IS NOT NULL AND started_at IS NOT NULL
             THEN GREATEST(0, EXTRACT(EPOCH FROM (ended_at - started_at))::int)
             ELSE NULL END
       WHERE id = $1`, [id]);
    const after = await snapshotRow('operator_activity_log', 'id', id);
    // Bug 2: retroactive break/time edits are audited distinctly.
    const action = (req.body && (req.body.retroactive === true || req.body.retroactive === 'true'))
      ? 'oal.edit_retroactive' : 'oal.edit';
    await auditAction({ req, action, entityType: 'operator_activity_log',
                        entityId: id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/admin/operator-activity-log/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const before = await snapshotRow('operator_activity_log', 'id', id);
    if (!before) return res.status(404).json({ error: 'not found' });
    // Hard delete: operator_activity_log is finely-grained, soft-delete adds
    // noise to the timeline. Audit log preserves the before state forever.
    await db.query('DELETE FROM operator_activity_log WHERE id = $1', [id]);
    await auditAction({ req, action: 'oal.delete', entityType: 'operator_activity_log',
                        entityId: id, before, after: null });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/move-operator
// body: { pin, operator_id, target_phase_instance_id? OR target_ad_hoc_task_instance_id?,
//         retroactive_started_at? (defaults to NOW) }
// Closes the operator's current active row (if any) and opens a new one
// at the destination. Records the transition with left_for_id link.
router.post('/admin/move-operator', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const {
      operator_id, target_phase_instance_id, target_ad_hoc_task_instance_id,
      retroactive_started_at, role,
    } = req.body;
    if (!Number.isFinite(operator_id)) return res.status(400).json({ error: 'operator_id obrigatório' });
    const hasPhase = Number.isFinite(target_phase_instance_id);
    const hasAdhoc = Number.isFinite(target_ad_hoc_task_instance_id);
    if (hasPhase === hasAdhoc) {
      return res.status(400).json({ error: 'forneça EXATAMENTE 1 destino (phase_instance OU ad_hoc_task_instance)' });
    }

    const cur = await db.query(
      `SELECT id FROM operator_activity_log
       WHERE operator_id = $1 AND ended_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [operator_id]
    );
    const previousId = cur.rows[0]?.id || null;
    const ts = retroactive_started_at || new Date().toISOString();

    // Open new log row first so we can link back
    const insRes = await db.query(
      `INSERT INTO operator_activity_log
         (operator_id, activity_type, phase_instance_id, ad_hoc_task_instance_id,
          started_at, role, came_back_from_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [operator_id,
       hasPhase ? 'phase' : 'ad_hoc',
       hasPhase ? target_phase_instance_id : null,
       hasAdhoc ? target_ad_hoc_task_instance_id : null,
       ts,
       role || 'joiner',
       previousId]
    );
    const newId = insRes.rows[0].id;

    // Close the previous row (if any) and link it forward
    if (previousId) {
      await db.query(
        `UPDATE operator_activity_log
         SET ended_at = $1::timestamptz,
             duration_seconds = EXTRACT(EPOCH FROM ($1::timestamptz - started_at))::int,
             left_for_id = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [ts, newId, previousId]
      );
    }

    await auditAction({
      req, action: 'oal.move_operator', entityType: 'operator_activity_log',
      entityId: newId,
      before: { previous_oal_id: previousId },
      after: { new_oal_id: newId, target_phase: target_phase_instance_id || null,
               target_adhoc: target_ad_hoc_task_instance_id || null, ts },
    });
    res.json({ ok: true, new_oal_id: newId, previous_oal_id: previousId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Operator panel (Fase 7.1) ──────────────────────────────────────────

// GET /api/operator-panel — live per-operator strip for the dashboard top.
// One row per active operator: current activity + today's mini-stats.
router.get('/operator-panel', async (req, res) => {
  try {
    const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const ops = await db.query(`SELECT id, name FROM operators WHERE active = TRUE ORDER BY name`);
    const out = [];
    for (const op of ops.rows) {
      const cur = await db.query(
        `SELECT oal.activity_type, oal.started_at,
                pi.phase_name, wi.product_name,
                ati.task_name
         FROM operator_activity_log oal
         LEFT JOIN phase_instances pi ON pi.id = oal.phase_instance_id
         LEFT JOIN workflow_instances wi ON wi.id = pi.workflow_instance_id
         LEFT JOIN ad_hoc_task_instances ati ON ati.id = oal.ad_hoc_task_instance_id
         WHERE oal.operator_id = $1 AND oal.ended_at IS NULL
         ORDER BY oal.id DESC LIMIT 1`,
        [op.id]
      );
      const c = cur.rows[0] || null;
      const stats = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN activity_type IN ('phase','ad_hoc') THEN duration_seconds ELSE 0 END), 0)::int AS worked_secs,
           COALESCE(SUM(CASE WHEN activity_type = 'break' THEN duration_seconds ELSE 0 END), 0)::int AS break_secs,
           COUNT(*) FILTER (WHERE activity_type = 'phase' AND ended_at IS NOT NULL)::int AS phases_done
         FROM operator_activity_log
         WHERE operator_id = $1
           AND (started_at AT TIME ZONE 'America/New_York')::date = $2::date`,
        [op.id, date]
      );
      const bottles = await db.query(
        `SELECT COALESCE(SUM(pi.final_bottle_count), 0)::int AS n
         FROM phase_instances pi
         WHERE pi.closed_by_operator_id = $1
           AND (pi.ended_at AT TIME ZONE 'America/New_York')::date = $2::date`,
        [op.id, date]
      );
      out.push({
        operator_id: op.id,
        name: op.name,
        status: c ? c.activity_type : 'idle',
        current: c ? {
          type: c.activity_type,
          label: c.phase_name
            ? `${c.phase_name}${c.product_name ? ' · ' + c.product_name : ''}`
            : (c.task_name || (c.activity_type === 'break' ? 'break' : 'sem atividade')),
          since: c.started_at,
        } : null,
        today: {
          worked_seconds: stats.rows[0].worked_secs,
          break_seconds: stats.rows[0].break_secs,
          phases_done: stats.rows[0].phases_done,
          bottles: bottles.rows[0].n,
        },
      });
    }
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Legacy migration trigger (Fase 4.2) ────────────────────────────────

// POST /api/admin/migrate-legacy  body: { pin, limit? }
// Runs migrateAll synchronously. Safe to re-trigger (idempotent).
router.post('/admin/migrate-legacy', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const { migrateAll } = require('../workflow/migrate-legacy');
    const limit = Math.min(parseInt(req.body?.limit) || 10000, 50000);
    const summary = await migrateAll({ limit });
    await auditAction({
      req, action: 'legacy.migrate', entityType: 'cleanup',
      entityId: null, after: summary,
    });
    res.json({ ok: true, summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
