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

// ─── BLOCO C / P1 — new direct tools (responses to pending questions) ────
// These are NOT propose-then-confirm: they cancel/answer something the
// admin is being asked about, so an explicit admin order is itself the
// confirmation. Both audited.
async function dismissPendingQuestion(args = {}, deps = {}) {
  const dismissed = [];
  // 1. retro-break admin question (A1)
  const rb = await db.query(`SELECT value FROM app_state WHERE key = 'retro_break_admin'`);
  if (rb.rows[0]) {
    await db.query(`DELETE FROM app_state WHERE key = 'retro_break_admin'`);
    dismissed.push('retro_break_admin');
  }
  // 2. W6 single proposal
  const w6 = await getProposal();
  if (w6) { await clearProposal(); dismissed.push('w6_proposal:' + w6.kind); }
  // 3. latest carolina_proposals pending → rejected
  try {
    const proposals = require('./proposals');
    const r = await proposals.resolveLatest('rejected', 'slack_admin');
    if (r) dismissed.push('proposal#' + r.id);
  } catch (_) { /* table may not exist in some tests */ }
  const audit = deps.auditAction || require('../admin/audit').auditAction;
  await audit({
    action: 'ai_admin_executed', entityType: 'ai_admin',
    entityId: 'dismiss_pending_question', source: 'slack_admin',
    before: { question_id: args.question_id || null, triggered_by: deps.triggeredBy || 'slack_admin_order' },
    after: { dismissed },
  });
  return { dismissed };
}

async function updateBreakRetroactive(args = {}, deps = {}) {
  const time = String(args.time || args.question_id || '').trim();
  const btr = require('../workflow/break-time-reply');
  const r = await btr.handleAdminRetroReply(time, deps);
  const audit = deps.auditAction || require('../admin/audit').auditAction;
  await audit({
    action: 'ai_admin_executed', entityType: 'ai_admin',
    entityId: 'update_break_retroactive', source: 'slack_admin',
    before: { time, triggered_by: deps.triggeredBy || 'slack_admin_order' },
    after: { outcome: r.outcome || (r.handled ? 'handled' : 'no_pending') },
  });
  return r;
}

// ─── Tool schemas (DETERMINISTIC order — keep stable for prompt cache) ───
const TOOL_DEFS = [
  // read (execute freely)
  { name: 'get_state', description: 'Estado atual: contagem de workflows ativos, fases abertas, ad-hoc abertos, pessoas em break.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_operator_timeline', description: 'Timeline de atividades de um operador num dia (default hoje).', input_schema: { type: 'object', properties: { operator_id: { type: 'integer' }, date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['operator_id'] } },
  { name: 'search_messages', description: 'Busca mensagens recentes do canal de produção por texto.', input_schema: { type: 'object', properties: { query: { type: 'string' }, days: { type: 'integer' } }, required: ['query'] } },
  { name: 'list_proposals', description: 'Lista as propostas da Carolina aguardando resposta do admin.', input_schema: { type: 'object', properties: {} } },
  // mutation (admin order in chat = explicit confirmation → execute + audit)
  { name: 'close_phase', description: 'Fecha uma fase aberta pelo id.', input_schema: { type: 'object', properties: { phase_instance_id: { type: 'integer' }, bottle_count: { type: 'integer' } }, required: ['phase_instance_id'] } },
  { name: 'approve_adhoc', description: 'Aprova uma tarefa avulsa pendente.', input_schema: { type: 'object', properties: { adhoc_task_id: { type: 'integer' } }, required: ['adhoc_task_id'] } },
  { name: 'approve_supplement', description: 'Aprova um suplemento pendente no catálogo.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'rename', description: 'Renomeia uma entidade (workflow_template|phase_template|ad_hoc_task).', input_schema: { type: 'object', properties: { entity_type: { type: 'string' }, id: { type: 'integer' }, new_name: { type: 'string' } }, required: ['entity_type', 'id', 'new_name'] } },
  { name: 'merge_tasks', description: 'Mescla tarefas duplicadas.', input_schema: { type: 'object', properties: { task_ids: { type: 'array', items: { type: 'integer' } } }, required: ['task_ids'] } },
  { name: 'move_operator', description: 'Move um operador para outra atividade.', input_schema: { type: 'object', properties: { operator_id: { type: 'integer' }, target_phase_instance_id: { type: 'integer' }, target_ad_hoc_task_instance_id: { type: 'integer' } }, required: ['operator_id'] } },
  { name: 'create_workflow', description: 'Cria um workflow novo com fases.', input_schema: { type: 'object', properties: { name: { type: 'string' }, phases: { type: 'array', items: { type: 'string' } } }, required: ['name'] } },
  // direct responses to pending questions
  { name: 'dismiss_pending_question', description: 'Cancela/descarta a pergunta pendente sem responder (ex: admin disse "ignora").', input_schema: { type: 'object', properties: { question_id: { type: 'string' } } } },
  { name: 'update_break_retroactive', description: 'Responde a pergunta retroativa de break com o horário (ex: "14:30").', input_schema: { type: 'object', properties: { time: { type: 'string' }, question_id: { type: 'string' } }, required: ['time'] } },
];
const READ_TOOLS = new Set(['get_state', 'get_operator_timeline', 'search_messages', 'list_proposals']);
const MUTATION_TOOLS = new Set(['close_phase', 'approve_adhoc', 'approve_supplement', 'rename', 'merge_tasks', 'move_operator', 'create_workflow']);
const DIRECT_TOOLS = new Set(['dismiss_pending_question', 'update_break_retroactive']);

/**
 * Execute one tool call from the agentic loop.
 *  - read tools: run freely, no audit.
 *  - mutation tools: an admin order in chat IS the explicit confirmation
 *    (Part 5) → execute via the audited EXEC, audit ai_admin_executed.
 *  - direct tools: dismiss / retro-break, audited inside.
 * Returns a JSON-serialisable result for the tool_result block.
 */
async function runTool(name, input = {}, deps = {}) {
  if (READ_TOOLS.has(name)) {
    if (name === 'get_state') return getState();
    if (name === 'get_operator_timeline') return getOperatorTimeline(input.operator_id, input.date);
    if (name === 'search_messages') return searchMessages(input.query, input.days || 7);
    if (name === 'list_proposals') {
      try { return { pending: await require('./proposals').listPending() }; }
      catch (_) { return { pending: [] }; }
    }
  }
  if (DIRECT_TOOLS.has(name)) {
    if (name === 'dismiss_pending_question') return dismissPendingQuestion(input, deps);
    if (name === 'update_break_retroactive') return updateBreakRetroactive(input, deps);
  }
  if (MUTATION_TOOLS.has(name)) {
    if (!EXEC[name]) throw new Error('mutation tool sem executor: ' + name);
    // P5 GUARDRAIL — mutation tools execute ONLY with explicit
    // confirmation. In the admin-chat loop the admin's order IS the
    // confirmation (allowMutations defaults to true there). Any caller
    // without confirmation (autonomous/cron) must pass
    // allowMutations:false → the cron NEVER runs mutations directly,
    // it proposes (P3) and waits for the admin's "sim".
    if (deps.allowMutations === false) {
      throw new Error('mutação requer confirmação explícita do admin (use propose → sim)');
    }
    const triggered_by = deps.triggeredBy || 'slack_admin_order';
    const result = await EXEC[name](input);
    const audit = deps.auditAction || require('../admin/audit').auditAction;
    await audit({
      action: 'ai_admin_executed', entityType: 'ai_admin',
      entityId: name, source: deps.source || 'slack_admin',
      before: { tool: name, input, triggered_by }, after: { result },
    });
    return result;
  }
  throw new Error('tool desconhecida: ' + name);
}

// ─── BLOCO C / P2 — natural-language direct-order interpretation ─────────
// A cheap, deterministic pre-parse that runs BEFORE the LLM loop for the
// highest-confidence intent: "ignora / esquece / deixa pra lá" when a
// question is pending → dismiss. Everything richer ("fecha a fase #5",
// "renomeia #10 pra X", "mostra timeline da Ana") is left to the P1
// tool-use loop, whose system prompt already carries the routing +
// ambiguity rules.
function detectDismissIntent(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  return /^(ignora|ignore|esquece|esque[çc]a|deixa(\s+(pra|para)\s+l[áa]|\s+quieto|\s+isso)?|para\s+com\s+isso|cancela\s+(essa|isso)|descarta|n[ãa]o\s+precisa|deleta\s+(isso|essa|a\s+pergunta))\b/.test(t);
}

/** What is Carolina currently waiting on an answer for? */
async function pendingSummary() {
  const parts = [];
  try {
    const rb = await db.query(`SELECT value FROM app_state WHERE key = 'retro_break_admin'`);
    if (rb.rows[0]) parts.push('pergunta de horário de break retroativo');
  } catch (_) {}
  const w6 = await getProposal();
  if (w6) parts.push(`proposta "${w6.kind}" aguardando sim/não`);
  try {
    const proposals = require('./proposals');
    const list = await proposals.listPending();
    if (list.length) parts.push(`${list.length} proposta(s) da Carolina pendente(s)`);
  } catch (_) {}
  return { hasAny: parts.length > 0, parts };
}

/** One context line for the LLM so it knows there IS something pending. */
async function pendingContextLine() {
  const ps = await pendingSummary();
  if (!ps.hasAny) return 'PENDÊNCIAS: nenhuma pergunta aguardando resposta.';
  return 'PENDÊNCIAS (a Carolina está esperando o admin sobre): ' + ps.parts.join('; ') + '.';
}

/**
 * Returns { handled:true, reply } when a deterministic dismiss applies,
 * otherwise { handled:false } (caller falls through to the LLM loop).
 */
async function interpretDirectOrder(text, deps = {}) {
  if (!detectDismissIntent(text)) return { handled: false };
  const ps = await pendingSummary();
  if (!ps.hasAny) return { handled: false };
  const res = await dismissPendingQuestion({ question_id: 'nl_dismiss' }, deps);
  const what = res.dismissed && res.dismissed.length
    ? ` (${res.dismissed.join(', ')})` : '';
  return { handled: true, reply: `Tá certo, descartei${what}.` };
}

module.exports = {
  propose, resolveProposal, parseConfirmation, buildProposeMessage,
  getProposal, setProposal, clearProposal,
  getState, getOperatorTimeline, searchMessages, suggestClaudeCodePrompt,
  EXEC,
  dismissPendingQuestion, updateBreakRetroactive,
  TOOL_DEFS, READ_TOOLS, MUTATION_TOOLS, DIRECT_TOOLS, runTool,
  detectDismissIntent, pendingSummary, pendingContextLine, interpretDirectOrder,
};
