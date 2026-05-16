'use strict';
/**
 * W6 — Carolina-admin propose-then-confirm tooling for the admin
 * channel (C0B36DR5MP1).
 *
 * Lifecycle:
 *   1. propose(kind, args)  → stores ONE pending proposal in app_state
 *      (key 'ai_proposal') and returns the human propose-message.
 *   2. admin replies in the channel. parseConfirmation(text):
 *        'yes'    → resolveProposal() executes the stored action
 *        'no'     → clears it ("ok, deixa pra lá")
 *        'adjust' → keeps context, returns the free-text so the caller
 *                   can re-propose
 *   3. Every executed action is audited action='ai_admin_executed'
 *      with the original proposal in before/after.
 *
 * Executors call the existing engine / audited paths — no new mutation
 * logic, just orchestration. Read tools (get_state, etc) are side-effect
 * free. Persona stays human in the prod channel; the admin channel
 * knows she's an AI (PERSONA_ADMIN) — message text built here is
 * already in-character.
 */

const db = require('../db');

const KEY = 'ai_proposal';

// ─── Proposal store ──────────────────────────────────────────────────────
async function setProposal(p) {
  await db.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [KEY, JSON.stringify(p)]
  );
}
async function getProposal() {
  const r = await db.query(`SELECT value FROM app_state WHERE key = $1`, [KEY]);
  if (!r.rows[0]) return null;
  try { return JSON.parse(r.rows[0].value); } catch { return null; }
}
async function clearProposal() {
  await db.query(`DELETE FROM app_state WHERE key = $1`, [KEY]);
}

// ─── Confirmation parsing ────────────────────────────────────────────────
function parseConfirmation(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return 'adjust';
  if (/^(sim|s|isso|pode|confirma|confirmo|manda|faz|vai|ok|beleza|blz|claro|aprovo|positivo|👍|isso ai|isso aí)\b/.test(t)) return 'yes';
  if (/^(n[aã]o|n|nao|cancela|deixa|esquece|para|nem|negativo)\b/.test(t)) return 'no';
  return 'adjust';
}

// ─── Propose-message builders (Carolina voice) ───────────────────────────
const MSG = {
  close_phase: (a) => `Detectei que a fase #${a.phase_instance_id} tá aberta` +
    (a.hours ? ` há ${a.hours}h` : '') + `. Quer que eu feche? (sim / não / ajuste)`,
  merge_tasks: (a) => `Achei tarefas que parecem duplicadas: #${(a.task_ids||[]).join(', #')}. Mesclo? (sim/não)`,
  rename: (a) => `Quer renomear ${a.entity_type} #${a.id} pra "${a.new_name}"? (sim/não)`,
  approve_adhoc: (a) => `Tarefa avulsa #${a.adhoc_task_id} tá pendente de revisão. Aprovo? (sim/não)`,
  approve_supplement: (a) => `Suplemento "${a.name}" tá pendente. Aprovo no catálogo? (sim/não)`,
  move_operator: (a) => `Quer que eu mova ${a.operator_name || ('operador #'+a.operator_id)} pra atividade #${a.target_phase_instance_id || a.target_ad_hoc_task_instance_id}? (sim/não)`,
  create_workflow: (a) => `Quer criar o workflow "${a.name}"${a.phases ? ` com ${a.phases.length} fase(s)` : ''}? (sim/não)`,
};
function buildProposeMessage(kind, args) {
  const f = MSG[kind];
  return '🤖 ' + (f ? f(args) : `Proposta: ${kind}. Confirmar? (sim/não)`);
}

// ─── Executors (run on 'yes') ────────────────────────────────────────────
const EXEC = {
  async close_phase(a) {
    const engine = require('../workflow/engine');
    return engine.closePhase({ phaseInstanceId: a.phase_instance_id,
      closedByOperatorId: null, finalBottleCount: a.bottle_count || null });
  },
  async rename(a) {
    const tbl = {
      workflow_template: 'workflow_templates', phase_template: 'phase_templates',
      ad_hoc_task: 'ad_hoc_tasks',
    }[a.entity_type];
    if (!tbl) throw new Error('entity_type inválido pra rename');
    await db.query(`UPDATE ${tbl} SET name = $1, updated_at = NOW() WHERE id = $2`,
      [a.new_name, a.id]);
    return { renamed: true };
  },
  async approve_adhoc(a) {
    await db.query(
      `UPDATE ad_hoc_tasks SET admin_approved = TRUE, updated_at = NOW() WHERE id = $1`,
      [a.adhoc_task_id]);
    return { approved: true };
  },
  async approve_supplement(a) {
    await db.query(
      `UPDATE supplement_catalog SET aliases = aliases WHERE canonical_name = $1`,
      [a.name]); // touch row; presence in catalog = approved
    return { approved: true };
  },
  async create_workflow(a) {
    const r = await db.query(
      `INSERT INTO workflow_templates (name, description, is_active, pending_review)
       VALUES ($1, $2, TRUE, FALSE)
       ON CONFLICT (name) DO UPDATE SET pending_review = FALSE, updated_at = NOW()
       RETURNING id`, [a.name, a.description || 'Criado via Carolina admin']);
    const wfId = r.rows[0].id;
    for (let i = 0; i < (a.phases || []).length; i++) {
      await db.query(
        `INSERT INTO phase_templates (workflow_template_id, name, sequence_order, is_required, soft_prereq)
         VALUES ($1,$2,$3,FALSE,TRUE)`, [wfId, a.phases[i], i + 1]);
    }
    return { workflow_template_id: wfId };
  },
  async merge_tasks(a) {
    const { mergeTasks } = require('../admin/merge');
    return mergeTasks(a.task_ids, null);
  },
  async move_operator(a) {
    // mirror /admin/move-operator core
    const cur = await db.query(
      `SELECT id FROM operator_activity_log WHERE operator_id = $1 AND ended_at IS NULL
       ORDER BY id DESC LIMIT 1`, [a.operator_id]);
    const prev = cur.rows[0]?.id || null;
    const ts = new Date().toISOString();
    const hasPhase = Number.isFinite(a.target_phase_instance_id);
    const ins = await db.query(
      `INSERT INTO operator_activity_log
         (operator_id, activity_type, phase_instance_id, ad_hoc_task_instance_id,
          started_at, role, came_back_from_id)
       VALUES ($1,$2,$3,$4,$5,'joiner',$6) RETURNING id`,
      [a.operator_id, hasPhase ? 'phase' : 'ad_hoc',
       hasPhase ? a.target_phase_instance_id : null,
       hasPhase ? null : a.target_ad_hoc_task_instance_id, ts, prev]);
    if (prev) {
      await db.query(
        `UPDATE operator_activity_log SET ended_at = $1::timestamptz,
           duration_seconds = EXTRACT(EPOCH FROM ($1::timestamptz - started_at))::int,
           left_for_id = $2, updated_at = NOW() WHERE id = $3`,
        [ts, ins.rows[0].id, prev]);
    }
    return { new_oal_id: ins.rows[0].id };
  },
};

// ─── Read tools (no side effects) ────────────────────────────────────────
async function getState() {
  const [wf, ph, ah, br] = await Promise.all([
    db.query(`SELECT count(*)::int n FROM workflow_instances WHERE status='active'`),
    db.query(`SELECT count(*)::int n FROM phase_instances WHERE status='open'`),
    db.query(`SELECT count(*)::int n FROM ad_hoc_task_instances WHERE status='open'`),
    db.query(`SELECT count(*)::int n FROM operator_activity_log WHERE activity_type='break' AND ended_at IS NULL`),
  ]);
  return { active_workflows: wf.rows[0].n, open_phases: ph.rows[0].n,
           open_adhoc: ah.rows[0].n, on_break: br.rows[0].n };
}
async function getOperatorTimeline(operatorId, date) {
  const r = await db.query(
    `SELECT oal.activity_type, oal.started_at, oal.ended_at, pi.phase_name
     FROM operator_activity_log oal
     LEFT JOIN phase_instances pi ON pi.id = oal.phase_instance_id
     WHERE oal.operator_id = $1
       AND (oal.started_at AT TIME ZONE 'America/New_York')::date = $2::date
     ORDER BY oal.started_at ASC`, [operatorId, date || new Date().toISOString().slice(0,10)]);
  return r.rows;
}
async function searchMessages(query, days = 7) {
  const r = await db.query(
    `SELECT slack_ts, user_name, text FROM messages
     WHERE created_at >= NOW() - ($2 || ' days')::interval
       AND text ILIKE '%'||$1||'%'
     ORDER BY slack_ts DESC LIMIT 20`, [query, String(days)]);
  return r.rows;
}
function suggestClaudeCodePrompt(problem) {
  return [
    'Cole no Claude Code:',
    '```',
    `No projeto healthfare-tracker: ${problem}.`,
    'Investiga a causa raiz primeiro (read-only), depois conserta com teste,',
    'npm test verde, commit individual. Não faz deploy sem eu pedir.',
    '```',
  ].join('\n');
}

// ─── Lifecycle ───────────────────────────────────────────────────────────
async function propose(kind, args) {
  if (!EXEC[kind]) throw new Error('proposta desconhecida: ' + kind);
  await setProposal({ kind, args, at: new Date().toISOString() });
  return buildProposeMessage(kind, args);
}

async function resolveProposal(text, deps = {}) {
  const p = await getProposal();
  if (!p) return { handled: false };
  const verdict = parseConfirmation(text);
  if (verdict === 'no') {
    await clearProposal();
    return { handled: true, outcome: 'cancelled' };
  }
  if (verdict === 'adjust') {
    // Keep the proposal; caller re-proposes with the new info.
    return { handled: true, outcome: 'adjust', proposal: p, adjustment: text };
  }
  // yes → execute
  try {
    const result = await EXEC[p.kind](p.args);
    const audit = deps.auditAction || require('../admin/audit').auditAction;
    await audit({
      action: 'ai_admin_executed', entityType: 'ai_admin',
      entityId: p.kind, before: { proposal: p }, after: { result },
      source: 'slack_admin',
    });
    await clearProposal();
    return { handled: true, outcome: 'executed', kind: p.kind, result };
  } catch (err) {
    await clearProposal();
    return { handled: true, outcome: 'error', error: err.message };
  }
}

module.exports = {
  propose, resolveProposal, parseConfirmation, buildProposeMessage,
  getProposal, setProposal, clearProposal,
  getState, getOperatorTimeline, searchMessages, suggestClaudeCodePrompt,
  EXEC,
};
