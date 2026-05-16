'use strict';
/**
 * BLOCO C / P3 — autonomous detection. Runs on a 30-min cron
 * (scheduler.startDetectJob). Each detector finds a situation that
 * merits a proposal; detectAndPropose() stores it in carolina_proposals
 * (de-duped so the same thing isn't re-proposed every 30min), mirrors it
 * into the W6 single-proposal store so the admin's "sim/não" executes
 * the audited EXEC, and posts the proposal to the admin channel (never
 * silenced).
 *
 * Each detector is independent and defensive: a schema mismatch in one
 * query must not break the others or the cron.
 */
const db = require('../db');

const BIZ_START_H = 8;   // 08:00 ET
const BIZ_END_H = 19;    // 19:00 ET

async function q(sql, params) {
  try { return (await db.query(sql, params)).rows; }
  catch (e) { console.error('[Detect] query failed:', e.message); return []; }
}

// 1. Phase open > 4h with no oal activity in the last 4h → propose close.
async function phasesStale() {
  const rows = await q(`
    SELECT pi.id, pi.phase_name, pi.started_at
    FROM phase_instances pi
    WHERE pi.status = 'open' AND pi.ended_at IS NULL
      AND pi.started_at < NOW() - INTERVAL '4 hours'
      AND NOT EXISTS (
        SELECT 1 FROM operator_activity_log oal
        WHERE oal.phase_instance_id = pi.id
          AND COALESCE(oal.ended_at, oal.started_at) > NOW() - INTERVAL '4 hours')
    ORDER BY pi.started_at ASC LIMIT 10`);
  return rows.map((r) => ({
    proposalType: 'close_phase', targetEntityType: 'phase_instance', targetEntityId: r.id,
    proposedAction: { tool: 'close_phase', input: { phase_instance_id: r.id } },
    summary: `fase #${r.id} (${r.phase_name || '?'}) aberta há +4h sem atividade`,
  }));
}

// 2. Active operator idle > 1h during business hours → alert.
async function operatorsIdle() {
  const nowH = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
  if (nowH < BIZ_START_H || nowH >= BIZ_END_H) return [];
  const rows = await q(`
    SELECT o.id, o.name
    FROM operators o
    WHERE o.active = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM operator_activity_log oal
        WHERE oal.operator_id = o.id AND oal.ended_at IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM operator_activity_log oal
        WHERE oal.operator_id = o.id
          AND COALESCE(oal.ended_at, oal.started_at) > NOW() - INTERVAL '1 hour')
    ORDER BY o.name LIMIT 10`);
  return rows.map((r) => ({
    proposalType: 'operator_idle', targetEntityType: 'operator', targetEntityId: r.id,
    proposedAction: { tool: null, input: { operator_id: r.id } },
    summary: `${r.name} sem atividade há +1h em horário comercial`,
    alertOnly: true,
  }));
}

// 3. workflow_instance with NULL batch_number > 1h → ask batch.
async function workflowsNoBatch() {
  const rows = await q(`
    SELECT wi.id, wi.product_name
    FROM workflow_instances wi
    WHERE wi.status = 'active' AND wi.ended_at IS NULL
      AND (wi.batch_number IS NULL OR wi.batch_number = '')
      AND wi.started_at < NOW() - INTERVAL '1 hour'
    ORDER BY wi.started_at ASC LIMIT 10`);
  return rows.map((r) => ({
    proposalType: 'ask_batch', targetEntityType: 'workflow_instance', targetEntityId: r.id,
    proposedAction: { tool: null, input: { workflow_instance_id: r.id } },
    summary: `batch #${r.id} (${r.product_name || '?'}) sem número de lote há +1h`,
    alertOnly: true,
  }));
}

// 4. ad_hoc_tasks pending approval > 24h → remind.
async function adhocPending() {
  const rows = await q(`
    SELECT id, name FROM ad_hoc_tasks
    WHERE admin_approved = FALSE
      AND created_at < NOW() - INTERVAL '24 hours'
    ORDER BY created_at ASC LIMIT 10`);
  return rows.map((r) => ({
    proposalType: 'approve_adhoc', targetEntityType: 'ad_hoc_task', targetEntityId: r.id,
    proposedAction: { tool: 'approve_adhoc', input: { adhoc_task_id: r.id } },
    summary: `tarefa avulsa #${r.id} ("${r.name}") pendente de aprovação há +24h`,
  }));
}

// 5. supplements pending approval > 24h → remind.
async function supplementsPending() {
  const rows = await q(`
    SELECT canonical_name FROM supplement_catalog
    WHERE admin_approved = FALSE
      AND created_at < NOW() - INTERVAL '24 hours'
    ORDER BY created_at ASC LIMIT 10`);
  return rows.map((r) => ({
    proposalType: 'approve_supplement', targetEntityType: 'supplement', targetEntityId: r.canonical_name,
    proposedAction: { tool: 'approve_supplement', input: { name: r.canonical_name } },
    summary: `suplemento "${r.canonical_name}" pendente de aprovação há +24h`,
  }));
}

// 6. Two active workflow_instances, same product + batch → propose merge.
async function duplicateBatches() {
  const rows = await q(`
    SELECT product_name, batch_number,
           array_agg(id ORDER BY id) AS ids
    FROM workflow_instances
    WHERE status = 'active' AND ended_at IS NULL
      AND batch_number IS NOT NULL AND batch_number <> ''
    GROUP BY product_name, batch_number
    HAVING COUNT(*) > 1 LIMIT 10`);
  return rows.map((r) => ({
    proposalType: 'merge_tasks', targetEntityType: 'workflow_instance',
    targetEntityId: (r.ids || []).join(','),
    proposedAction: { tool: 'merge_tasks', input: { task_ids: r.ids || [] } },
    summary: `2+ batches abertos do mesmo ${r.product_name} #${r.batch_number}`,
  }));
}

const DETECTORS = [
  phasesStale, operatorsIdle, workflowsNoBatch,
  adhocPending, supplementsPending, duplicateBatches,
];

// BLOCO C / P7 — Bloco B message toggles also gate the autonomous
// Carolina. If the admin turns a category OFF in the Config Carolina
// panel, the cron stops proposing that category. (Spec example: disable
// "Pergunta de conflito" → no proposals to close open phases.)
const PROPOSAL_TYPE_TOGGLE = {
  close_phase: 'conflict',
  ask_batch: 'conflict',
  merge_tasks: 'conflict',
  operator_idle: 'urgency',
  approve_adhoc: 'task',
  approve_supplement: 'task',
};
async function defaultIsTypeEnabled(proposalType) {
  const toggle = PROPOSAL_TYPE_TOGGLE[proposalType];
  if (!toggle) return true; // unmapped → not gated
  try {
    return await require('../app-state').isMsgEnabled(toggle);
  } catch (_) {
    return true; // never let a config read failure silence detection
  }
}

function buildProposeText(c) {
  if (c.alertOnly) {
    return `🤖 Detectei: ${c.summary}. Quer que eu faça algo? Responda "sim" ou "não".`;
  }
  return `🤖 Detectei: ${c.summary}. Proposta: ${c.proposedAction.tool}. ` +
    `Quer que eu execute? Responda "sim" pra executar, "não" pra ignorar.`;
}

/**
 * Run all detectors, persist + announce new proposals.
 * deps: { proposals, adminTools, postToAdmin, isTypeEnabled }
 *  - isTypeEnabled(proposalType) → P7 toggle gate (default: always true).
 */
async function detectAndPropose(deps = {}) {
  const proposals = deps.proposals || require('./proposals');
  const adminTools = deps.adminTools || require('./admin-tools');
  const postToAdmin = deps.postToAdmin
    || (async (t) => require('../workflow/announce').toAdmin(t));
  const isTypeEnabled = deps.isTypeEnabled || defaultIsTypeEnabled;

  const made = [];
  for (const detector of DETECTORS) {
    let candidates = [];
    try { candidates = await detector(); } catch (e) {
      console.error('[Detect] detector error:', e.message); continue;
    }
    for (const c of candidates) {
      if (!(await isTypeEnabled(c.proposalType))) continue;
      let row;
      try {
        row = await proposals.create({
          proposalType: c.proposalType,
          targetEntityType: c.targetEntityType,
          targetEntityId: c.targetEntityId,
          proposedAction: c.proposedAction,
          source: 'cron',
        });
      } catch (e) { console.error('[Detect] create failed:', e.message); continue; }
      if (row && row._deduped) continue; // already proposed; don't re-spam
      // Mirror executable proposals into the W6 single-proposal store so
      // the admin's "sim" runs the audited EXEC. Don't clobber an
      // existing pending W6 proposal.
      if (c.proposedAction.tool && adminTools.MUTATION_TOOLS.has(c.proposedAction.tool)) {
        try {
          const existing = await adminTools.getProposal();
          if (!existing) {
            await adminTools.setProposal({
              kind: c.proposedAction.tool, args: c.proposedAction.input,
              at: new Date().toISOString(), from: 'cron', carolina_proposal_id: row.id,
            });
          }
        } catch (_) {}
      }
      try { await postToAdmin(buildProposeText(c)); } catch (_) {}
      made.push({ type: c.proposalType, id: row && row.id, summary: c.summary });
    }
  }
  return made;
}

module.exports = {
  detectAndPropose, buildProposeText, DETECTORS,
  phasesStale, operatorsIdle, workflowsNoBatch,
  adhocPending, supplementsPending, duplicateBatches,
  PROPOSAL_TYPE_TOGGLE, defaultIsTypeEnabled,
};
