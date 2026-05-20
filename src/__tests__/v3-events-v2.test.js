'use strict';
// HEALTHFARE V3 — PARTE 2.9 — testes comportamentais do webhook events-v2.
const crypto = require('crypto');
const { verifySignature, handleEvent, eventsV2Handler } = require('../v3/slack/events-v2');

const SECRET = 'test-signing-secret';
const NOW_MS = 1779220000000;
const tsNow = () => String(Math.floor(NOW_MS / 1000));
function sign(rawBody, ts, secret = SECRET) {
  return 'v0=' + crypto.createHmac('sha256', secret).update('v0:' + ts + ':' + rawBody).digest('hex');
}

function makeFakeDb({ events = [], existingTs = [] } = {}) {
  const messages = [];
  const updates = [];
  const tsSet = new Set(existingTs);
  return {
    messages, updates,
    query: jest.fn((sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^INSERT INTO v3\.messages/.test(s)) {
        if (!tsSet.has(params[0])) { // ON CONFLICT DO NOTHING
          tsSet.add(params[0]);
          messages.push({ slack_ts: params[0], slack_channel_id: params[1], slack_user_id: params[2], raw_text: params[3] });
        }
        return Promise.resolve({ rows: [] });
      }
      if (/^UPDATE v3\.messages SET raw_text/.test(s)) { updates.push({ type: 'edit', slack_ts: params[0], raw_text: params[1] }); return Promise.resolve({ rows: [] }); }
      if (/^UPDATE v3\.messages SET processing_error = 'deleted'/.test(s)) { updates.push({ type: 'delete', slack_ts: params[0] }); return Promise.resolve({ rows: [] }); }
      if (/^SELECT id FROM v3\.events WHERE source_message_ts/.test(s)) {
        return Promise.resolve({ rows: events.filter((e) => e.source_message_ts === params[0]).map((e) => ({ id: e.id })) });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
}

const PROD = 'C09UNBXFRKK';
const deps = (db, extra = {}) => Object.assign({
  db, productionChannelId: PROD, signingSecret: SECRET, now: () => NOW_MS,
  eventService: { softDelete: jest.fn().mockResolvedValue({}) },
}, extra);

describe('V3 §2.9 — verifySignature', () => {
  test('assinatura válida → true', () => {
    const body = '{"a":1}';
    const ts = tsNow();
    expect(verifySignature(body, { 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(body, ts) }, SECRET, NOW_MS)).toBe(true);
  });
  test('assinatura inválida → false', () => {
    const ts = tsNow();
    expect(verifySignature('{"a":1}', { 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=deadbeef' }, SECRET, NOW_MS)).toBe(false);
  });
  test('timestamp > 5min → false (replay)', () => {
    const body = '{"a":1}';
    const oldTs = String(Math.floor(NOW_MS / 1000) - 400);
    expect(verifySignature(body, { 'x-slack-request-timestamp': oldTs, 'x-slack-signature': sign(body, oldTs) }, SECRET, NOW_MS)).toBe(false);
  });
  test('headers ausentes → false', () => {
    expect(verifySignature('{}', {}, SECRET, NOW_MS)).toBe(false);
  });
});

describe('V3 §2.9 — handleEvent', () => {
  test('message no canal de produção → insere em v3.messages', async () => {
    const db = makeFakeDb();
    const r = await handleEvent({
      type: 'event_callback',
      event: { type: 'message', channel: PROD, ts: '200.1', user: 'U_ANA', text: 'comecei a linha' },
    }, deps(db));
    expect(r.action).toBe('inserted');
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].raw_text).toBe('comecei a linha');
  });

  test('message em outro canal → ignorada', async () => {
    const db = makeFakeDb();
    const r = await handleEvent({
      type: 'event_callback',
      event: { type: 'message', channel: 'C_OUTRO', ts: '200.2', user: 'U_ANA', text: 'x' },
    }, deps(db));
    expect(r.handled).toBe(false);
    expect(db.messages).toHaveLength(0);
  });

  test('slack_ts duplicado → ON CONFLICT, não duplica', async () => {
    const db = makeFakeDb({ existingTs: ['200.3'] });
    await handleEvent({
      type: 'event_callback',
      event: { type: 'message', channel: PROD, ts: '200.3', user: 'U_ANA', text: 'repetida' },
    }, deps(db));
    expect(db.messages).toHaveLength(0); // já existia
  });

  test('bot message → também é inserida (pre-filter decide skip)', async () => {
    const db = makeFakeDb();
    const r = await handleEvent({
      type: 'event_callback',
      event: { type: 'message', subtype: 'bot_message', channel: PROD, ts: '200.4', bot_id: 'B01', text: 'Carolina aviso' },
    }, deps(db));
    expect(r.action).toBe('inserted');
    expect(db.messages[0].slack_user_id).toBe('B01');
  });

  test('message_changed → atualiza raw_text + reprocessa', async () => {
    const db = makeFakeDb();
    const r = await handleEvent({
      type: 'event_callback',
      event: { type: 'message', subtype: 'message_changed', channel: PROD, message: { ts: '200.5', text: 'texto editado' } },
    }, deps(db));
    expect(r.action).toBe('edited');
    expect(db.updates[0]).toMatchObject({ type: 'edit', slack_ts: '200.5', raw_text: 'texto editado' });
  });

  test('message_deleted → marca deleted + softDelete dos events vinculados', async () => {
    const db = makeFakeDb({ events: [{ id: 71, source_message_ts: '200.6' }, { id: 72, source_message_ts: '200.6' }] });
    const d = deps(db);
    const r = await handleEvent({
      type: 'event_callback',
      event: { type: 'message', subtype: 'message_deleted', channel: PROD, deleted_ts: '200.6' },
    }, d);
    expect(r.action).toBe('deleted');
    expect(db.updates[0]).toMatchObject({ type: 'delete', slack_ts: '200.6' });
    expect(d.eventService.softDelete).toHaveBeenCalledTimes(2);
    expect(d.eventService.softDelete.mock.calls[0]).toEqual([71, null, 'source_deleted', 'system']);
  });

  test('subtype irrelevante (channel_join) → ignorado', async () => {
    const db = makeFakeDb();
    const r = await handleEvent({
      type: 'event_callback',
      event: { type: 'message', subtype: 'channel_join', channel: PROD, ts: '200.7' },
    }, deps(db));
    expect(r.handled).toBe(false);
    expect(db.messages).toHaveLength(0);
  });
});

describe('V3 §2.9 — eventsV2Handler', () => {
  test('url_verification → 200 com o challenge', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const ts = tsNow();
    const out = await eventsV2Handler(body, { 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(body, ts) }, deps(makeFakeDb()));
    expect(out.status).toBe(200);
    expect(out.body).toBe('abc123');
  });

  test('assinatura inválida → 401', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'x' });
    const out = await eventsV2Handler(body, { 'x-slack-request-timestamp': tsNow(), 'x-slack-signature': 'v0=fake' }, deps(makeFakeDb()));
    expect(out.status).toBe(401);
  });

  test('JSON malformado → 400, não derruba', async () => {
    const out = await eventsV2Handler('isso não é json {', {}, deps(makeFakeDb()));
    expect(out.status).toBe(400);
  });

  test('event_callback válido → 200 e mensagem inserida', async () => {
    const db = makeFakeDb();
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'message', channel: PROD, ts: '300.1', user: 'U_ANA', text: 'oi linha' },
    });
    const ts = tsNow();
    const out = await eventsV2Handler(body, { 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(body, ts) }, deps(db));
    expect(out.status).toBe(200);
    expect(db.messages).toHaveLength(1);
  });

  test('handleEvent lançando erro → ainda responde 200 (não derruba)', async () => {
    const db = makeFakeDb();
    db.query = jest.fn(() => Promise.reject(new Error('db down')));
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'message', channel: PROD, ts: '300.2', user: 'U_ANA', text: 'x' },
    });
    const ts = tsNow();
    const out = await eventsV2Handler(body, { 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(body, ts) }, deps(db));
    expect(out.status).toBe(200);
  });
});
