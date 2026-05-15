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

module.exports = { toAdmin, prereqWarning, duplicateBatch, adHocPending, batchChanged };
