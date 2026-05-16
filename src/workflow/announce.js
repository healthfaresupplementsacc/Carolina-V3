'use strict';
/**
 * Entrega 3 Fase 8.2 — Admin-chat alerts for workflow rule events.
 *
 * ALL alerts go to the manager channel (C0B36DR5MP1) which is NEVER
 * silenced (silent mode only mutes the production channel). These are
 * heads-ups for the admin, not announcements to the floor.
 *
 * Rules surfaced:
 *   R1  soft prereq violated      → "Ana iniciou Empacotamento sem Imprimir ordens concluído"
 *   R3  duplicate batch detected  → "2 instâncias ativas pro mesmo Green Tea #0098"
 *   R4  ad-hoc task not in catalog → "Fulano iniciou 'limpando' não cadastrada — aprovar/mesclar/renomear?"
 *   E   batch number changed      → "Fulano mudou batch da phase #X — review necessário"
 *
 * Best-effort: a failed alert never blocks the originating action.
 */

const config = require('../config');

function slack() { return require('../slack/client'); }

async function toAdmin(text) {
  try {
    await slack().postToChannel(config.slack.managerChannelId, text);
  } catch (err) {
    console.error('[Announce] admin alert failed:', err.message);
  }
}

async function prereqWarning({ operatorName, phaseName, missing }) {
  if (!missing || missing.length === 0) return;
  await toAdmin(
    `⚠️ Pré-requisito: *${operatorName || 'alguém'}* iniciou *${phaseName}* sem ` +
    `concluir: ${missing.join(', ')}. Não bloqueei (soft) — confere se tá certo.`
  );
}

async function duplicateBatch({ productName, batchNumber, count }) {
  await toAdmin(
    `🔁 Duplicado: ${count} instâncias ativas pro mesmo ` +
    `*${productName}${batchNumber ? ' #' + batchNumber : ''}*. ` +
    `Quer que eu mescle? (responde no chat)`
  );
}

async function adHocPending({ operatorName, taskName }) {
  await toAdmin(
    `🆕 *${operatorName || 'alguém'}* iniciou a tarefa avulsa *"${taskName}"* ` +
    `que não está no catálogo. Opções: aprovar / mesclar com existente / renomear. ` +
    `(página /admin → Tarefas avulsas, ou me pede aqui)`
  );
}

async function batchChanged({ entityType, entityId, from, to, who }) {
  await toAdmin(
    `✏️ ${who || 'alguém'} mudou o batch da ${entityType} #${entityId} de ` +
    `${from || '(vazio)'} pra *${to || '(vazio)'}* — review necessário ` +
    `(badge ⏳ no dashboard até aprovar).`
  );
}

// F3 — note announcement to the production channel. 20 variations,
// random pick, no same-message-twice within a process tick. While
// silent_text is ON, slack.postMessage() suppresses → silent_log;
// we ALSO ping admin so a note is never silently lost.
const NOTE_VARIATIONS = [
  (op, t) => `📝 ${op} anotou: ${t}`,
  (op, t) => `📝 anotação de ${op}: ${t}`,
  (op, t) => `📝 ${op} deixou registrado: ${t}`,
  (op, t) => `📝 observação do ${op}: ${t}`,
  (op, t) => `📝 ${op} apontou aqui: ${t}`,
  (op, t) => `📝 nota do ${op} — ${t}`,
  (op, t) => `📝 ${op} quis registrar: ${t}`,
  (op, t) => `📝 fica anotado (${op}): ${t}`,
  (op, t) => `📝 ${op} mandou anotar: ${t}`,
  (op, t) => `📝 registrando o que ${op} falou: ${t}`,
  (op, t) => `📝 ${op} avisou: ${t}`,
  (op, t) => `📝 anotei pro ${op}: ${t}`,
  (op, t) => `📝 ${op} deixou recado: ${t}`,
  (op, t) => `📝 ó, ${op} anotou: ${t}`,
  (op, t) => `📝 ${op} pediu pra registrar: ${t}`,
  (op, t) => `📝 nota rápida do ${op}: ${t}`,
  (op, t) => `📝 ${op} reportou: ${t}`,
  (op, t) => `📝 anotação na conta do ${op}: ${t}`,
  (op, t) => `📝 ${op} sinalizou: ${t}`,
  (op, t) => `📝 guardando aqui (${op}): ${t}`,
];
let _lastNoteIdx = -1;
async function note({ operatorName, text }) {
  const op = operatorName || 'alguém';
  const t = String(text || '').trim();
  let idx = Math.floor(Math.random() * NOTE_VARIATIONS.length);
  if (idx === _lastNoteIdx) idx = (idx + 1) % NOTE_VARIATIONS.length;
  _lastNoteIdx = idx;
  const msg = NOTE_VARIATIONS[idx](op, t);
  // postMessage self-suppresses to silent_log when silent_text is on.
  try { await slack().postMessage(msg); } catch (e) { /* non-fatal */ }
  // Mirror to admin so the note is visible even while muted.
  await toAdmin(`📝 Nota de *${op}*: ${t}`);
}

module.exports = { toAdmin, prereqWarning, duplicateBatch, adHocPending, batchChanged, note };
