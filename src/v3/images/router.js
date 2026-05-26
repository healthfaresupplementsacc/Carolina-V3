'use strict';
/**
 * HEALTHFARE — /api/images/upload
 *
 * Endpoint isolado pra Simone subir fotos do iPhone pro canal #images
 * (C0B6AQX6LJV) via files.uploadV2. Reusa o SLACK_BOT_TOKEN — token NUNCA
 * exposto pro cliente.
 *
 * Auth: query/header `IMAGES_UPLOAD_TOKEN` (env var). Sem env → 503
 *   (endpoint desligado). Bruno seta o valor no Railway depois do deploy.
 *
 * Body: JSON { images: [{ filename, data_url }] }   (base64 data url)
 *   - data_url: "data:image/jpeg;base64,/9j/4AAQ..."
 *   - Aceita 1+ imagens. Loop sequencial — robusto pra foto grande de iPhone.
 *
 * Response: { uploaded: [{ filename, ok, file_id?, error? }], channel }
 *
 * Nada toca v3.events / v3.messages / Observer / dashboard. 100% lateral.
 */

const TARGET_CHANNEL = process.env.IMAGES_UPLOAD_CHANNEL || 'C0B6AQX6LJV';
const BODY_LIMIT = '50mb';   // foto iPhone ~3-5MB; base64 infla 33%; permite umas 8 fotos por req

/** Parse "data:image/x;base64,..." → { mime, buffer }. Throws em formato ruim. */
function parseDataUrl(s) {
  const m = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(String(s || ''));
  if (!m) throw new Error('data_url inválido — esperado "data:<mime>;base64,..."');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('imagem vazia (base64 decodificou pra 0 bytes)');
  return { mime: m[1].toLowerCase(), buffer: buf };
}

/** Extrai file id da resposta do uploadV2 (formato varia entre versões do SDK). */
function extractFileId(up) {
  if (!up) return null;
  if (up.file && up.file.id) return up.file.id;
  if (Array.isArray(up.files) && up.files[0]) {
    const f = up.files[0];
    if (f.id) return f.id;
    if (Array.isArray(f.files) && f.files[0] && f.files[0].id) return f.files[0].id;
  }
  return null;
}

/**
 * Cria o router Express. Injetável pra teste — passa `slackClient`
 * (com `files.uploadV2`) e `expectedToken` direto, sem precisar do env.
 */
function createImagesRouter(deps = {}) {
  const express = require('express');
  const router = express.Router();

  // Resolve client + token na hora da request (não no boot) — env pode mudar
  // sem reboot via Railway, e o teste injeta direto via deps.
  const resolveDeps = () => {
    const token = deps.expectedToken
      || process.env.IMAGES_UPLOAD_TOKEN
      || null;
    let slackClient = deps.slackClient || null;
    if (!slackClient && process.env.SLACK_BOT_TOKEN) {
      const { WebClient } = require('@slack/web-api');
      slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
    }
    return { token, slackClient };
  };

  router.post('/api/images/upload',
    express.json({ limit: BODY_LIMIT }),
    async (req, res) => {
      // Cache-Control: no-store (mesmo do snapshot — evita re-post acidental cacheado)
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

      const { token, slackClient } = resolveDeps();

      // Sem env → desligado
      if (!token) {
        return res.status(503).json({ error: {
          code: 'disabled',
          message: 'endpoint desligado (IMAGES_UPLOAD_TOKEN não setada no env)',
        } });
      }
      if (!slackClient) {
        return res.status(503).json({ error: {
          code: 'disabled',
          message: 'Slack client ausente (SLACK_BOT_TOKEN não setado)',
        } });
      }

      // Auth — aceita header `x-images-token` ou query `?k=<token>`
      const got = (req.headers && req.headers['x-images-token'])
        || (req.query && req.query.k)
        || null;
      if (got !== token) {
        return res.status(401).json({ error: {
          code: 'unauthorized', message: 'token ausente ou inválido',
        } });
      }

      const body = req.body || {};
      const images = Array.isArray(body.images) ? body.images : [];
      if (!images.length) {
        return res.status(400).json({ error: {
          code: 'bad_request', message: 'body.images vazio',
        } });
      }

      // Loop sequencial — Slack rate-limita uploads. 1 por vez é seguro.
      const channel = body.channel_id || TARGET_CHANNEL;
      const uploaded = [];
      for (let i = 0; i < images.length; i++) {
        const im = images[i] || {};
        const filename = String(im.filename || ('image-' + (i + 1) + '.jpg')).slice(0, 120);
        try {
          const { buffer } = parseDataUrl(im.data_url);
          const up = await slackClient.files.uploadV2({
            channel_id: channel,
            file: buffer,
            filename,
            title: im.title || filename,
            initial_comment: im.comment || undefined,
          });
          const fid = extractFileId(up);
          uploaded.push({ filename, ok: true, file_id: fid, bytes: buffer.length });
        } catch (e) {
          uploaded.push({ filename, ok: false, error: e.message });
          // segue pras próximas — robusto a erros isolados
        }
      }

      const anyOk = uploaded.some((u) => u.ok);
      res.status(anyOk ? 200 : 502).json({
        channel,
        count: uploaded.length,
        ok_count: uploaded.filter((u) => u.ok).length,
        uploaded,
      });
    },
  );

  return router;
}

module.exports = { createImagesRouter, parseDataUrl, extractFileId, TARGET_CHANNEL };
