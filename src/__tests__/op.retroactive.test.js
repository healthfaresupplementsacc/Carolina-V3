'use strict';
/* Parte B — retroactive check-in. Operador (só hoje) + admin (7d + justificativa). */
const express = require('express');
const { createOpRouter } = require('../routes/op');
const { createAdminRouter } = require('../routes/admin');
const opAuth = require('../lib/op-auth');

const resp = (rows) => ({ rows, rowCount: rows.length });
const TOKEN = 'page-token';
const PW = 'emergency-pw';
// Clock FIXO (13:00 EDT = 17:00 UTC) — mantém os testes determinísticos perto
// da meia-noite EDT (senão "hoursAgo(1.5)" vira ONTEM e quebra o same_day).
const NOW = Date.parse('2026-06-17T17:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const hoursAhead = (h) => new Date(NOW + h * 3600 * 1000).toISOString();

// ── operador ────────────────────────────────────────────────────────────────
describe('Parte B — operador retroactive (/api/v3/op/event/retroactive)', () => {
  let server, base, mem;
  function makeDb(mem) {
    return { query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) { mem.audits.push({ action: params[1] }); return resp([]); }
      if (/FROM v3\.persons WHERE role = 'operator' AND active = true AND deleted_at IS NULL AND pin_hash IS NOT NULL/.test(s)) return resp(mem.persons.filter((p) => p.pin_hash));
      if (/INSERT INTO v3\.operator_sessions/.test(s)) { mem.sessions.push({ token: params[1], person_id: params[0], logged_out_at: null }); return resp([{ id: 1, person_id: params[0], session_token: params[1], created_at: new Date() }]); }
      if (/UPDATE v3\.persons SET last_page_login_at/.test(s)) return resp([]);
      if (/SELECT s\.person_id, p\.display_name, to_char\(sched\.expected_end_time/.test(s)) return resp([]); // detect
      if (/FROM v3\.operator_sessions s JOIN v3\.persons p ON p\.id = s\.person_id WHERE s\.session_token/.test(s)) {
        const x = mem.sessions.find((y) => y.token === params[0] && !y.logged_out_at); if (!x) return resp([]);
        const p = mem.persons.find((z) => z.id === x.person_id);
        return resp([{ session_id: 1, person_id: p.id, last_activity_at: new Date(), display_name: p.display_name, role: p.role, active: true, auto_logoff_seconds: null, count_exempt: false }]);
      }
      if (/FROM v3\.activity_types WHERE slug = \$1/.test(s)) return resp(mem.acts.filter((a) => a.slug === params[0]));
      if (/FROM v3\.product_batches pb LEFT JOIN v3\.products pr/.test(s)) return resp([]);
      // time validation (operador: same_day)
      if (/AS not_future,.*AS same_day,.*AS end_ok/.test(s)) {
        const st = Date.parse(params[0]); const en = params[1] ? Date.parse(params[1]) : null; const now = NOW;
        return resp([{
          not_future: st <= now,
          same_day: new Date(st).toDateString() === new Date(now).toDateString(),
          end_ok: en == null || (en > st && en <= now),
        }]);
      }
      if (/INSERT INTO v3\.events .* 'operator_page_retroactive'/.test(s)) { mem.inserted.push({ person: params[0], started: params[3], ended: params[4] }); return resp([{ id: 555, started_at: params[3], ended_at: params[4] }]); }
      if (/SELECT ROUND\(EXTRACT\(EPOCH FROM \(NOW\(\) - \$1/.test(s)) return resp([{ g: 90 }]);
      return resp([]);
    } };
  }
  beforeEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    const ph = opAuth.hashPin('1234');
    mem = { persons: [{ id: 4, display_name: 'Vitor', role: 'operator', pin_hash: ph.pin_hash, pin_salt: ph.pin_salt }],
      sessions: [], audits: [], inserted: [],
      acts: [{ id: 10, slug: 'cleaning', requires_product: false, active: true }, { id: 16, slug: 'break', requires_product: false, active: true }] };
    const app = express();
    app.use('/', createOpRouter({ db: makeDb(mem), slack: { postAs: () => {} }, operatorToken: TOKEN, adminChannelId: 'C_ADMIN' }));
    server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });
  async function login() { const r = await fetch(base + '/api/v3/op/auth/login', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1234' }) }); return (await r.json()).session_token; }
  async function retro(tok, body) { const r = await fetch(base + '/api/v3/op/event/retroactive', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'X-Session-Token': tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j }; }

  test('hoje + válido → 200 + audit retroactive_create', async () => {
    const tok = await login();
    const r = await retro(tok, { activity_slug: 'cleaning', started_at: hoursAgo(1.5), ended_at: hoursAgo(0.5) });
    expect(r.status).toBe(200);
    expect(r.body.event_id).toBe(555);
    expect(mem.audits.some((a) => a.action === 'event.retroactive_create')).toBe(true);
  });
  test('started_at futuro → 400', async () => {
    const tok = await login();
    expect((await retro(tok, { activity_slug: 'cleaning', started_at: hoursAhead(1) })).body.error).toBe('started_at_future');
  });
  test('started_at de ontem → 400 started_at_not_today', async () => {
    const tok = await login();
    expect((await retro(tok, { activity_slug: 'cleaning', started_at: hoursAgo(30) })).body.error).toBe('started_at_not_today');
  });
  test('ended antes de started → 400', async () => {
    const tok = await login();
    expect((await retro(tok, { activity_slug: 'cleaning', started_at: hoursAgo(1), ended_at: hoursAgo(2) })).body.error).toBe('ended_at_invalid');
  });
  test('slug note_required sem nota → 400', async () => {
    const tok = await login();
    expect((await retro(tok, { activity_slug: 'break', started_at: hoursAgo(1) })).body.error).toBe('note_required');
  });
});

// ── admin ─────────────────────────────────────────────────────────────────
describe('Parte B — admin retroactive (/api/adminpanel/operators/:id/retroactive-event)', () => {
  let server, base, mem, token;
  function makeDb(mem) {
    return { query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) { mem.audits.push({ action: params[0], metadata: params[3] }); return resp([]); }
      if (/COUNT\(\*\)::int n FROM v3\.admin_users WHERE is_active = true/.test(s)) return resp([{ n: 0 }]); // emergência
      if (/FROM v3\.admin_sessions s JOIN v3\.admin_users u/.test(s)) return resp([]);
      if (/FROM v3\.activity_types WHERE slug = \$1 AND active = true/.test(s)) return resp([{ id: 10, slug: 'cleaning' }]);
      if (/SELECT slug, display_name, requires_product, category FROM v3\.activity_types WHERE active = true/.test(s)) return resp([{ slug: 'cleaning', display_name: 'Limpeza', requires_product: false, category: 'support' }]);
      if (/AS not_future,.*AS within_7d,.*AS end_ok/.test(s)) {
        const st = Date.parse(params[0]); const en = params[1] ? Date.parse(params[1]) : null; const now = NOW;
        return resp([{ not_future: st <= now, within_7d: st >= now - 7 * 864e5, end_ok: en == null || (en > st && en <= now) }]);
      }
      if (/INSERT INTO v3\.events .* 'admin_retroactive'/.test(s)) { mem.inserted.push({ person: params[0] }); return resp([{ id: 777 }]); }
      return resp([]);
    } };
  }
  beforeEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    mem = { audits: [], inserted: [] };
    const app = express();
    app.use('/', createAdminRouter({ db: makeDb(mem), slack: { postAs: () => {} }, adminPassword: PW }));
    server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(base + '/api/adminpanel/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) });
    token = (await r.json()).token;
  });
  afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });
  async function add(body) { const r = await fetch(base + '/api/adminpanel/operators/5/retroactive-event', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j }; }

  test('válido (3 dias atrás) + justificativa → 200 + audit by_admin', async () => {
    const r = await add({ activity_slug: 'cleaning', started_at: hoursAgo(72), ended_at: hoursAgo(71), admin_justification: 'sistema nao registrou check-in da Ana' });
    expect(r.status).toBe(200);
    expect(r.body.event_id).toBe(777);
    const a = mem.audits.find((x) => x.action === 'event.retroactive_create_by_admin');
    expect(a).toBeTruthy();
    expect(a.metadata).toContain('justification');
  });
  test('sem justificativa → 400', async () => {
    expect((await add({ activity_slug: 'cleaning', started_at: hoursAgo(2) })).body.error).toBe('justification_required');
  });
  test('mais de 7 dias atrás → 400 too_old', async () => {
    expect((await add({ activity_slug: 'cleaning', started_at: hoursAgo(24 * 8), admin_justification: 'x' })).body.error).toBe('too_old');
  });
  test('GET activity-types SEM token → 401 (gated)', async () => {
    const r = await fetch(base + '/api/adminpanel/activity-types');
    expect(r.status).toBe(401);
  });
  test('GET activity-types COM token → 200', async () => {
    const r = await fetch(base + '/api/adminpanel/activity-types', { headers: { Authorization: 'Bearer ' + token } });
    expect(r.status).toBe(200);
    expect((await r.json()).activities[0].slug).toBe('cleaning');
  });
});
