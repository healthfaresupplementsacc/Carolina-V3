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
const msgVar = require('../message-variations');

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

// F3 — note announcement to the production channel. Variations now live
// in message_variations (type 'note'); resolveTemplates falls back to
// the code defaults if the table is empty. While silent_text is ON,
// slack.postMessage() suppresses → silent_log; we ALSO ping admin so a
// note is never silently lost.
async function note({ operatorName, text }) {
  const op = operatorName || 'alguém';
  const t = String(text || '').trim();
  const msg = await msgVar.pick('note', { op, texto: t });
  // postMessage self-suppresses to silent_log when silent_text is on.
  try { await slack().postMessage(msg); } catch (e) { /* non-fatal */ }
  // Mirror to admin so the note is visible even while muted.
  await toAdmin(`📝 Nota de *${op}*: ${t}`);
}

// F6 — operator clicked "Voltei" with no open break. Variations live in
// message_variations (type 'voltei'), fallback to code defaults. The
// 'break' msgType makes the C4 toggle apply. postMessage self-suppresses
// to silent_log while silent_text=ON; we also tell admin it was
// suppressed so they can fix the time by hand.
async function voltaSemBreak({ operatorName }) {
  const n = operatorName || 'oi';
  const msg = await msgVar.pick('voltei', { nome: n });
  try { await slack().postMessage(msg, null, 'break'); } catch (e) { /* non-fatal */ }
  await toAdmin(
    `↩️ *${n}* clicou "Voltei" mas não havia break aberto. Criei um break ` +
    `não-rastreado (horário a confirmar). A pergunta do horário foi pro ` +
    `canal (suprimida se silent_text=ON) — edita manualmente se quiser.`
  );
}

// B4 — retry when the break-time answer wasn't a valid time. Variations
// live in message_variations (type 'break_time_retry'), code fallback.
async function breakTimeRetry({ operatorName }) {
  const n = operatorName || 'oi';
  const msg = await msgVar.pick('break_time_retry', { nome: n });
  try { await slack().postMessage(msg); } catch (e) { /* non-fatal */ }
}
async function breakTimeGaveUp({ operatorName }) {
  const n = operatorName || 'alguém';
  await toAdmin(
    `⚠️ Não consegui recuperar o horário do break de *${n}* (2 tentativas ` +
    `falhadas). Marquei started_at=NULL / '[horário não recuperado]'. ` +
    `Edita manualmente no /operator se quiser.`
  );
}

// A1 — ask the ADMIN (not the silenced prod channel) for the missing
// break start time. Admin's time reply → retroactive break.
async function voltaSemBreakAdmin({ operatorName }) {
  const n = operatorName || 'alguém';
  await toAdmin(
    `↩️ *${n}* voltou agora, mas não tinha break aberto. Quando ele(a) saiu? ` +
    `Me diz o horário (ex: 14:30) que eu registro o break retroativo ` +
    `(started_at = horário, ended_at = agora). Ou "ignora" pra deixar como está.`
  );
}
async function retroBreakDone({ operatorName, when }) {
  await toAdmin(`✅ Break retroativo de *${operatorName || 'operador'}* registrado: ` +
    `saiu ${when}, voltou agora. (action=break.retroactive_create)`);
}

// Bug 3 — operator answered the "que horas vc saiu?" question in the
// PRODUCTION channel. Confirm to them (human persona, never AI). The
// channel post self-suppresses to silent_log when silent_text=ON;
// regardless, the admin chat (never silenced) always gets the update —
// so with silent_text=true the confirmation lands in the admin chat.
async function breakTimeResolved({ operatorName, when }) {
  const n = operatorName || 'você';
  const hm = /\d{1,2}:\d{2}/.test(String(when || '')) ? String(when).match(/\d{1,2}:\d{2}/)[0] : when;
  try { await slack().postMessage(`anotei aqui, ${n}: você saiu ${hm}, voltou agora ✅`); } catch (e) { /* non-fatal */ }
  await toAdmin(`✅ Atualizei o break de *${n}* retroativo pra ${hm} (resposta no canal de produção).`);
}

module.exports = {
  toAdmin, prereqWarning, duplicateBatch, adHocPending, batchChanged,
  note, voltaSemBreak, breakTimeRetry, breakTimeGaveUp,
  voltaSemBreakAdmin, retroBreakDone, breakTimeResolved,
};
