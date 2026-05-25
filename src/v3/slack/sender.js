'use strict';
/**
 * HEALTHFARE V3 — Porta de saída MANUAL ("Falar como").
 *
 * Reusa o método V2 (username override no chat.postMessage) MAS NÃO
 * importa nada do client.js do V2 — pega WebClient direto. Toda
 * chamada vem de quem invoca (PIN no dashboard ou Bruno via DM no
 * futuro). ZERO automático. Independente do Observer (shadow).
 *
 * Imagens: files.uploadV2 SEM channel_id → bot upload pra área do
 * próprio bot, retorna permalink → posta chat.postMessage com
 * username=<persona> e o permalink no texto. Slack renderiza inline.
 * Sem o "double post" (file por bot + msg por persona).
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

/** Robusta — files.uploadV2 retorna formatos diferentes em versões diferentes do SDK. */
function extractPermalink(uploadResult) {
  if (!uploadResult) return null;
  if (uploadResult.file && uploadResult.file.permalink) return uploadResult.file.permalink;
  if (Array.isArray(uploadResult.files)) {
    for (const f of uploadResult.files) {
      if (f && f.permalink) return f.permalink;
      if (Array.isArray(f && f.files)) {
        for (const ff of f.files) if (ff && ff.permalink) return ff.permalink;
      }
    }
  }
  return null;
}

/**
 * Posta no Slack como uma persona arbitrária (username override).
 * @param {object} opts
 *   channel — 'production' | 'admin' | 'C...' (id Slack cru)
 *   text    — string (opcional se houver image)
 *   sender  — { name (required), icon? (':emoji:' | https URL) }
 *   image   — { dataUrl, filename?, title? } opcional. dataUrl =
 *             "data:<mime>;base64,<b64>".
 *   _slackClient — injetado em teste pra evitar hit no Slack real.
 * @returns {Promise<{ ok:true, ts, channel, image_permalink? }>}
 */
async function postAs(opts) {
  const { channel, text, sender, image } = opts || {};
  if (!sender || !sender.name) throw new Error('sender.name obrigatório');
  if (!text && !image) throw new Error('text ou image obrigatório');
  const ch = resolveChannel(channel);
  const c = opts && opts._slackClient ? opts._slackClient : client();

  let imagePermalink = null;
  if (image && image.dataUrl) {
    const m = /^data:([^;,]+);base64,(.+)$/i.exec(String(image.dataUrl));
    if (!m) throw new Error('image.dataUrl inválido (esperado "data:<mime>;base64,...")');
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) throw new Error('image vazia');
    // upload sem channel_id → fica na área do bot; retornamos só o
    // permalink, sem postar nada no canal ainda.
    const up = await c.files.uploadV2({
      file: buf,
      filename: image.filename || 'image.png',
      title: image.title || image.filename || 'image',
    });
    imagePermalink = extractPermalink(up);
    if (!imagePermalink) throw new Error('upload sem permalink retornado');
  }

  const finalText = imagePermalink
    ? (text ? `${text}\n${imagePermalink}` : imagePermalink)
    : text;

  const params = {
    channel: ch,
    text: finalText,
    username: sender.name,
  };
  if (sender.icon) {
    const s = String(sender.icon);
    if (/^https?:\/\//i.test(s)) params.icon_url = s;
    else params.icon_emoji = s.startsWith(':') ? s : ':' + s + ':';
  }

  const r = await c.chat.postMessage(params);
  return { ok: true, ts: r.ts, channel: ch, image_permalink: imagePermalink };
}

module.exports = { postAs, resolveChannel, CHANNEL_KEYS, extractPermalink };
