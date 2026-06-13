'use strict';
/* Tests do DedupeWatcher (cron Slack↔página) + NotificationHandler (✅/❌/📝). */
const { DedupeWatcher } = require('../workers/dedupe-watcher');
const { NotificationHandler } = require('../v3/services/NotificationHandler');
const { handleEvent } = require('../v3/slack/events-v2');

const resp = (rows) => ({ rows, rowCount: rows.length });

// fake db com estado pro dedupe
function makeDedupeDb({ slackEvents = [], pageEvents = [] } = {}) {
  const mem = { links: [], notifications: [], audits: [], updates: [], notifSeq: 1 };
  const db = {
    mem,
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) { mem.audits.push({ action: params[0], target: params[1], meta: JSON.parse(params[2]) }); return resp([]); }
      if (/FROM v3\.events e JOIN v3\.persons p/.test(s)) {
        // candidatos slack (filtra os já linkados/notificados como o SQL real faria)
        return resp(slackEvents.filter((e) =>
          !mem.links.some((l) => l.slack === e.id)
          && !e.superseded
          && !mem.notifications.some((n) => n.payload.slack_event_id === e.id)));
      }
      if (/FROM v3\.events pg WHERE pg\.source = 'operator_page'/.test(s)) {
        const [personId, actId, startedAt, batchId] = params;
        const hit = pageEvents.find((p) =>
          p.person_id === personId && p.activity_type_id === actId
          && Math.abs((p.started_at_epoch || 0) - (new Date(startedAt).getTime() / 1000)) <= 120
          && (batchId == null || p.product_batch_id == null || p.product_batch_id === batchId)
          && !mem.links.some((l) => l.page === p.id));
        return resp(hit ? [{ id: hit.id }] : []);
      }
      if (/INSERT INTO v3\.dedupe_links/.test(s)) { mem.links.push({ slack: params[0], page: params[1] }); return resp([]); }
      if (/UPDATE v3\.events SET superseded_by_event_id/.test(s)) {
        const ev = slackEvents.find((e) => e.id === params[0]);
        if (ev) ev.superseded = params[1];
        return resp([]);
      }
      if (/INSERT INTO v3\.notifications/.test(s)) {
        const n = { id: mem.notifSeq++, payload: JSON.parse(params[0]), status: 'pending', carolina_slack_ts: null };
        mem.notifications.push(n);
        return resp([{ id: n.id }]);
      }
      if (/UPDATE v3\.notifications SET carolina_slack_ts/.test(s)) {
        const n = mem.notifications.find((x) => x.id === params[0]);
        if (n) n.carolina_slack_ts = params[1];
        return resp([]);
      }
      return resp([]);
    }),
  };
  return db;
}

const mkSlackEv = (over = {}) => ({
  id: 900, person_id: 4, activity_type_id: 5, product_batch_id: 39,
  started_at: new Date('2026-06-12T15:00:00Z').toISOString(),
  description: 'S: Iniciando linha de producao Glycinate 0190',
  display_name: 'Vitor', slug: 'production_line', batch_number: 'BR-2026-0190',
  age_s: 300, superseded: null, ...over,
});

describe('DedupeWatcher', () => {
  test('MATCH: cria dedupe_link + marca superseded + audit dedupe_worker', async () => {
    const slackEv = mkSlackEv();
    const db = makeDedupeDb({
      slackEvents: [slackEv],
      pageEvents: [{ id: 800, person_id: 4, activity_type_id: 5, product_batch_id: 39, started_at_epoch: new Date('2026-06-12T15:01:00Z').getTime() / 1000 }],
    });
    const slack = { postAs: jest.fn() };
    const w = new DedupeWatcher({ db, slack, adminChannelId: 'C_ADMIN' });
    const r = await w.tick();
    expect(r.matched).toBe(1);
    expect(db.mem.links[0]).toEqual({ slack: 900, page: 800 });
    expect(slackEv.superseded).toBe(800);
    expect(db.mem.audits.some((a) => a.action === 'dedupe_matched')).toBe(true);
    expect(slack.postAs).not.toHaveBeenCalled(); // match não notifica
  });

  test('MATCH respeita batch: batch diferente NÃO casa → notifica órfão', async () => {
    const db = makeDedupeDb({
      slackEvents: [mkSlackEv()],
      pageEvents: [{ id: 801, person_id: 4, activity_type_id: 5, product_batch_id: 44, started_at_epoch: new Date('2026-06-12T15:00:30Z').getTime() / 1000 }],
    });
    const slack = { postAs: jest.fn(async () => ({ ts: 'caro.1' })) };
    const w = new DedupeWatcher({ db, slack, adminChannelId: 'C_ADMIN' });
    const r = await w.tick();
    expect(r.matched).toBe(0);
    expect(r.notified).toBe(1);
  });

  test('batch NULL em um dos lados casa', async () => {
    const db = makeDedupeDb({
      slackEvents: [mkSlackEv({ product_batch_id: null, batch_number: null })],
      pageEvents: [{ id: 802, person_id: 4, activity_type_id: 5, product_batch_id: 39, started_at_epoch: new Date('2026-06-12T15:00:10Z').getTime() / 1000 }],
    });
    const w = new DedupeWatcher({ db, slack: { postAs: jest.fn() }, adminChannelId: 'C_ADMIN' });
    expect((await w.tick()).matched).toBe(1);
  });

  test('ÓRFÃO ≥120s: notification + Carolina posta no admin (top-level, sender.name) + salva ts', async () => {
    const db = makeDedupeDb({ slackEvents: [mkSlackEv({ age_s: 200 })], pageEvents: [] });
    const slack = { postAs: jest.fn(async () => ({ ts: 'caro.99' })) };
    const w = new DedupeWatcher({ db, slack, adminChannelId: 'C_ADMIN' });
    const r = await w.tick();
    expect(r.notified).toBe(1);
    expect(db.mem.notifications[0].payload.slack_event_id).toBe(900);
    expect(db.mem.notifications[0].carolina_slack_ts).toBe('caro.99');
    const call = slack.postAs.mock.calls[0][0];
    expect(call.channel).toBe('C_ADMIN');
    expect(call.sender).toEqual({ name: 'Carolina' });
    expect(call.thread_ts).toBeNull();
    expect(call.text).toContain('Vitor');
    expect(call.text).toContain('✅');
  });

  test('órfão NOVO (<120s) espera (página ainda pode registrar)', async () => {
    const db = makeDedupeDb({ slackEvents: [mkSlackEv({ age_s: 45 })], pageEvents: [] });
    const slack = { postAs: jest.fn() };
    const w = new DedupeWatcher({ db, slack, adminChannelId: 'C_ADMIN' });
    const r = await w.tick();
    expect(r.notified).toBe(0);
    expect(slack.postAs).not.toHaveBeenCalled();
  });

  test('já notificado não duplica no próximo tick', async () => {
    const db = makeDedupeDb({ slackEvents: [mkSlackEv({ age_s: 200 })], pageEvents: [] });
    const slack = { postAs: jest.fn(async () => ({ ts: 'caro.1' })) };
    const w = new DedupeWatcher({ db, slack, adminChannelId: 'C_ADMIN' });
    await w.tick();
    const r2 = await w.tick();
    expect(r2.scanned).toBe(0); // candidato sumiu (notificado)
    expect(db.mem.notifications).toHaveLength(1);
  });
});

// ─── NotificationHandler ─────────────────────────────────────
function makeNotifDb({ notif } = {}) {
  const mem = { notif: notif || null, eventsDeleted: [], audits: [], updates: [] };
  return {
    mem,
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM v3\.notifications WHERE carolina_slack_ts/.test(s)) {
        return (mem.notif && mem.notif.carolina_slack_ts === params[0] && mem.notif.status === 'pending')
          ? resp([mem.notif]) : resp([]);
      }
      if (/UPDATE v3\.notifications SET status=/.test(s)) {
        const m = /status='(\w+)'/.exec(s);
        if (mem.notif && mem.notif.id === params[0]) { mem.notif.status = m[1]; mem.notif.admin_action_by = params[1]; }
        return resp([]);
      }
      if (/UPDATE v3\.events SET deleted_at = NOW\(\)/.test(s)) { mem.eventsDeleted.push({ id: params[0], by: params[1] }); return resp([]); }
      if (/INSERT INTO v3\.audit_log/.test(s)) { mem.audits.push({ person: params[0], action: params[1], target: params[2] }); return resp([]); }
      return resp([]);
    }),
  };
}
const NOTIF = () => ({ id: 7, type: 'slack_event_not_on_page', status: 'pending', carolina_slack_ts: 'caro.7', payload: { slack_event_id: 900, person: 'Vitor', slug: 'production_line', batch: 'BR-2026-0190' } });

describe('NotificationHandler — reações ✅/❌/📝', () => {
  test('✅ → admin_accepted + chat.update; event NÃO é apagado', async () => {
    const db = makeNotifDb({ notif: NOTIF() });
    const slack = { postAs: jest.fn(), updateMessage: jest.fn(async () => ({ ok: true })) };
    const h = new NotificationHandler({ db, slack, adminChannelId: 'C_ADMIN' });
    const r = await h.handleReaction({ carolinaMsgTs: 'caro.7', emoji: 'white_check_mark', reactorPersonId: 1, reactorName: 'Bruno Camp', channel: 'C_ADMIN' });
    expect(r).toEqual({ handled: true, action: 'accepted' });
    expect(db.mem.notif.status).toBe('admin_accepted');
    expect(db.mem.eventsDeleted).toHaveLength(0);
    expect(slack.updateMessage.mock.calls[0][0].text).toContain('✅ Aceito por Bruno Camp');
  });

  test('❌ → admin_rejected + soft-delete do slack event + chat.update', async () => {
    const db = makeNotifDb({ notif: NOTIF() });
    const slack = { postAs: jest.fn(), updateMessage: jest.fn(async () => ({ ok: true })) };
    const h = new NotificationHandler({ db, slack, adminChannelId: 'C_ADMIN' });
    const r = await h.handleReaction({ carolinaMsgTs: 'caro.7', emoji: 'x', reactorPersonId: 1, reactorName: 'Bruno Camp', channel: 'C_ADMIN' });
    expect(r.action).toBe('rejected');
    expect(db.mem.notif.status).toBe('admin_rejected');
    expect(db.mem.eventsDeleted[0]).toEqual({ id: 900, by: 1 });
    expect(slack.updateMessage.mock.calls[0][0].text).toContain('❌ Ignorado');
  });

  test('📝 → admin_edited + Carolina orienta usar @Carolina edit (texto do admin é a entrada)', async () => {
    const db = makeNotifDb({ notif: NOTIF() });
    const slack = { postAs: jest.fn(async () => ({ ts: 'x' })), updateMessage: jest.fn(async () => ({ ok: true })) };
    const h = new NotificationHandler({ db, slack, adminChannelId: 'C_ADMIN' });
    const r = await h.handleReaction({ carolinaMsgTs: 'caro.7', emoji: 'memo', reactorPersonId: 2, reactorName: 'Thassio', channel: 'C_ADMIN' });
    expect(r.action).toBe('edit_requested');
    expect(db.mem.notif.status).toBe('admin_edited');
    expect(slack.postAs.mock.calls[0][0].text).toContain('ev900');
    expect(slack.postAs.mock.calls[0][0].text).toContain('@Carolina');
  });

  test('sem notification pendente pro ts → handled false', async () => {
    const db = makeNotifDb({ notif: null });
    const h = new NotificationHandler({ db, slack: null, adminChannelId: 'C_ADMIN' });
    const r = await h.handleReaction({ carolinaMsgTs: 'nope', emoji: 'x', reactorPersonId: 1 });
    expect(r.handled).toBe(false);
  });
});

// ─── integração events-v2: reaction cai no notification path ──
describe('events-v2 — reaction roteia pra notification quando não é pending_command', () => {
  test('✅ sem pending_command → NotificationHandler resolve', async () => {
    const db = {
      query: jest.fn(async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (/FROM v3\.persons/.test(s)) return resp([{ id: 1, role: 'owner', display_name: 'Bruno Camp' }]);
        return resp([]);
      }),
    };
    const notificationHandler = { handleReaction: jest.fn(async () => ({ handled: true, action: 'accepted' })) };
    const commandHandler = { confirmAndExecute: jest.fn(async () => ({ handled: false, reason: 'no_pending_command' })) };
    const r = await handleEvent({
      type: 'event_callback',
      event: { type: 'reaction_added', reaction: 'white_check_mark', user: 'U_B', item: { type: 'message', channel: 'C0B36DR5MP1', ts: 'caro.7' } },
    }, { db, productionChannelId: 'C_PROD', adminChannelId: 'C0B36DR5MP1', commandHandler, notificationHandler, eventService: {} });
    expect(r).toEqual({ handled: true, action: 'notification_accepted' });
    expect(notificationHandler.handleReaction.mock.calls[0][0].emoji).toBe('white_check_mark');
  });

  test('📝 (memo) vai direto pro notification path', async () => {
    const db = { query: jest.fn(async (sql) => /FROM v3\.persons/.test(String(sql)) ? resp([{ id: 1, role: 'owner', display_name: 'B' }]) : resp([])) };
    const notificationHandler = { handleReaction: jest.fn(async () => ({ handled: true, action: 'edit_requested' })) };
    const r = await handleEvent({
      type: 'event_callback',
      event: { type: 'reaction_added', reaction: 'memo', user: 'U_B', item: { type: 'message', channel: 'C0B36DR5MP1', ts: 'caro.7' } },
    }, { db, productionChannelId: 'C_PROD', adminChannelId: 'C0B36DR5MP1', commandHandler: {}, notificationHandler, eventService: {} });
    expect(r.action).toBe('notification_edit_requested');
  });
});
