'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.2 — Pré-filtro determinístico (V3 doc §3.9)
 *
 * Descarte rápido ANTES do LLM. NÃO faz parsing semântico — decisão
 * de atribuição/ação é SEMPRE do LLM. Só separa o que nem precisa
 * chegar ao LLM (reduz custo ~30-40%).
 *
 * classifyForFilter(message, opts) → { category, ... }
 *
 *   bot_self      notificação automática do próprio bot.
 *                 → Observer persiste em v3.messages com
 *                   llm_processed_at=NOW, llm_result=skippedResult.
 *   admin_broadcast  bot carregando um broadcast de admin (botão 📢).
 *                 → NÃO descarta — persiste como CONTEXTO pro Observer
 *                   (llm_result=contextResult). Sem event. O Observer
 *                   (§2.8) decide quando marcar opts.isAdminBroadcast.
 *   small_talk    'ok'/'obrigada'/risada/emoji único/<3 chars.
 *                 → idem bot_self. Sem event.
 *   burst_member  5+ msgs do MESMO user em 10s. NÃO descarta —
 *                 retorna { batch:[...] } pro Observer coalescer
 *                 numa única chamada LLM com a sequência inteira.
 *   pass_to_llm   todo o resto → Observer normal.
 *
 * Bias de projeto: na dúvida, pass_to_llm. Nunca descartar algo
 * que possa carregar sinal de produção (ex.: 'sim'/'não' são
 * respostas legítimas a perguntas do admin → pass_to_llm).
 */

const BURST_COUNT = 5;          // 5+ msgs ...
const BURST_WINDOW_MS = 10000;  // ... em 10s
const SHORT_MAX = 3;            // length < 3 chars → small_talk

// Respostas curtas legítimas — NUNCA small_talk (podem responder
// o admin). Sobrepõem a regra de comprimento.
const LEGIT_SHORT = new Set(['sim', 'não', 'nao', 'yes', 'no']);

// Filler exato sem sinal de produção.
const SMALL_TALK_EXACT = new Set([
  'ok', 'okay', 'okk', 'obrigada', 'obrigado', 'thanks', 'thank you', 'valeu', 'vlw',
]);

// Risada: kkk, hahaha, hehe, rsrs, huehue…
const LAUGHTER = /^(k{2,}|(ha){2,}|(he){2,}|(hue){1,}|(rs){1,}|ha+h+a*)$/i;

/** ts do Slack ("1779219336.798349") → ms. */
function tsToMs(m) {
  const raw = m && (m.ts || m.slack_ts);
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n * 1000 : NaN;
}

/** true se a mensagem é só emoji(s) / shortcodes :joy: / espaços. */
function isEmojiOnly(text) {
  if (!text || !text.trim()) return false;
  const stripped = text
    .replace(/:[a-z0-9_'+-]+:/gi, '')                                  // shortcodes Slack
    .replace(/[\p{Extended_Pictographic}‍️\u{1F3FB}-\u{1F3FF}]/gu, '') // emoji + ZWJ + VS16 + skin tone
    .replace(/\s/g, '');
  return stripped.length === 0;
}

/**
 * @returns {string|null} tipo de small_talk, ou null se NÃO é small_talk.
 */
function smallTalkKind(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return 'empty';
  const lower = trimmed.toLowerCase();
  if (LEGIT_SHORT.has(lower)) return null;            // resposta legítima
  if (SMALL_TALK_EXACT.has(lower)) return 'exact';
  if (LAUGHTER.test(lower)) return 'laughter';
  if (isEmojiOnly(trimmed)) return 'emoji_only';
  if ([...trimmed].length < SHORT_MAX) return 'too_short';
  return null;
}

/**
 * Detecta rajada do MESMO user. recentUserMessages NÃO precisa estar
 * filtrado — a função filtra por message.slack_user_id (garante que
 * users diferentes não coalescem entre si).
 * @returns {Array|null} o batch (ordenado por ts) se for burst, senão null.
 */
function detectBurst(message, recentMessages = []) {
  const uid = message && message.slack_user_id;
  if (!uid) return null;
  const nowMs = tsToMs(message);
  if (!Number.isFinite(nowMs)) return null;

  const seen = new Set();
  const window = [];
  for (const m of [...recentMessages, message]) {
    if (!m || m.slack_user_id !== uid) continue;
    const t = tsToMs(m);
    if (!Number.isFinite(t)) continue;
    if (t > nowMs || t < nowMs - BURST_WINDOW_MS) continue;
    const key = m.ts || m.slack_ts;
    if (seen.has(key)) continue;
    seen.add(key);
    window.push(m);
  }
  if (window.length < BURST_COUNT) return null;
  window.sort((a, b) => tsToMs(a) - tsToMs(b));
  return window;
}

/**
 * Classificação principal.
 * @param {{text:string, ts?:string, slack_user_id?:string}} message
 * @param {{botUserId?:string, recentUserMessages?:Array}} opts
 */
function classifyForFilter(message, opts = {}) {
  // 1 — bot self / admin broadcast
  // Toda msg do bot cai aqui. Investigação confirmou: broadcast de
  // admin (botão 📢 → /api/admin/broadcast → postMessage) e
  // notificação automática da Carolina saem IDÊNTICAS no Slack
  // (mesmo bot, username 'Carolina', sem metadata distintiva).
  // A distinção vem do Observer (§2.8) via opts.isAdminBroadcast.
  if (opts.botUserId && message && message.slack_user_id === opts.botUserId) {
    return opts.isAdminBroadcast ? { category: 'admin_broadcast' } : { category: 'bot_self' };
  }
  // 2 — small talk
  const st = smallTalkKind(message && message.text);
  if (st) return { category: 'small_talk', detail: st };
  // 3 — burst do mesmo user
  const batch = detectBurst(message, opts.recentUserMessages || []);
  if (batch) return { category: 'burst_member', batch };
  // 4 — resto
  return { category: 'pass_to_llm' };
}

/** llm_result que o Observer grava em v3.messages p/ msgs descartadas. */
function skippedResult(category, detail) {
  return { skipped: category, detail: detail || null, pre_filter: true };
}

/** llm_result p/ msgs persistidas só como CONTEXTO (admin_broadcast). */
function contextResult(category) {
  return { category, context_only: true, pre_filter: true };
}

module.exports = {
  classifyForFilter, smallTalkKind, isEmojiOnly, detectBurst,
  skippedResult, contextResult,
  BURST_COUNT, BURST_WINDOW_MS, SHORT_MAX,
};
