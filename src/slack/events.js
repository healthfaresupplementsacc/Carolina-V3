'use strict';
/**
 * Entrega 3 Fase 6.1 — Slack Events API + Interactivity endpoint.
 *
 * IMPORTANT: this only works once Bruno completes the manual Slack app
 * setup (see the Entrega 3 final report):
 *   1. Enable the App Home / Home Tab
 *   2. Add OAuth scopes: chat:write, im:history, users:read,
 *      app_mentions:read (already have), and ensure the bot has
 *      reactions:write (already used)
 *   3. Enable Event Subscriptions, set Request URL to
 *      https://<host>/slack/events, subscribe to:
 *        - app_home_opened
 *   4. Enable Interactivity, set Request URL to
 *      https://<host>/slack/events
 *   5. Set SLACK_SIGNING_SECRET env var on Railway
 *   6. Reinstall the app
 *
 * Until then this router is mounted but Slack never calls it. The poller
 * keeps working unchanged.
 *
 * Signature verification follows Slack's v0 scheme:
 *   basestring = 'v0:' + timestamp + ':' + rawBody
 *   expected   = 'v0=' + HMAC_SHA256(signing_secret, basestring)
 *   constant-time compare with X-Slack-Signature; reject if timestamp
 *   skew > 5 min (replay protection).
 */

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const home = require('./home');
const interactive = require('./interactive');

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';

function verifySlackSignature(req) {
  if (!SIGNING_SECRET) {
    // No secret configured — refuse rather than accept blindly.
    return { ok: false, reason: 'SLACK_SIGNING_SECRET not set' };
  }
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return { ok: false, reason: 'missing signature headers' };

  // Replay window: 5 minutes
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(skew) || skew > 300) return { ok: false, reason: 'timestamp skew' };

  const raw = req.rawBody != null ? req.rawBody : JSON.stringify(req.body || {});
  const base = `v0:${ts}:${raw}`;
  const expected = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(base).digest('hex');
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(String(sig));
    if (a.length !== b.length) return { ok: false, reason: 'length mismatch' };
    return { ok: crypto.timingSafeEqual(a, b), reason: 'signature' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Slack sends application/json for events and
// application/x-www-form-urlencoded (payload=<json>) for interactivity.
// index.js mounts a raw-body capturer before this router so we can verify.
router.post('/slack/events', async (req, res) => {
  // URL verification handshake — Slack sends this once when you set the
  // Request URL. Respond with the challenge BEFORE signature checks so
  // initial setup works (challenge has no security implication).
  if (req.body && req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  const v = verifySlackSignature(req);
  if (!v.ok) {
    console.warn('[SlackEvents] signature rejected:', v.reason);
    return res.status(401).json({ error: 'invalid signature' });
  }

  // Interactivity payloads arrive form-encoded as payload=<json>
  if (req.body && req.body.payload) {
    let payload;
    try { payload = JSON.parse(req.body.payload); }
    catch { return res.status(400).json({ error: 'bad payload' }); }
    // Ack within 3s — handle async
    res.status(200).end();
    interactive.handleInteraction(payload).catch((err) =>
      console.error('[SlackEvents] interaction error:', err.message));
    return;
  }

  // Events API envelope
  const evt = req.body && req.body.event;
  if (evt) {
    res.status(200).end(); // ack fast
    if (evt.type === 'app_home_opened') {
      home.publishHome(evt.user).catch((err) =>
        console.error('[SlackEvents] publishHome error:', err.message));
    }
    return;
  }

  res.status(200).end();
});

// Bug B — Options Load URL for external_select (supplement autocomplete).
// Slack POSTs a block_suggestion payload here (form-encoded payload=<json>).
// Must respond within 3s with { options:[…] }.
router.post('/slack/options', async (req, res) => {
  const v = verifySlackSignature(req);
  if (!v.ok) {
    console.warn('[SlackOptions] signature rejected:', v.reason);
    return res.status(401).json({ options: [] });
  }
  let payload = {};
  try {
    payload = req.body && req.body.payload ? JSON.parse(req.body.payload) : (req.body || {});
  } catch { payload = {}; }
  try {
    const options = require('./options');
    const out = await options.buildOptionsResponse(payload);
    return res.json(out);
  } catch (err) {
    console.error('[SlackOptions] error:', err.message);
    return res.json({ options: [] });
  }
});

module.exports = { router, verifySlackSignature };
