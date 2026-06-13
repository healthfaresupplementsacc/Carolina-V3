'use strict';
/* Fase 4 — forgotten checkout: worker DM (dedup + fallback) e endpoint resolve
   (still_working true mantém; false faz cascade: fecha tasks + logout + agenda DM + alerta admin). */
const express = require('express');
const { createOpRouter } = require('../routes/op');
const { CarolinaForgottenDM } = require('../workers/carolina-forgotten-dm');
const opAuth = require('../lib/op-auth');

const resp = (rows) => ({ rows, rowCount: rows.length });
const TOKEN = 'page-token';

// ── worker ────────────────────────────────────────────────────────────────
describe('Fase 4 — CarolinaForgottenDM worker', () => {
  function makeWorkerDb(rows) {
    const updated = []; const audits = [];
    return {
      updated, audits,
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/FROM v3\.forgotten_checkouts fc JOIN v3\.persons p/.test(s)) return resp(rows.filter((r) => !r._sent));
        if (/UPDATE v3\.forgotten_checkouts SET carolina_dm_sent_at = NOW\(\)/.test(s)) { const r = rows.find((x) => x.id === params[0]); if (r) r._sent = true; updated.push(params[0]); return resp([]); }
        if (/INSERT INTO v3\.audit_log/.test(s)) { const m = s.match(/'(carolina_forgotten_dm_sent)'/); audits.push(m ? m[1] : params[1]); return resp([]); }
        return resp([]);
      },
    };
  }
  test('manda DM pra quem tem slack_user_id + marca enviado (dedup)', async () => {
    const rows = [{ id: 1, person_id: 5, display_name: 'Ana', slack_user_id: 'U_ANA', last_task_description: 'linha' }];
    const db = makeWorkerDb(rows);
    const posts = [];
    const w = new CarolinaForgottenDM({ db, slack: { postAs: async (o) => { posts.push(o); return { ts: 'x' }; } } });
    await w.tick();
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe('U_ANA');      // DM direto
    expect(posts[0].sender).toEqual({ name: 'Carolina' });
    expect(db.updated).toEqual([1]);
    expect(db.audits).toContain('carolina_forgotten_dm_sent');
    // 2ª tick não reenvia
    posts.length = 0;
    await w.tick();
    expect(posts).toHaveLength(0);
  });
  test('sem slack_user_id → fallback no canal de orders', async () => {
    const rows = [{ id: 2, person_id: 7, display_name: 'Bruno Sarmento', slack_user_id: null, last_task_description: 'cleaning' }];
    const db = makeWorkerDb(rows);
    const posts = [];
    const w = new CarolinaForgottenDM({ db, slack: { postAs: async (o) => { posts.push(o); return {}; } }, ordersChannel: 'C_ORDERS' });
    await w.tick();
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe('C_ORDERS');
    expect(posts[0].text).toContain('Bruno Sarmento');
  });
});

// ── resolve endpoint ────────────────────────────────────────────────────────
describe('Fase 4 — resolve forgotten checkout', () => {
  let server, base, mem;
  function makeDb(mem) {
    return { query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) { mem.audits.push(params[1]); return resp([]); }
      // login
      if (/FROM v3\.persons WHERE role = 'operator' AND active = true AND deleted_at IS NULL AND pin_hash IS NOT NULL/.test(s)) return resp(mem.persons.filter((p) => p.pin_hash));
      if (/INSERT INTO v3\.operator_sessions/.test(s)) { mem.sessions.push({ id: 1, person_id: params[0], session_token: params[1], logged_out_at: null }); return resp([{ id: 1, person_id: params[0], session_token: params[1], created_at: new Date() }]); }
      if (/UPDATE v3\.persons SET last_page_login_at/.test(s)) return resp([]);
      // detect (login) → sem suspeitos
      if (/SELECT s\.person_id, p\.display_name, to_char\(sched\.expected_end_time/.test(s)) return resp([]);
      // requireSession
      if (/FROM v3\.operator_sessions s JOIN v3\.persons p ON p\.id = s\.person_id WHERE s\.session_token/.test(s)) {
        const sess = mem.sessions.find((x) => x.session_token === params[0] && !x.logged_out_at);
        if (!sess) return resp([]);
        const p = mem.persons.find((x) => x.id === sess.person_id);
        return resp([{ session_id: sess.id, person_id: p.id, last_activity_at: new Date(), display_name: p.display_name, role: p.role, active: true, auto_logoff_seconds: null, count_exempt: false }]);
      }
      if (/UPDATE v3\.operator_sessions SET last_activity_at = NOW\(\) WHERE person_id/.test(s)) { mem.kept.push(params[0]); return resp([]); }
      // suspect info
      if (/SELECT p\.display_name, p\.slack_user_id, s2\.last_activity_at/.test(s)) {
        const p = mem.persons.find((x) => x.id === params[0]);
        return resp(p ? [{ display_name: p.display_name, slack_user_id: p.slack_user_id, last_activity_at: new Date('2026-06-13T20:00:00Z'), expected_end_time: '17:00', last_task: 'Linha', last_product: 'Berberine', batch_number: '0203', last_activity_edt: '06-13 04:00 PM' }] : []);
      }
      if (/UPDATE v3\.events SET ended_at = COALESCE\(\$2, NOW\(\)\), closed_reason = 'forgotten_checkout_cascade'/.test(s)) { mem.closedEventsFor.push(params[0]); return resp([]); }
      if (/UPDATE v3\.operator_sessions SET logged_out_at = COALESCE\(\$2, NOW\(\)\), logoff_reason = 'forgotten_checkout_cascade'/.test(s)) { mem.loggedOut.push(params[0]); return resp([]); }
      if (/INSERT INTO v3\.forgotten_checkouts .* auto_logout_at, carolina_dm_scheduled_for/.test(s)) { mem.fc.push({ resolution: 'auto_logout', person_id: params[0] }); return resp([{ id: 99, dm_edt: '06-14 08:30 AM' }]); }
      if (/INSERT INTO v3\.forgotten_checkouts .* resolved_at, resolution\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, NOW\(\), 'still_working'\)/.test(s)) { mem.fc.push({ resolution: 'still_working', person_id: params[0] }); return resp([]); }
      return resp([]);
    } };
  }
  async function login() {
    const r = await fetch(base + '/api/v3/op/auth/login', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1234' }) });
    return (await r.json()).session_token;
  }
  async function resolve(tok, body) {
    const r = await fetch(base + '/api/v3/op/forgotten-checkout/resolve', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'X-Session-Token': tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  }

  beforeEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    const ph = opAuth.hashPin('1234');
    mem = { persons: [
      { id: 4, display_name: 'Vitor', role: 'operator', pin_hash: ph.pin_hash, pin_salt: ph.pin_salt, slack_user_id: null },
      { id: 5, display_name: 'Ana', role: 'operator', pin_hash: null, slack_user_id: 'U_ANA' },
    ], sessions: [], audits: [], kept: [], closedEventsFor: [], loggedOut: [], fc: [], posts: [] };
    const slack = { postAs: async (o) => { mem.posts.push(o); return { ts: 'x' }; } };
    const app = express();
    app.use('/', createOpRouter({ db: makeDb(mem), slack, operatorToken: TOKEN, adminChannelId: 'C_ADMIN' }));
    server = await new Promise((resolve2) => { const x = app.listen(0, '127.0.0.1', () => resolve2(x)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

  test('still_working=true → mantém logado + registra still_working', async () => {
    const tok = await login();
    const r = await resolve(tok, { person_id: 5, still_working: true, discovered_via: 'login' });
    expect(r.status).toBe(200);
    expect(r.body.kept).toBe(true);
    expect(mem.kept).toContain(5);
    expect(mem.fc.some((x) => x.resolution === 'still_working' && x.person_id === 5)).toBe(true);
  });
  test('still_working=false → cascade: fecha tasks + logout + agenda DM + alerta admin', async () => {
    const tok = await login();
    const r = await resolve(tok, { person_id: 5, still_working: false, discovered_via: 'login' });
    expect(r.status).toBe(200);
    expect(r.body.logged_out).toBe(true);
    expect(r.body.dm_scheduled_for).toBe('06-14 08:30 AM');
    expect(mem.closedEventsFor).toContain(5);
    expect(mem.loggedOut).toContain(5);
    expect(mem.fc.some((x) => x.resolution === 'auto_logout' && x.person_id === 5)).toBe(true);
    const alert = mem.posts.find((p) => p.channel === 'C_ADMIN');
    expect(alert).toBeTruthy();
    expect(alert.text).toContain('Forgotten checkout');
    expect(alert.text).toContain('Ana');
  });
  test('resolve do próprio usuário → 400 bad_person', async () => {
    const tok = await login();
    const r = await resolve(tok, { person_id: 4, still_working: false });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_person');
  });
});
