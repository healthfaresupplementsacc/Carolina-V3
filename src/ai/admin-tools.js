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
// BUG TZ — every timestamp Carolina sees must already be in ET
// ("YYYY-MM-DD HH:MM"), never a raw UTC ISO string (she was converting
// those to UTC/Brasília and reporting the wrong hour).
function _etStr(ts) {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 16);
  } catch (_) { return null; }
}

// BUG TZ-NAME — Carolina was answering "que horas a Simone marcou o break"
// with Vitor's times: get_operator_timeline only took an integer id and
// there was NO name→id path, so she inferred from aggregate lists. This
// resolves a NAME (or numeric id) to a single operator_id by exact name
// or alias (active preferred), so the per-operator SQL filter actually
// gets the right operator. Numeric input short-circuits (no DB hit).
async function resolveOperatorId(ref) {
  if (ref == null || ref === '') return null;
  if (typeof ref === 'number') return Number.isFinite(ref) ? ref : null;
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const r = await db.query(
    `SELECT id, name FROM operators
     WHERE LOWER(name) = LOWER($1)
        OR EXISTS (
          SELECT 1 FROM regexp_split_to_table(LOWER(COALESCE(aliases,'')), '\\s*,\\s*') a
          WHERE a <> '' AND a = LOWER($1)
        )
     ORDER BY active DESC, (LOWER(name) = LOWER($1)) DESC, id ASC
     LIMIT 1`, [s]);
  return r.rows[0] ? r.rows[0].id : null;
}

// BUG IDENTIDADE — resolve a name/id to { id, name, role } so callers
// know who outranks whom (owners/manager give orders Carolina obeys).
async function resolveOperator(ref) {
  if (ref == null || ref === '') return null;
  const s = String(ref).trim();
  const byId = typeof ref === 'number' || /^\d+$/.test(s);
  const r = await db.query(
    byId
      ? `SELECT id, name, COALESCE(role,'operator') AS role FROM operators WHERE id = $1 LIMIT 1`
      : `SELECT id, name, COALESCE(role,'operator') AS role FROM operators
         WHERE LOWER(name) = LOWER($1)
            OR EXISTS (
              SELECT 1 FROM regexp_split_to_table(LOWER(COALESCE(aliases,'')), '\\s*,\\s*') a
              WHERE a <> '' AND a = LOWER($1)
            )
         ORDER BY active DESC, (LOWER(name) = LOWER($1)) DESC, id ASC LIMIT 1`,
    [byId ? parseInt(s, 10) : s]);
  return r.rows[0] || null;
}
async function getOperatorRole(ref) {
  const op = await resolveOperator(ref);
  return op ? op.role : null;
}

// Returns counts AND the actual open entities (id + name) so the
// agentic loop can resolve references like "fecha o que está aberto"
// without asking the admin for an id when there's exactly one match.
async function getState() {
  const [wf, ph, ah, br, phList, ahList, wfList, brkList] = await Promise.all([
    db.query(`SELECT count(*)::int n FROM workflow_instances WHERE status='active'`),
    db.query(`SELECT count(*)::int n FROM phase_instances WHERE status='open'`),
    db.query(`SELECT count(*)::int n FROM ad_hoc_task_instances WHERE status='open'`),
    db.query(`SELECT count(*)::int n FROM operator_activity_log WHERE activity_type='break' AND ended_at IS NULL`),
    db.query(`SELECT id, phase_name, workflow_instance_id, started_at
              FROM phase_instances WHERE status='open' ORDER BY started_at ASC LIMIT 25`),
    db.query(`SELECT id, task_name, started_at
              FROM ad_hoc_task_instances WHERE status='open' ORDER BY started_at ASC LIMIT 25`),
    db.query(`SELECT id, product_name, batch_number
              FROM workflow_instances WHERE status='active' ORDER BY started_at ASC LIMIT 25`),
    // BUG TZ-NAME — expose WHO is on break (name + ET start), not just a
    // count, so "quem tá em break / break da Simone" is answerable and a
    // duplicated row (Vitor 2x) is visible instead of silently mixed in.
    db.query(`SELECT o.name AS operator, oal.started_at
              FROM operator_activity_log oal JOIN operators o ON o.id = oal.operator_id
              WHERE oal.activity_type='break' AND oal.ended_at IS NULL
              ORDER BY oal.started_at ASC LIMIT 25`),
  ]);
  const etRows = (rows) => rows.map((r) => (
    'started_at' in r ? { ...r, started_at: _etStr(r.started_at), tz: 'ET' } : r));
  return {
    active_workflows: wf.rows[0].n, open_phases: ph.rows[0].n,
    open_adhoc: ah.rows[0].n, on_break: br.rows[0].n,
    phases: etRows(phList.rows), adhoc: etRows(ahList.rows), workflows: wfList.rows,
    breaks: etRows(brkList.rows),
    timezone: 'America/New_York (ET)',
  };
}
// Accepts a NAME ("Simone") or a numeric id. Resolves to one operator
// and returns ONLY that operator's entries (the SQL filters by the
// resolved operator_id; every row is tagged with the operator name so
// the answer can never be attributed to the wrong person).
async function getOperatorTimeline(operatorRef, date) {
  const operatorId = await resolveOperatorId(operatorRef);
  if (!operatorId) return [];
  const r = await db.query(
    `SELECT oal.activity_type, oal.started_at, oal.ended_at, pi.phase_name,
            o.name AS operator,
            (COALESCE(oal.duration_seconds,
                      EXTRACT(EPOCH FROM (NOW() - oal.started_at)))::int / 60) AS duration_minutes
     FROM operator_activity_log oal
     JOIN operators o ON o.id = oal.operator_id
     LEFT JOIN phase_instances pi ON pi.id = oal.phase_instance_id
     WHERE oal.operator_id = $1
       AND (oal.started_at AT TIME ZONE 'America/New_York')::date = $2::date
     ORDER BY oal.started_at ASC`, [operatorId, date || new Date().toISOString().slice(0,10)]);
  return r.rows.map((x) => {
    const mins = Math.max(0, parseInt(x.duration_minutes, 10) || 0);
    // BUG TIMES — flag impossible break lengths (forgotten "Voltei").
    const suspicious = x.activity_type === 'break' && mins > SUSPICIOUS_BREAK_MIN;
    return {
      activity_type: x.activity_type, phase_name: x.phase_name, operator: x.operator,
      started_at: _etStr(x.started_at), ended_at: _etStr(x.ended_at),
      duration_minutes: mins, duration_suspicious: suspicious, tz: 'ET',
    };
  });
}
// BUG TIMES — breaks of 3-5h are physically impossible: the operator
// forgot to mark "Voltei". A break longer than this is flagged so
// Carolina calls it out instead of reciting it as fact.
const SUSPICIOUS_BREAK_MIN = 90;

// Today's breaks (every operator), each with ET start/end, duration in
// minutes and duration_suspicious when it ran longer than 90 min (open
// breaks count elapsed time so a forgotten "Voltei" still trips it).
async function getBreaksToday(date) {
  const d = date || new Date().toISOString().slice(0, 10);
  const r = await db.query(
    `SELECT o.name AS operator, oal.started_at, oal.ended_at,
            (COALESCE(oal.duration_seconds,
                      EXTRACT(EPOCH FROM (NOW() - oal.started_at)))::int / 60) AS duration_minutes
     FROM operator_activity_log oal
     JOIN operators o ON o.id = oal.operator_id
     WHERE oal.activity_type = 'break'
       AND (oal.started_at AT TIME ZONE 'America/New_York')::date = $1::date
     ORDER BY oal.started_at ASC`, [d]);
  const breaks = r.rows.map((x) => {
    const mins = Math.max(0, parseInt(x.duration_minutes, 10) || 0);
    return {
      operator: x.operator,
      started_at: _etStr(x.started_at),
      ended_at: _etStr(x.ended_at),
      ongoing: !x.ended_at,
      duration_minutes: mins,
      duration_suspicious: mins > SUSPICIOUS_BREAK_MIN,
      tz: 'ET',
    };
  });
  const suspicious = breaks.filter((b) => b.duration_suspicious);
  return {
    date: d, tz: 'ET', breaks,
    suspicious_count: suspicious.length,
    has_suspicious: suspicious.length > 0,
    suspicious_threshold_min: SUSPICIOUS_BREAK_MIN,
    note: suspicious.length
      ? 'Há break(s) com duração impossível (>90min) — provável "Voltei" esquecido. AVISE o admin e ofereça corrigir o horário ou descartar a entry.'
      : undefined,
  };
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

// BUG MENSAGEM — Carolina kept saying "não escrevi nada, só consigo ler
// lá". She CAN post (greeting/EOD/announcements all go through
// client.postMessage). This tool wires that capability to the admin's
// order. silent_text is honoured by client.postMessage itself (logs to
// silent_log + returns a 'silent-'/'toggled-' marker) so we just report
// which happened. The message is posted verbatim — persona stays human,
// it never reveals an admin asked for it.
async function postToProductionChannel(args = {}, deps = {}) {
  const text = String(args.message_text || args.text || '').trim();
  if (!text) return { posted: false, error: 'mensagem vazia' };
  const channelType = args.channel_type === 'orders_inventory'
    ? 'orders_inventory' : 'production';
  const client = deps.slackClient || require('../slack/client');
  // Only the production (floor) channel exists for operators; an
  // orders/inventory channel isn't configured, so it routes there too.
  const ts = await client.postMessage(text, null, null);
  const silent = typeof ts === 'string'
    && (ts.startsWith('silent-') || ts.startsWith('toggled-'));
  const audit = deps.auditAction || require('../admin/audit').auditAction;
  await audit({
    action: 'ai_admin_posted_to_channel', entityType: 'slack_channel',
    entityId: channelType, source: deps.source || 'slack_admin',
    before: { channel_type: channelType, triggered_by: deps.triggeredBy || 'slack_admin_order' },
    after: { silent, ts: silent ? null : ts, text },
  });
  return {
    posted: !silent, silent, channel: channelType,
    confirmation: silent
      ? 'Mandei (modo silencioso, foi pro log).'
      : 'Mandei lá.',
  };
}

// BUG REBELLION (Part A) — Carolina claimed she had no tool to close a
// break. She does now: this reuses engine.endBreak (the canonical path
// that closes the oal break + linked pause + opens idle), looping so
// duplicate open break rows for the same operator all get closed.
async function _endAllOpenBreaks(operatorId, when, deps) {
  const engine = deps.engine || require('../workflow/engine');
  let closed = 0; let lastTs = null;
  for (let i = 0; i < 8; i++) {
    const chk = await db.query(
      `SELECT 1 FROM operator_activity_log
       WHERE operator_id = $1 AND ended_at IS NULL AND activity_type = 'break' LIMIT 1`,
      [operatorId]);
    if (!chk.rows.length) break;
    await engine.endBreak({ operatorId, when: when || null });
    closed++;
    lastTs = when || new Date().toISOString();
  }
  return { closed, lastTs };
}
async function closeActiveBreak(args = {}, deps = {}) {
  const ref = args.operator != null && args.operator !== ''
    ? args.operator : args.operator_id;
  const op = await resolveOperator(ref);
  if (!op) return { closed: false, found: false, error: 'operador não encontrado — confirme o nome' };
  const { closed, lastTs } = await _endAllOpenBreaks(op.id, args.ended_at, deps);
  if (deps._skipAudit !== true) {
    const audit = deps.auditAction || require('../admin/audit').auditAction;
    await audit({
      action: 'ai_admin_closed_break', entityType: 'operator_activity_log',
      entityId: op.id, source: deps.source || 'slack_admin',
      before: { operator: op.name, triggered_by: deps.triggeredBy || 'slack_admin_order' },
      after: { closed_count: closed, ended_at: lastTs },
    });
  }
  return {
    closed: closed > 0, closed_count: closed, operator: op.name, ended_at: lastTs,
    note: closed === 0 ? 'esse operador não tinha break ativo' : undefined,
  };
}
async function closeAllActiveBreaks(args = {}, deps = {}) {
  const r = await db.query(
    `SELECT DISTINCT oal.operator_id, o.name AS operator
     FROM operator_activity_log oal JOIN operators o ON o.id = oal.operator_id
     WHERE oal.ended_at IS NULL AND oal.activity_type = 'break'`);
  const results = [];
  for (const row of r.rows) {
    const { closed } = await _endAllOpenBreaks(row.operator_id, args.ended_at, deps);
    if (closed > 0) results.push({ operator: row.operator, closed_count: closed });
  }
  const audit = deps.auditAction || require('../admin/audit').auditAction;
  await audit({
    action: 'ai_admin_closed_break', entityType: 'operator_activity_log',
    entityId: 'all', source: deps.source || 'slack_admin',
    before: { scope: 'all', triggered_by: deps.triggeredBy || 'slack_admin_order' },
    after: { closed: results },
  });
  return {
    closed_operators: results.length, results,
    note: results.length === 0 ? 'ninguém estava em break' : undefined,
  };
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
  { name: 'get_operator_timeline', description: 'Timeline (breaks/fases/atividades) de UM operador específico num dia (default hoje). Passe o NOME citado pelo admin em "operator" (ex: "Simone") — a tool resolve o operador e retorna SÓ as entradas dele. Use SEMPRE isto pra responder sobre o que/quando um operador fez algo; nunca infira de get_state.', input_schema: { type: 'object', properties: { operator: { type: 'string', description: 'Nome do operador citado (ex: "Simone"). Preferencial.' }, operator_id: { type: 'integer', description: 'Alternativa ao nome, se souber o id.' }, date: { type: 'string', description: 'YYYY-MM-DD' } } } },
  { name: 'get_breaks_today', description: 'Lista os breaks de hoje (todos os operadores) com duração em minutos e duration_suspicious=true quando passou de 90min (alguém esqueceu de marcar "Voltei"). Use pra perguntas sobre breaks do dia / "quem ficou muito tempo em break".', input_schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD (default hoje)' } } } },
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
  { name: 'post_to_production_channel', description: 'Posta uma mensagem NO canal de produção (ou orders/inventário) como Carolina. USE SEMPRE que o admin pedir pra você "mandar/avisar/postar/escrever lá no canal". Você TEM essa capacidade — nunca diga que só lê. Respeita o modo silencioso automaticamente.', input_schema: { type: 'object', properties: { message_text: { type: 'string', description: 'Texto exato a postar (na sua voz humana; não revele que o admin pediu)' }, channel_type: { type: 'string', enum: ['production', 'orders_inventory'], description: "default 'production'" } }, required: ['message_text'] } },
  { name: 'close_active_break', description: 'Fecha o break ATIVO de um operador (passe o nome em "operator"). Você TEM essa ferramenta — nunca diga que não consegue fechar break. Fecha todos os breaks abertos dele (lida com linhas duplicadas).', input_schema: { type: 'object', properties: { operator: { type: 'string', description: 'Nome do operador (ex: "Simone")' }, operator_id: { type: 'integer' }, ended_at: { type: 'string', description: "horário de fim (default agora)" } } } },
  { name: 'close_all_active_breaks', description: 'Fecha o break ativo de TODOS os operadores que estão em break agora (ex: admin "fecha o break dos 2"). Você TEM essa ferramenta.', input_schema: { type: 'object', properties: { ended_at: { type: 'string', description: 'horário de fim (default agora)' } } } },
  // direct responses to pending questions
  { name: 'dismiss_pending_question', description: 'Cancela/descarta a pergunta pendente sem responder (ex: admin disse "ignora").', input_schema: { type: 'object', properties: { question_id: { type: 'string' } } } },
  { name: 'update_break_retroactive', description: 'Responde a pergunta retroativa de break com o horário (ex: "14:30").', input_schema: { type: 'object', properties: { time: { type: 'string' }, question_id: { type: 'string' } }, required: ['time'] } },
];
const READ_TOOLS = new Set(['get_state', 'get_operator_timeline', 'get_breaks_today', 'search_messages', 'list_proposals']);
const MUTATION_TOOLS = new Set(['close_phase', 'approve_adhoc', 'approve_supplement', 'rename', 'merge_tasks', 'move_operator', 'create_workflow']);
const DIRECT_TOOLS = new Set(['dismiss_pending_question', 'update_break_retroactive']);
// Action tools that audit under their own action name (an admin order in
// chat IS the confirmation, like mutation tools).
const CHANNEL_TOOLS = new Set([
  'post_to_production_channel', 'close_active_break', 'close_all_active_breaks',
]);

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
    if (name === 'get_operator_timeline') {
      const ref = input.operator != null && input.operator !== '' ? input.operator : input.operator_id;
      const operator_id = await resolveOperatorId(ref);
      const entries = operator_id ? await getOperatorTimeline(operator_id, input.date) : [];
      // Envelope self-identifies the operator so the answer can never be
      // attributed to the wrong person (BUG TZ-NAME).
      const suspicious = entries.filter((e) => e.duration_suspicious);
      return {
        operator: (entries[0] && entries[0].operator)
          || (typeof ref === 'string' ? ref : null),
        operator_id,
        date: input.date || new Date().toISOString().slice(0, 10),
        tz: 'ET',
        found: !!operator_id,
        has_suspicious: suspicious.length > 0, // BUG TIMES
        suspicious_count: suspicious.length,
        note: !operator_id
          ? 'operador não encontrado pelo nome — confirme o nome com o admin'
          : (suspicious.length
            ? 'Há break(s) com duração impossível (>90min) — provável "Voltei" esquecido. AVISE o admin e ofereça corrigir o horário ou descartar a entry.'
            : undefined),
        entries,
      };
    }
    if (name === 'get_breaks_today') return getBreaksToday(input.date);
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
  if (CHANNEL_TOOLS.has(name)) {
    // Admin's order = confirmation. The cron/autonomous path must never
    // post on its own → it passes allowMutations:false.
    if (deps.allowMutations === false) {
      throw new Error('postar no canal requer ordem explícita do admin');
    }
    if (name === 'post_to_production_channel') return postToProductionChannel(input, deps);
    if (name === 'close_active_break') return closeActiveBreak(input, deps);
    if (name === 'close_all_active_breaks') return closeAllActiveBreaks(input, deps);
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
// Strip a leading vocative so "Carolina, ignora" / "ó Carol, fecha essa"
// match the same as a bare "ignora" / "fecha essa".
function stripVocative(text) {
  let t = String(text || '').trim().toLowerCase();
  t = t.replace(/^[\s,.:!¡-]+/, '');
  t = t.replace(/^(?:[óôoái]+|ei|oi|opa|hey|e?a[ií])\s+/i, '');
  t = t.replace(/^(?:carol(?:ina)?|caro|bot|ô?\s*carol)[\s,.:!-]*/i, '');
  t = t.replace(/^(?:por\s+favor|pf|faz\s+favor|pfv)[\s,]*/i, '');
  return t.trim();
}

/**
 * True when the message is a "drop the pending question" intent.
 *  - explicit dismiss words: ignora/ignore, esquece(/isso), deleta(/a
 *    pergunta), cancela(/essa/isso), descarta, deixa(/pra lá/quieto/isso),
 *    para com isso / para, não precisa
 *  - close-words (fecha/encerra/termina) ONLY when target-less
 *    ("fecha", "fecha essa", "fecha isso", "encerra") — "fecha a fase #5"
 *    has an explicit target → real order, NOT a dismiss.
 */
function detectDismissIntent(text) {
  const t = stripVocative(text);
  if (!t) return false;
  if (/^(ignora|ignore|esquece|esque[çc]a|esquece\s+isso|deleta(\s+(isso|essa|a\s+pergunta))?|cancela(\s+(essa|isso))?|descarta|n[ãa]o\s+precisa|deixa(\s+(pra|para)\s+l[áa]|\s+quieto|\s+isso|\s+disso|\s+quieta)?|para\s+com\s+isso|para)\b/.test(t)) {
    return true;
  }
  if (/^(fecha|fechar|encerra|encerrar|termina|terminar)(\s+(essa|isso|essa\s+pergunta|isso\s+a[ií]|a[ií]))?\s*[.!?]*$/.test(t)) {
    return true;
  }
  return false;
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
  getState, getOperatorTimeline, resolveOperatorId, resolveOperator, getOperatorRole, getBreaksToday,
  SUSPICIOUS_BREAK_MIN, searchMessages, suggestClaudeCodePrompt,
  EXEC,
  dismissPendingQuestion, updateBreakRetroactive, postToProductionChannel,
  closeActiveBreak, closeAllActiveBreaks,
  TOOL_DEFS, READ_TOOLS, MUTATION_TOOLS, DIRECT_TOOLS, CHANNEL_TOOLS, runTool,
  detectDismissIntent, stripVocative, pendingSummary, pendingContextLine, interpretDirectOrder,
};
