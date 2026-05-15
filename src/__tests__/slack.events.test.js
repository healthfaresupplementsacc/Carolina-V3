'use strict';
/**
 * Entrega 3 Fase 6.1 — /slack/events signature verification + handshake.
 */
const crypto = require('crypto');

describe('verifySlackSignature', () => {
  const OLD_ENV = process.env.SLACK_SIGNING_SECRET;
  afterAll(() => { process.env.SLACK_SIGNING_SECRET = OLD_ENV; });

  function load() {
    jest.resetModules();
    return require('../slack/events');
  }

  test('rejects when no signing secret configured', () => {
    delete process.env.SLACK_SIGNING_SECRET;
    const { verifySlackSignature } = load();
    const r = verifySlackSignature({ headers: {}, body: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/SLACK_SIGNING_SECRET/);
  });

  test('accepts a correctly-signed request', () => {
    process.env.SLACK_SIGNING_SECRET = 'topsecret';
    const { verifySlackSignature } = load();
    const ts = Math.floor(Date.now() / 1000).toString();
    const raw = JSON.stringify({ hello: 'world' });
    const base = `v0:${ts}:${raw}`;
    const sig = 'v0=' + crypto.createHmac('sha256', 'topsecret').update(base).digest('hex');
    const r = verifySlackSignature({
      headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
      rawBody: raw, body: { hello: 'world' },
    });
    expect(r.ok).toBe(true);
  });

  test('rejects a tampered body', () => {
    process.env.SLACK_SIGNING_SECRET = 'topsecret';
    const { verifySlackSignature } = load();
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = 'v0=' + crypto.createHmac('sha256', 'topsecret')
      .update(`v0:${ts}:${JSON.stringify({ a: 1 })}`).digest('hex');
    const r = verifySlackSignature({
      headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
      rawBody: JSON.stringify({ a: 2 }), body: { a: 2 },
    });
    expect(r.ok).toBe(false);
  });

  test('rejects an old timestamp (replay protection)', () => {
    process.env.SLACK_SIGNING_SECRET = 'topsecret';
    const { verifySlackSignature } = load();
    const oldTs = (Math.floor(Date.now() / 1000) - 9999).toString();
    const raw = '{}';
    const sig = 'v0=' + crypto.createHmac('sha256', 'topsecret')
      .update(`v0:${oldTs}:${raw}`).digest('hex');
    const r = verifySlackSignature({
      headers: { 'x-slack-request-timestamp': oldTs, 'x-slack-signature': sig },
      rawBody: raw, body: {},
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/skew/);
  });

  test('rejects missing headers', () => {
    process.env.SLACK_SIGNING_SECRET = 'topsecret';
    const { verifySlackSignature } = load();
    const r = verifySlackSignature({ headers: {}, body: {} });
    expect(r.ok).toBe(false);
  });
});

describe('/slack/events route', () => {
  const express = require('express');
  const http = require('http');

  function appWith() {
    jest.resetModules();
    process.env.SLACK_SIGNING_SECRET = 'topsecret';
    const slackEvents = require('../slack/events');
    const app = express();
    app.use(express.json({ verify: (req, _r, buf) => { req.rawBody = buf.toString('utf8'); } }));
    app.use(express.urlencoded({ extended: true, verify: (req, _r, buf) => { req.rawBody = buf.toString('utf8'); } }));
    app.use('/', slackEvents.router);
    return app;
  }
  function req(app, body, headers = {}) {
    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        const port = server.address().port;
        const data = JSON.stringify(body);
        const r = http.request({
          hostname: '127.0.0.1', port, path: '/slack/events', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
        }, (res) => {
          let c = ''; res.on('data', (d) => { c += d; });
          res.on('end', () => { server.close(); let p; try { p = JSON.parse(c); } catch { p = c; } resolve({ status: res.statusCode, body: p }); });
        });
        r.on('error', () => { server.close(); resolve({ status: 0 }); });
        r.write(data); r.end();
      });
    });
  }

  test('url_verification handshake returns challenge without signature', async () => {
    const app = appWith();
    const r = await req(app, { type: 'url_verification', challenge: 'abc123' });
    expect(r.status).toBe(200);
    expect(r.body.challenge).toBe('abc123');
  });

  test('unsigned event request → 401', async () => {
    const app = appWith();
    const r = await req(app, { event: { type: 'app_home_opened', user: 'U1' } });
    expect(r.status).toBe(401);
  });
});
