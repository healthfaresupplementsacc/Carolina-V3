'use strict';
/* Fase 6 — audit log filtrado por role + export CSV (owner only).
   Manager NÃO vê ações sensíveis (login admin, finance, role change).
   PINs fictícios. */
const express = require('express');
const { createAdminRouter } = require('../routes/admin');
const opAuth = require('../lib/op-auth');

const PW = 'emergency-pw';
const resp = (rows) => ({ rows, rowCount: rows.length });
const OWNER_PIN = '111111'; const MANAGER_PIN = '222222';

const AUDITS = [
  { id: 4, action: 'op_login_success', actor_type: 'operator_page', target_type: 'person', target_id: 4, metadata: {} },
  { id: 3, action: 'notification_accepted', actor_type: 'admin', target_type: 'notification', target_id: 7, metadata: {} },
  { id: 2, action: 'finance_calculation', actor_type: 'admin', target_type: 'person', target_id: 5, metadata: { range_days: 30 } },
  { id: 1, action: 'admin_user.role_changed', actor_type: 'admin', target_type: 'admin_user', target_id: 2, metadata: { new_role: 'owner' } },
];

function makeDb() {
  const admins = [
    { id: 1, name: 'Owner', role: 'owner', ...opAuth.hashPin(OWNER_PIN), is_active: true },
    { id: 2, name: 'Manager', role: 'manager', ...opAuth.hashPin(MANAGER_PIN), is_active: true },
  ];
  const sessions = [];
  const arrParam = (params) => params.find((p) => Array.isArray(p));
  return {
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) return resp([]);
      if (/COUNT\(\*\)::int n FROM v3\.admin_users WHERE is_active = true/.test(s)) return resp([{ n: admins.length }]);
      if (/SELECT id, name, role, pin_hash, pin_salt FROM v3\.admin_users WHERE is_active = true/.test(s)) return resp(admins);
      if (/INSERT INTO v3\.admin_sessions/.test(s)) { sessions.push({ token: params[1], admin_user_id: params[0], expires_at: params[4] }); return resp([]); }
      if (/UPDATE v3\.admin_users SET last_login_at/.test(s)) return resp([]);
      if (/FROM v3\.admin_sessions s JOIN v3\.admin_users u/.test(s)) {
        const x = sessions.find((y) => y.token === params[0]); if (!x) return resp([]);
        const u = admins.find((a) => a.id === x.admin_user_id);
        return resp([{ session_id: 1, admin_user_id: u.id, name: u.name, role: u.role }]);
      }
      if (/UPDATE v3\.admin_sessions SET last_activity_at/.test(s)) return resp([]);
      // audit list / csv
      if (/FROM v3\.audit_log a LEFT JOIN v3\.persons p/.test(s)) {
        let rows = AUDITS.slice();
        const arr = arrParam(params);
        if (arr && /<> ALL\(/.test(s)) rows = rows.filter((r) => !arr.includes(r.action));
        if (arr && /= ANY\(/.test(s)) rows = rows.filter((r) => arr.includes(r.action));
        if (/AS ts,/.test(s)) {
          // CSV shape
          return resp(rows.map((r) => ({ ts: '2026-06-13 10:00:00', actor_type: r.actor_type, actor_name: '', action: r.action, target_type: r.target_type || '', target_id: String(r.target_id || ''), metadata: JSON.stringify(r.metadata) })));
        }
        return resp(rows.map((r) => ({ ...r, actor_name: null, created_at: new Date().toISOString(), created_edt: '06-13 10:00:00 AM' })));
      }
      return resp([]);
    },
  };
}

let server, base;
async function call(method, path, tok, raw) {
  const headers = {}; if (tok) headers.Authorization = 'Bearer ' + tok;
  const r = await fetch(base + path, { method, headers });
  if (raw) return { status: r.status, text: await r.text(), ct: r.headers.get('content-type') };
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
async function login(pin) {
  const r = await fetch(base + '/api/adminpanel/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
  return (await r.json()).token;
}

beforeEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  const app = express();
  app.use('/', createAdminRouter({ db: makeDb(), slack: { postAs: () => {} }, adminPassword: PW }));
  server = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('Fase 6 — audit filtrado por role', () => {
  test('manager NÃO vê ações sensíveis', async () => {
    const tok = await login(MANAGER_PIN);
    const r = await call('GET', '/api/adminpanel/audit', tok);
    expect(r.status).toBe(200);
    const actions = r.body.entries.map((e) => e.action);
    expect(actions).toContain('op_login_success');
    expect(actions).not.toContain('finance_calculation');
    expect(actions).not.toContain('admin_user.role_changed');
  });
  test('owner vê TUDO', async () => {
    const tok = await login(OWNER_PIN);
    const r = await call('GET', '/api/adminpanel/audit', tok);
    const actions = r.body.entries.map((e) => e.action);
    expect(actions).toContain('finance_calculation');
    expect(actions).toContain('admin_user.role_changed');
    expect(r.body.entries).toHaveLength(4);
  });
  test('owner sensitive_only=1 → só sensíveis', async () => {
    const tok = await login(OWNER_PIN);
    const r = await call('GET', '/api/adminpanel/audit?sensitive_only=1', tok);
    const actions = r.body.entries.map((e) => e.action);
    expect(actions).toContain('finance_calculation');
    expect(actions).not.toContain('op_login_success');
  });
});

describe('Fase 6 — export CSV', () => {
  test('manager → 403', async () => {
    const tok = await login(MANAGER_PIN);
    expect((await call('GET', '/api/adminpanel/audit/export.csv', tok, true)).status).toBe(403);
  });
  test('owner → 200 text/csv com header', async () => {
    const tok = await login(OWNER_PIN);
    const r = await call('GET', '/api/adminpanel/audit/export.csv', tok, true);
    expect(r.status).toBe(200);
    expect(r.ct).toContain('text/csv');
    expect(r.text.split('\n')[0]).toContain('timestamp_edt');
    expect(r.text).toContain('finance_calculation'); // owner exporta sensíveis
  });
});
