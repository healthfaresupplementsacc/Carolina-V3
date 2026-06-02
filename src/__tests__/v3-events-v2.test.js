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
const ADMIN = 'C0B36DR5MP1';
const deps = (db, extra = {}) => Object.assign({
  db, productionChannelId: PROD, adminChannelId: ADMIN, signingSecret: SECRET, now: () => NOW_MS,
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

// Frente 1 (01/jun) — admin-orin é canal de COMANDO: ingere só com @Carolina.
describe('V3 §2.9 — escopo admin-orin (Frente 1)', () => {
  test('admin-orin COM @Carolina → ingere', async () => {
    const db = makeFakeDb();
    const r = await handleEvent({
      type: 'event_callback',
      event: { type: 'message', channel: ADMIN, ts: '210.1', user: 'U03URLL1D4L',
        text: '<@U0B3EQLPEPL> anota machine_downtime de 4:18 PM a 4:52 PM dia 29/mai' },
    }, deps(db));
    expect(r.action).toBe('inserted');
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].slack_channel_id).toBe(ADMIN);
  });

  test('admin-orin SEM mention → drop admin_channel_no_mention (zero custo LLM)', async () => {
    const db = makeFakeDb();
    const r = await handleEvent({
      type: 'event_callback',
      event: { type: 'message', channel: ADMIN, ts: '210.2', user: 'U03URLL1D4L',
        text: 'Thassio, viu o relatorio de ontem?' },
    }, deps(db));
    expect(r.handled).toBe(false);
    expect(r.reason).toBe('admin_channel_no_mention');
    expect(db.messages).toHaveLength(0);
  });

  test('produção COM @Carolina → ingere (regressão: produção sempre ingere)', async () => {
    const db = makeFakeDb();
    const r = await handleEvent({
      type: 'event_callback',
      event: { type: 'message', channel: PROD, ts: '210.3', user: 'U03URLL1D4L',
        text: '<@U0B3EQLPEPL> apaga ev280' },
    }, deps(db));
    expect(r.action).toBe('inserted');
    expect(db.messages).toHaveLength(1);
  });

  test('outro canal qualquer (mesmo com mention) → drop other_channel', async () => {
    const db = makeFakeDb();
    const r = await handleEvent({
      type: 'event_callback',
      event: { type: 'message', channel: 'C_RANDOM', ts: '210.4', user: 'U03URLL1D4L',
        text: '<@U0B3EQLPEPL> oi' },
    }, deps(db));
    expect(r.handled).toBe(false);
    expect(r.reason).toBe('other_channel');
    expect(db.messages).toHaveLength(0);
  });

  test('reaction ❌ (cancelamento) posta TOP-LEVEL (thread_ts=null) no canal de origem', async () => {
    const adminDb = {
      query: jest.fn((sql) => {
        const s = String(sql);
        if (/FROM v3\.persons/.test(s)) return Promise.resolve({ rows: [{ id: 1, role: 'owner' }] });
        if (/UPDATE v3\.pending_commands SET status='cancelled'/.test(s)) return Promise.resolve({ rows: [{ id: 7 }], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const postAs = jest.fn().mockResolvedValue({ ts: 'x' });
    const d = deps(adminDb, { commandHandler: { slack: { postAs } } });
    const r = await handleEvent({
      type: 'event_callback',
      event: {
        type: 'reaction_added', reaction: 'x', user: 'U03URLL1D4L',
        item: { type: 'message', channel: ADMIN, ts: 'carolina.reply.1' },
      },
    }, d);
    expect(r.action).toBe('reaction_cancel');
    expect(postAs).toHaveBeenCalledTimes(1);
    expect(postAs.mock.calls[0][0].thread_ts).toBeNull();      // top-level
    expect(postAs.mock.calls[0][0].channel).toBe(ADMIN);       // canal de origem
    expect(postAs.mock.calls[0][0].sender.name).toBe('Carolina');
  });

  test('reaction ✅ no admin-orin é ACEITA (não reaction_other_channel) + canal propagado', async () => {
    const adminDb = {
      query: jest.fn((sql) => {
        if (/FROM v3\.persons/.test(String(sql))) {
          return Promise.resolve({ rows: [{ id: 1, role: 'owner' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    const confirmAndExecute = jest.fn().mockResolvedValue({ handled: true, result: 'executed' });
    const d = deps(adminDb, { commandHandler: { confirmAndExecute } });
    const r = await handleEvent({
      type: 'event_callback',
      event: {
        type: 'reaction_added', reaction: 'white_check_mark', user: 'U03URLL1D4L',
        item: { type: 'message', channel: ADMIN, ts: 'carolina.reply.1' },
      },
    }, d);
    expect(r.action).toBe('reaction_confirm');
    expect(r.reason).not.toBe('reaction_other_channel');
    expect(confirmAndExecute).toHaveBeenCalledTimes(1);
    expect(confirmAndExecute.mock.calls[0][0].channel).toBe(ADMIN); // canal de origem propagado
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
