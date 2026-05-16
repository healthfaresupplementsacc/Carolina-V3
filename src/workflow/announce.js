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

// F6 — operator clicked "Voltei" with no open break. 20 variations of
// the "what time did you actually leave?" question. postMessage
// self-suppresses to silent_log while silent_text=ON; we also tell
// admin it was suppressed so they can fix the time by hand.
const VOLTA_SEM_BREAK = [
  (n) => `${n}, vc voltou mas eu não vi vc sair — que horas vc saiu mesmo?`,
  (n) => `oi ${n}, não registrei sua saída. que horas vc parou pro break?`,
  (n) => `${n} que horas vc tinha saído? não peguei o início do break`,
  (n) => `${n}, cadê o horário que vc saiu? não vi vc ir`,
  (n) => `${n} me ajuda: que horas começou seu break? não tinha registro`,
  (n) => `ué ${n}, não vi vc sair. que horas foi?`,
  (n) => `${n}, faltou o início do seu break — que horas vc saiu?`,
  (n) => `${n} que horas vc saiu pro break? não tinha anotado`,
  (n) => `oi ${n}, voltou de onde? não registrei a saída — que horas foi?`,
  (n) => `${n}, me diz a que horas vc saiu que eu acerto aqui`,
  (n) => `${n} não peguei vc saindo. qual foi o horário do break?`,
  (n) => `${n}, que horas vc tinha parado? preciso pro registro`,
  (n) => `eita ${n}, sumiu e voltou — que horas vc saiu?`,
  (n) => `${n} qual horário vc saiu pro intervalo? não tinha aqui`,
  (n) => `${n}, sem registro da saída. me passa o horário que vc parou`,
  (n) => `${n} voltou! mas que horas vc tinha saído mesmo?`,
  (n) => `oi ${n}, que horas começou o break? não vi vc sair`,
  (n) => `${n}, preciso do horário que vc saiu — não foi registrado`,
  (n) => `${n} me fala que horas vc parou que eu ajusto`,
  (n) => `${n}, não vi vc saindo. a que horas foi o break?`,
];
let _lastVoltaIdx = -1;
async function voltaSemBreak({ operatorName }) {
  const n = operatorName || 'oi';
  let i = Math.floor(Math.random() * VOLTA_SEM_BREAK.length);
  if (i === _lastVoltaIdx) i = (i + 1) % VOLTA_SEM_BREAK.length;
  _lastVoltaIdx = i;
  try { await slack().postMessage(VOLTA_SEM_BREAK[i](n)); } catch (e) { /* non-fatal */ }
  await toAdmin(
    `↩️ *${n}* clicou "Voltei" mas não havia break aberto. Criei um break ` +
    `não-rastreado (horário a confirmar). A pergunta do horário foi pro ` +
    `canal (suprimida se silent_text=ON) — edita manualmente se quiser.`
  );
}

// B4 — retry when the break-time answer wasn't a valid time. 10 variations.
const BREAK_TIME_RETRY = [
  (n) => `${n}, não entendi 😅 tenta no formato HH:MM, tipo 14:30`,
  (n) => `${n} esse horário não deu pra ler — manda assim: 14:30`,
  (n) => `hmm ${n}, não consegui entender. que horas? ex: 13:05`,
  (n) => `${n}, me manda só o horário tipo 15:40`,
  (n) => `não peguei ${n} — formato HH:MM por favor (ex 14h30)`,
  (n) => `${n} tenta de novo: que horas vc saiu? tipo 12:15`,
  (n) => `${n}, preciso no formato hora:minuto, ex 16:00`,
  (n) => `não rolou ${n} 😬 manda o horário tipo 14:30`,
  (n) => `${n} qual horário mesmo? escreve assim: 09:45`,
  (n) => `${n}, só o horário por favor — exemplo: 17:20`,
];
let _lastRetryIdx = -1;
async function breakTimeRetry({ operatorName }) {
  const n = operatorName || 'oi';
  let i = Math.floor(Math.random() * BREAK_TIME_RETRY.length);
  if (i === _lastRetryIdx) i = (i + 1) % BREAK_TIME_RETRY.length;
  _lastRetryIdx = i;
  try { await slack().postMessage(BREAK_TIME_RETRY[i](n)); } catch (e) { /* non-fatal */ }
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

module.exports = {
  toAdmin, prereqWarning, duplicateBatch, adHocPending, batchChanged,
  note, voltaSemBreak, breakTimeRetry, breakTimeGaveUp,
  voltaSemBreakAdmin, retroBreakDone,
};
