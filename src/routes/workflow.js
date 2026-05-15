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

module.exports = router;
