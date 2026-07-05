'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.9 — Slack Events API webhook v2 (V3 doc §3.5)
 *
 * POST /slack/events-v2 — endpoint NOVO e isolado, paralelo ao
 * /slack/events legado. NÃO substitui nem toca o legado.
 *
 * Recebe mensagens do canal de produção e insere em v3.messages
 * (llm_processed_at=NULL → o Observer worker pega em segundos).
 * Trata message_changed (re-processa) e message_deleted (marca +
 * soft-delete dos events vinculados).
 *
 * slack_ts UNIQUE + ON CONFLICT DO NOTHING → re-entrega do Slack
 * (retry quando não recebe 200 em 3s) não duplica.
 *
 * BURST/DEBOUNCE na ingestão: avaliado e adiado. Um buffer com
 * timer no webhook (segurar 2-3s, agrupar) adiciona estado +
 * timers + risco de restart mid-hold. Em SHADOW o ordering do
 * burst é inofensivo (§2.8). → TODO Sprint 2.
 *
 * Princípio #24: queries v3.* schema-qualificadas.
 */
const crypto = require('crypto');
const { CommandHandler } = require('../services/CommandHandler');
const alertGate = require('../alert-gate');

const REPLAY_WINDOW_SEC = 300; // 5 min

/**
 * Verifica a assinatura do Slack (HMAC-SHA256 sobre o corpo cru).
 * @param {string} rawBody  corpo cru da requisição
 * @param {object} headers  headers (lowercase)
 * @param {string} signingSecret
 * @param {number} nowMs
 */
function verifySignature(rawBody, headers, signingSecret, nowMs) {
  const ts = headers['x-slack-request-timestamp'];
  const sig = headers['x-slack-signature'];
  if (!ts || !sig || !signingSecret) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > REPLAY_WINDOW_SEC) return false; // replay
  const base = 'v0:' + ts + ':' + rawBody;
  const mine = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  try {
    const a = Buffer.from(mine);
    const b = Buffer.from(String(sig));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

/**
 * Processa um payload de evento já parseado. Faz as escritas em
 * v3.messages. Só age sobre type=message no canal de produção.
 */
async function handleEvent(payload, deps) {
  const { db, productionChannelId, eventService, commandHandler, notificationHandler } = deps;
  const adminChannelId = deps.adminChannelId || 'C0B36DR5MP1';
  if (!payload || payload.type !== 'event_callback') return { handled: false, reason: 'not_event_callback' };
  const ev = payload.event || {};

  // ── REACTION (bloco 30/mai-noite — confirmar ✅ comando destrutivo) ──
  // Quando admin reage ✅ numa msg da Carolina, busca pending_command e
  // executa. ❌ cancela. Outros emojis → ignora.
  if (ev.type === 'reaction_added') {
    if (!commandHandler) return { handled: false, reason: 'no_command_handler' };
    const item = ev.item || {};
    if (item.type !== 'message') return { handled: false, reason: 'reaction_not_on_message' };
    // Reação de confirmação ✅/❌ vale no canal de produção OU no admin-orin (Frente 1).
    if (item.channel !== productionChannelId && item.channel !== adminChannelId) {
      return { handled: false, reason: 'reaction_other_channel' };
    }
    const emoji = ev.reaction;
    const reactorSlackUserId = ev.user;
    const carolinaMsgTs = item.ts;
    // ── SÁBADO (Bruno 07-04): a pergunta "fulano foi embora?" aceita reação de
    // QUALQUER UM do canal (não só admin) — ✅ faz o checkout, ❌ cobra a tarefa.
    try {
      const sat = await db.query(
        `SELECT id, payload FROM v3.notifications
         WHERE type = 'saturday_idle_check' AND status = 'pending' AND payload->>'msg_ts' = $1 LIMIT 1`,
        [carolinaMsgTs]);
      if (sat.rows.length) {
        const n = sat.rows[0]; const pay = n.payload || {};
        const yes = ['white_check_mark', '+1', 'heavy_check_mark'].includes(emoji);
        const no = ['x', 'no_entry_sign', 'red_circle'].includes(emoji);
        if (yes || no) {
          await db.query("UPDATE v3.notifications SET status = 'resolved' WHERE id = $1", [n.id]);
          const post = commandHandler && commandHandler.slack && commandHandler.slack.postAs;
          if (yes) {
            await db.query(
              `UPDATE v3.operator_sessions SET logged_out_at = NOW(), logoff_reason = 'saturday_confirmed_left'
               WHERE person_id = $1 AND logged_out_at IS NULL`, [pay.person_id]);
            if (post) { try { await post({ channel: item.channel, sender: { name: 'HealthFare Tracker', icon: ':door:' }, thread_ts: null, text: `:door: Fazendo o checkout de *${pay.display_name}*. Bom fim de semana!` }); } catch (_) {} }
          } else if (post) {
            const who = pay.slack_user_id ? `<@${pay.slack_user_id}>` : `*${pay.display_name}*`;
            try { await post({ channel: item.channel, sender: { name: 'HealthFare Tracker', icon: ':hourglass_flowing_sand:' }, thread_ts: null, text: `${who}, então registra a tarefa no aplicativo da linha de produção *agora*, por favor.` }); } catch (_) {}
          }
          return { handled: true, action: 'saturday_idle_' + (yes ? 'checkout' : 'still_here') };
        }
      }
    } catch (e) { console.error('[events-v2] saturday_idle_check erro:', e.message); }
    // Resolve reactor → person (deve ser admin com role owner/manager)
    const personR = await db.query(
      `SELECT id, role, display_name FROM v3.persons
       WHERE slack_user_id = $1 AND role IN ('owner','manager') AND deleted_at IS NULL`,
      [reactorSlackUserId]);
    if (personR.rows.length === 0) {
      return { handled: false, reason: 'reactor_not_admin' };
    }
    const reactorPersonId = personR.rows[0].id;
    const reactorName = personR.rows[0].display_name;
    // helper: se não era pending_command, tenta notificação do dedupe (Deploy 3)
    const tryNotification = async () => {
      if (!notificationHandler) return null;
      const n = await notificationHandler.handleReaction({
        carolinaMsgTs, emoji, reactorPersonId, reactorName, channel: item.channel,
      });
      return n.handled ? { handled: true, action: 'notification_' + n.action } : null;
    };
    if (emoji === 'white_check_mark' || emoji === '+1' || emoji === 'heavy_check_mark') {
      const r = await commandHandler.confirmAndExecute({
        carolinaMsgTs, reactorSlackUserId, reactorPersonId, channel: item.channel,
      });
      if (r.handled === true) return { handled: true, action: 'reaction_confirm', result: r };
      const n = await tryNotification();
      if (n) return n;
      return { handled: false, action: 'reaction_confirm', result: r };
    }
    if (emoji === 'x' || emoji === 'no_entry_sign' || emoji === 'red_circle') {
      // Cancela pending
      const upd = await db.query(`
        UPDATE v3.pending_commands SET status='cancelled', confirmed_at=NOW()
        WHERE carolina_msg_ts = $1 AND status='pending' AND admin_person_id = $2
        RETURNING id`, [carolinaMsgTs, reactorPersonId]);
      if (upd.rowCount > 0 && commandHandler && commandHandler.slack && commandHandler.slack.postAs) {
        try {
          await commandHandler.slack.postAs({
            // reply top-level (thread_ts=null) — decisão Bruno 01/jun.
            channel: item.channel, sender: { name: 'Carolina' },
            thread_ts: null, text: '🛑 Comando cancelado pelo admin.',
          });
        } catch (_) { /* não derruba */ }
        return { handled: true, action: 'reaction_cancel' };
      }
      const n = await tryNotification();
      if (n) return n;
      return { handled: false, action: 'reaction_cancel' };
    }
    if (emoji === 'memo' || emoji === 'pencil' || emoji === 'pencil2') {
      const n = await tryNotification();
      if (n) return n;
      return { handled: false, reason: 'edit_without_notification' };
    }
    return { handled: false, reason: 'reaction_emoji_ignored' };
  }

  if (ev.type !== 'message') return { handled: false, reason: 'not_message' };
  // Escopo de canal (Frente 1 — 01/jun):
  //   produção (C09UNBXFRKK): ingere TUDO (operadores trabalhando).
  //   admin-orin (C0B36DR5MP1): canal de COMANDO, não de produção — ingere
  //     SÓ msgs com mention da Carolina. As demais (admins conversando entre
  //     si) são dropadas ANTES do INSERT → zero custo de LLM.
  //   qualquer outro canal: dropa.
  if (ev.channel === productionChannelId) {
    // ingere tudo (segue abaixo)
  } else if (ev.channel === adminChannelId) {
    // ── KILL-SWITCH DOS AVISOS (Bruno 07-05) ──────────────────────
    // Comando DETERMINÍSTICO (sem LLM) pro admin pausar/religar os avisos do
    // canal de operadores direto do chat admin. Intercepta ANTES do gate de
    // mention e do INSERT (não gasta cota). Só mensagens HUMANAS (bot não se
    // auto-comanda). Ex.: "pausa os avisos", "por 2h", "voltar avisos".
    const isHuman = (ev.subtype === undefined) && ev.user && !ev.bot_id;
    if (isHuman) {
      const cmd = alertGate.parseMuteCommand(ev.text || '', Date.now());
      if (cmd.action) {
        const post = (text) => {
          const s = commandHandler && commandHandler.slack;
          if (s && s.postAs) return s.postAs({ channel: adminChannelId, sender: { name: 'HealthFare Tracker', icon: ':bell:' }, thread_ts: null, unfurl_links: false, unfurl_media: false, text }).catch(() => {});
          return Promise.resolve();
        };
        try {
          if (cmd.action === 'mute') {
            await alertGate.setMute(db, { untilMs: cmd.untilMs, reason: (ev.text || '').slice(0, 120), by: ev.user });
            const f = alertGate.fmtUntil(cmd.untilMs, Date.now());
            await post(`:mute: *Avisos do canal de operadores pausados* — ${cmd.label} (até ${f.clock}, ~${f.dur}).\nNão vou mandar cobrança de ociosidade nem alerta de máquina parada no #orders-and-inventory até lá. _Pra religar antes: "voltar avisos"._`);
            return { handled: true, action: 'alerts_muted', until: cmd.untilMs };
          }
          if (cmd.action === 'unmute') {
            await alertGate.clearMute(db);
            await post(':bell: *Avisos do canal de operadores religados.* Voltei a monitorar ociosidade e máquina parada normalmente.');
            return { handled: true, action: 'alerts_unmuted' };
          }
          if (cmd.action === 'status') {
            const m = await alertGate.getMute(db);
            if (m && Date.now() < m.untilMs) {
              const f = alertGate.fmtUntil(m.untilMs, Date.now());
              await post(`:mute: Avisos *pausados* até ${f.clock} (~${f.dur}). Pra religar: "voltar avisos".`);
            } else {
              await post(':bell: Avisos *ativos* (monitorando normalmente). Pra pausar: "pausa os avisos".');
            }
            return { handled: true, action: 'alerts_status' };
          }
        } catch (e) { console.error('[events-v2] kill-switch erro:', e.message); }
      }
    }
    if (!CommandHandler.hasMention(ev.text || '')) {
      return { handled: false, reason: 'admin_channel_no_mention' };
    }
  } else {
    return { handled: false, reason: 'other_channel' };
  }
  const sub = ev.subtype;

  // ── edição ──
  if (sub === 'message_changed') {
    const mm = ev.message || {};
    await db.query(
      `UPDATE v3.messages SET raw_text = $2, llm_processed_at = NULL, processing_error = NULL
       WHERE slack_ts = $1`,
      [mm.ts, mm.text || '']);
    return { handled: true, action: 'edited', slack_ts: mm.ts };
  }

  // ── deleção ──
  if (sub === 'message_deleted') {
    const dts = ev.deleted_ts;
    await db.query(
      "UPDATE v3.messages SET processing_error = 'deleted' WHERE slack_ts = $1", [dts]);
    if (eventService) {
      const evs = await db.query(
        'SELECT id FROM v3.events WHERE source_message_ts = $1 AND deleted_at IS NULL', [dts]);
      for (const row of evs.rows) {
        await eventService.softDelete(row.id, null, 'source_deleted', 'system');
      }
    }
    return { handled: true, action: 'deleted', slack_ts: dts };
  }

  // ── mensagem nova (usuário ou bot) ──
  if (sub === undefined || sub === 'bot_message') {
    await db.query(
      `INSERT INTO v3.messages (slack_ts, slack_channel_id, slack_user_id, raw_text, created_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5))
       ON CONFLICT (slack_ts) DO NOTHING`,
      [ev.ts, ev.channel, ev.user || ev.bot_id || 'unknown', ev.text || '', parseFloat(ev.ts)]);
    return { handled: true, action: 'inserted', slack_ts: ev.ts };
  }

  // outros subtypes (channel_join, etc.) → ignora
  return { handled: false, reason: 'ignored_subtype:' + sub };
}

/**
 * Handler puro: corpo cru + headers → { status, body }. Testável
 * sem Express. Responde 200 rápido (Slack exige <3s); o trabalho
 * pesado fica pro worker.
 */
async function eventsV2Handler(rawBody, headers, deps) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (_) {
    return { status: 400, body: 'invalid json' };
  }
  const nowMs = deps.now ? deps.now() : Date.now();
  if (!verifySignature(rawBody, headers, deps.signingSecret, nowMs)) {
    return { status: 401, body: 'invalid signature' };
  }
  if (payload.type === 'url_verification') {
    return { status: 200, body: payload.challenge || '' };
  }
  try {
    await handleEvent(payload, deps);
  } catch (e) {
    // Slack precisa de 200 (slack_ts UNIQUE evita dup no retry; o
    // poller legado segue de backup durante o shadow). Loga e segue.
    console.error('[events-v2] erro ao processar evento:', e.message);
  }
  return { status: 200, body: '' };
}

/**
 * Monta o router Express. Usa express.raw p/ capturar o corpo cru
 * (necessário pra verificação de assinatura).
 */
function createRouter(deps) {
  const express = require('express');
  const router = express.Router();
  router.post('/slack/events-v2', express.raw({ type: () => true }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    const out = await eventsV2Handler(rawBody, req.headers || {}, deps);
    res.status(out.status).send(out.body);
  });
  return router;
}

module.exports = { verifySignature, handleEvent, eventsV2Handler, createRouter, REPLAY_WINDOW_SEC };
