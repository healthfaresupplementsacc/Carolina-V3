'use strict';
/**
 * FASE 1 P6 — Carolina's disambiguation channel.
 *
 * Decision (docs/decisions/fase0-carolina-admin-chat.md):
 *   - silent_text silences cosmetic ANNOUNCEMENTS in the production
 *     channel (greeting, EOD, "fulano iniciou X"…).
 *   - It does NOT silence DISAMBIGUATION questions — those are needed to
 *     persist data correctly. They go ALWAYS to the admin chat
 *     (managerChannelId), which client.postToChannel already exempts
 *     from silent_text (isAdminChannel).
 *
 * "No reaction without record": when an event is ambiguous the dispatcher
 * does NOT create an ISA-88 row, so Carolina must NOT pretend it's done
 * (no ✅) — instead she asks here, and the parked pending_disambiguation
 * row is resolved when the admin answers (the event is re-dispatched WITH
 * the operator, finally creating the real row).
 */

const config = require('../config');

function _etTime(iso) {
  try {
    return new Date(iso).toLocaleString('sv-SE', { timeZone: config.tz || 'America/New_York' }).slice(11, 16);
  } catch (_) { return '??:??'; }
}

/**
 * Post text to the admin chat (C0B36DR5MP1). ALWAYS goes through —
 * postToChannel exempts the admin channel from silent_text. Audited
 * carolina.admin_chat_question with the type.
 */
async function sendToAdminChat(text, type = 'disambiguation', deps = {}) {
  const client = deps.slackClient || require('./client');
  const auditAction = deps.auditAction || require('../admin/audit').auditAction;
  let ts = null;
  try {
    ts = await client.postToChannel(config.slack.managerChannelId, text);
  } catch (err) {
    console.error('[AdminChat] post failed:', err.message);
  }
  try {
    await auditAction({
      action: 'carolina.admin_chat_question',
      entityType: 'admin_chat',
      entityId: type,
      before: null,
      after: { type, text, ts },
      source: 'carolina',
    });
  } catch (_) { /* audit best-effort */ }
  return ts;
}

/**
 * Ask the admin who an ambiguous message belongs to. Wired from the
 * poller's canonical path on needsDisambiguation. Never posts to the
 * production channel, never gated by silent_text.
 */
async function askDisambiguation(event, msg, deps = {}) {
  const account = (msg && msg.user) || event?.metadata?.accountUserId || 'conta compartilhada';
  const hora = _etTime(event?.timestamp || (msg && msg.ts && new Date(parseFloat(msg.ts) * 1000).toISOString()));
  const texto = (event?.raw_text || (msg && msg.text) || '').toString().slice(0, 280);
  const question =
    `🔶 Mensagem ambígua de \`${account}\` às ${hora}: "${texto}". ` +
    `Quem foi? Responde com o nome (ex: "Ana", "Bruno Sarmento").`;
  return sendToAdminChat(question, 'disambiguation', deps);
}

/** Is there at least one unresolved disambiguation? (dashboard/Part 10) */
async function listPending(deps = {}) {
  const db = deps.db || require('../db');
  const r = await db.query(
    `SELECT source_id, source_type, event, account_user_id, created_at
       FROM pending_disambiguation WHERE status = 'pending'
       ORDER BY created_at ASC`
  );
  return r.rows.map((row) => ({
    ...row,
    event: typeof row.event === 'string' ? JSON.parse(row.event) : row.event,
  }));
}

/**
 * The admin answered in the admin chat with a name. Resolve it, re-run
 * the parked event WITH the operator (creating the real ISA-88 row),
 * mark the pending row resolved, audit operator.reassign_retroactive.
 *
 * Resolves the MOST RECENT pending row when several are open (the admin
 * is answering the question Carolina just asked). Returns
 * { handled:false } when nothing pending or the name didn't resolve, so
 * the caller falls through to the normal admin tool-use loop.
 */
async function resolveDisambiguationReply(text, deps = {}) {
  const db = deps.db || require('../db');
  const pend = await db.query(
    `SELECT source_id, source_type, event FROM pending_disambiguation
      WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`
  );
  if (!pend.rows[0]) return { handled: false, reason: 'no pending' };

  const adminTools = deps.adminTools || require('../ai/admin-tools');
  // Pull a name out of the reply ("foi a Ana", "Bruno Sarmento", "ana").
  const cleaned = String(text || '')
    .replace(/^(foi\s+(a|o)?\s*|quem\s+foi.*?:?\s*|era\s+(a|o)?\s*)/i, '')
    .trim();
  const op = await adminTools.resolveOperator(cleaned || text);
  if (!op || !op.id) return { handled: false, reason: 'name not resolved' };

  const row = pend.rows[0];
  const ev = typeof row.event === 'string' ? JSON.parse(row.event) : row.event;
  ev.operator_id = op.id;

  const canonical = deps.canonicalDispatcher || require('../dispatcher/canonical-dispatcher');
  const result = await canonical.safeDispatch(ev);

  await db.query(
    `UPDATE pending_disambiguation
        SET status = 'resolved', resolved_operator_id = $1, resolved_at = NOW()
      WHERE source_id = $2`,
    [op.id, row.source_id]
  );

  const auditAction = deps.auditAction || require('../admin/audit').auditAction;
  try {
    await auditAction({
      action: 'operator.reassign_retroactive',
      entityType: 'pending_disambiguation',
      entityId: row.source_id,
      before: { operator_id: null, source_id: row.source_id },
      after: { operator_id: op.id, operator: op.name, dispatch: result },
      source: 'slack_admin',
    });
  } catch (_) { /* best-effort */ }

  return {
    handled: true,
    operator: op.name,
    operator_id: op.id,
    source_id: row.source_id,
    dispatch: result,
    reply: `Fechado — atribuí pra ${op.name} e registrei.`,
  };
}

module.exports = {
  sendToAdminChat,
  askDisambiguation,
  resolveDisambiguationReply,
  listPending,
};
