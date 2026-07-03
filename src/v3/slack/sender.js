'use strict';
/**
 * HEALTHFARE V3 — Porta de saída MANUAL ("Falar como").
 *
 * Reusa o método V2 (username override no chat.postMessage) MAS NÃO
 * importa nada do client.js do V2. Toda chamada vem de quem invoca
 * (PIN dashboard). ZERO automático. Independente do Observer (shadow).
 *
 * IMAGEM INLINE com persona:
 *   1) files.uploadV2 (sem channel_id) → arquivo na área do bot, retorna file_id
 *   2) files.sharedPublicURL(file_id)   → torna o arquivo público, retorna permalink_public
 *   3) chat.postMessage username='<persona>' + blocks=[image_url=url_private?pub_secret=...]
 *   → 1 mensagem só, Carolina, com imagem renderizada inline.
 *   Requer scope files:write.public no app Slack. Se faltar, fallback
 *   pra texto+link (modo antigo) e devolve image_inline=false.
 *
 * Markdown mrkdwn: chat.postMessage usa mrkdwn por padrão; passamos
 * explícito true. *negrito*, _itálico_, `code`, ~strike~, > quote.
 *
 * thread_ts opcional → mensagem vira resposta em thread.
 */

const { WebClient } = require('@slack/web-api');

const CHANNEL_KEYS = {
  production: process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK',
  admin: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
};

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN ausente');
    _client = new WebClient(process.env.SLACK_BOT_TOKEN);
  }
  return _client;
}

/** Aceita 'production' | 'admin' OU ID Slack cru (C/G/D + alphanum). */
function resolveChannel(channel) {
  if (channel == null) throw new Error('channel obrigatório');
  if (CHANNEL_KEYS[channel]) return CHANNEL_KEYS[channel];
  const s = String(channel);
  if (/^[CGD][A-Z0-9]{6,}$/.test(s)) return s;
  throw new Error('channel inválido: ' + channel);
}

/** files.uploadV2 retorna formatos diferentes em versões diferentes do SDK. */
function extractFileObj(uploadResult) {
  if (!uploadResult) return null;
  if (uploadResult.file && uploadResult.file.id) return uploadResult.file;
  if (Array.isArray(uploadResult.files)) {
    for (const f of uploadResult.files) {
      if (f && f.id) return f;
      if (Array.isArray(f && f.files)) {
        for (const ff of f.files) if (ff && ff.id) return ff;
      }
    }
  }
  return null;
}

/** Backwards-compat — extrai só o permalink (privado). */
function extractPermalink(uploadResult) {
  const f = extractFileObj(uploadResult);
  return f && f.permalink ? f.permalink : null;
}

/** pub_secret = última parte do permalink_public após o último '-'. */
function extractPubSecret(permalinkPublic) {
  if (!permalinkPublic) return null;
  const m = /-([a-z0-9]+)$/i.exec(String(permalinkPublic));
  return m ? m[1] : null;
}

/**
 * Aceita um link de mensagem do Slack
 *   https://workspace.slack.com/archives/C09.../p1748121234567890
 * e devolve o ts no formato '1748121234.567890'. Aceita também o ts
 * cru. null se não conseguir parsear.
 */
function parseSlackTs(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  // já é ts cru ex 1234567890.123456
  if (/^\d{8,}\.\d+$/.test(s)) return s;
  // link → pega o p<num> no path
  const m = /\/p(\d{16,})/.exec(s);
  if (m) {
    const raw = m[1];
    return raw.slice(0, raw.length - 6) + '.' + raw.slice(-6);
  }
  return null;
}

/**
 * Posta no Slack como uma persona (username override).
 * @param {object} opts
 *   channel    — 'production'|'admin'|'C...'
 *   text       — string (mrkdwn). Opcional se houver image
 *   sender     — { name (required), icon? }
 *   image      — { dataUrl, filename?, title? } opcional
 *   thread_ts  — opcional: responde nessa thread
 *   _slackClient — injetável (teste)
 * @returns { ok, ts, channel, image_inline?, image_permalink?, image_warning? }
 */
async function postAs(opts) {
  const { channel, text, sender, image, thread_ts: threadTsIn } = opts || {};
  if (!sender || !sender.name) throw new Error('sender.name obrigatório');
  if (!text && !image) throw new Error('text ou image obrigatório');
  const ch = resolveChannel(channel);
  const c = opts && opts._slackClient ? opts._slackClient : client();
  const thread_ts = parseSlackTs(threadTsIn) || (threadTsIn || null);

  // ── IMAGEM ────────────────────────────────────────────────────
  // 1) uploadV2 sem channel_id → arquivo na área do bot, retorna file
  // 2) files.sharedPublicURL → file vira público; pega pub_secret
  // 3) image_url = url_private + '?pub_secret=' + secret → usável em
  //    image block do chat.postMessage com username override.
  let imageInline = false;
  let imagePermalink = null;
  let imageUrl = null;
  let imageWarning = null;
  if (image && image.dataUrl) {
    const m = /^data:([^;,]+);base64,(.+)$/i.exec(String(image.dataUrl));
    if (!m) throw new Error('image.dataUrl inválido (esperado "data:<mime>;base64,...")');
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) throw new Error('image vazia');
    const up = await c.files.uploadV2({
      file: buf,
      filename: image.filename || 'image.png',
      title: image.title || image.filename || 'image',
    });
    const fileObj = extractFileObj(up);
    if (!fileObj || !fileObj.id) throw new Error('upload sem file id retornado');
    imagePermalink = fileObj.permalink || null;
    // tenta tornar público → image_url usável em block
    try {
      const pub = await c.files.sharedPublicURL({ file: fileObj.id });
      const pf = (pub && (pub.file || (Array.isArray(pub.files) && pub.files[0]))) || fileObj;
      const secret = extractPubSecret(pf.permalink_public);
      const priv = pf.url_private || pf.url_private_download;
      if (secret && priv) {
        imageUrl = priv + (priv.includes('?') ? '&' : '?') + 'pub_secret=' + secret;
        imageInline = true;
      }
    } catch (e) {
      // scope files:write.public faltando → fallback p/ link no texto
      imageWarning = 'sharedPublicURL falhou: ' + e.message + ' (verifica scope files:write.public no app Slack); imagem postada como link.';
    }
  }

  // ── MENSAGEM ──────────────────────────────────────────────────
  const params = {
    channel: ch,
    username: sender.name,
    mrkdwn: true,
  };
  if (thread_ts) params.thread_ts = thread_ts;

  if (sender.icon) {
    const s = String(sender.icon);
    if (/^https?:\/\//i.test(s)) params.icon_url = s;
    else params.icon_emoji = s.startsWith(':') ? s : ':' + s + ':';
  }

  if (imageInline && imageUrl) {
    // texto + imagem renderizada inline via block
    const blocks = [];
    if (text) blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
    blocks.push({
      type: 'image',
      image_url: imageUrl,
      alt_text: (image && (image.filename || image.title)) || 'imagem',
    });
    params.blocks = blocks;
    params.text = text || (image && image.filename) || 'imagem';   // fallback p/ notificação
  } else if (imagePermalink) {
    // fallback (sem scope público): texto + link
    params.text = text ? `${text}\n${imagePermalink}` : imagePermalink;
  } else {
    params.text = text;
  }

  const r = await c.chat.postMessage(params);
  return {
    ok: true,
    ts: r.ts,
    channel: ch,
    thread_ts: thread_ts || null,
    image_inline: imageInline,
    image_permalink: imagePermalink,
    image_warning: imageWarning,
  };
}

/**
 * Adiciona uma reação (emoji) como o bot/persona.
 * Slack reactions.add NÃO permite override de username (a reação aparece
 * como vinda do bot real), MAS o emoji aparece no contador da msg sem
 * "Carolina" associado — fica como reação do bot HealthFare Tracker.
 * Mesmo assim útil pra "confirmar visto" sem postar texto.
 * @returns { ok, channel, ts, emoji }
 */
async function addReaction(opts) {
  const { channel, ts, emoji, _slackClient } = opts || {};
  if (!channel) throw new Error('channel obrigatório');
  if (!ts) throw new Error('ts obrigatório');
  if (!emoji) throw new Error('emoji obrigatório');
  const ch = resolveChannel(channel);
  const tsResolved = parseSlackTs(ts);
  if (!tsResolved) throw new Error('ts inválido (precisa ser "1234.5678" ou um link Slack)');
  const name = String(emoji).replace(/^:|:$/g, '');
  const c = _slackClient || client();
  await c.reactions.add({ channel: ch, timestamp: tsResolved, name });
  return { ok: true, channel: ch, ts: tsResolved, emoji: name };
}

/**
 * Edita uma mensagem já postada pelo bot (chat.update). Usado pelo fluxo
 * de notificações do dedupe (Carolina atualiza a própria msg com o status
 * final ✅/❌/📝 — mantém o histórico no canal sem repostar).
 * @returns { ok, channel, ts }
 */
async function updateMessage(opts) {
  const { channel, ts, text, _slackClient } = opts || {};
  if (!channel || !ts || !text) throw new Error('channel, ts e text obrigatórios');
  const ch = resolveChannel(channel);
  const c = _slackClient || client();
  await c.chat.update({ channel: ch, ts: String(ts), text, mrkdwn: true });
  return { ok: true, channel: ch, ts: String(ts) };
}

/**
 * DM de verdade pra um usuário (Bruno 07-03: aviso de ocioso/checkout = canal
 * dos operadores SEMPRE + DM em adição). resolveChannel rejeita IDs U... —
 * aqui a gente ABRE a conversa IM (conversations.open → canal D...) e reusa o
 * postAs. Precisa do scope `im:write`; sem ele, lança e o caller degrada
 * (o post no canal já saiu — DM é bônus, nunca bloqueia).
 * @param {{ userId: string, sender: {name, icon?}, text: string }} opts
 * @returns { ok, channel, ts }
 */
async function postDm(opts) {
  const { userId, sender, text, _slackClient } = opts || {};
  if (!userId || !/^[UW][A-Z0-9]{6,}$/.test(String(userId))) throw new Error('userId inválido: ' + userId);
  const c = _slackClient || client();
  const im = await c.conversations.open({ users: String(userId) });
  const dmChannel = im && im.channel && im.channel.id;
  if (!dmChannel) throw new Error('conversations.open não devolveu canal');
  return postAs({ channel: dmChannel, sender, text, thread_ts: null, unfurl_links: false, unfurl_media: false, _slackClient });
}

module.exports = {
  postAs, addReaction, updateMessage, postDm,
  resolveChannel, parseSlackTs,
  extractFileObj, extractPermalink, extractPubSecret,
  CHANNEL_KEYS,
};
