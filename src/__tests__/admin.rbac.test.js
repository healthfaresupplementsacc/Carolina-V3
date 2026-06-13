'use strict';
/* Fase 1 — RBAC: login por PIN, roles owner/manager, sessões DB, owner-only
   endpoints, guard do último owner, fallback de emergência.
   PINs FICTÍCIOS (não os reais de produção — esses ficam só em env var). */
const express = require('express');
const { createAdminRouter } = require('../routes/admin');
const opAuth = require('../lib/op-auth');

const PW = 'emergency-pw';
const resp = (rows) => ({ rows, rowCount: rows.length });
const OWNER_PIN = '111111';   // fictício
const MANAGER_PIN = '222222'; // fictício

function makeMem() {
  const o = opAuth.hashPin(OWNER_PIN);
  const m = opAuth.hashPin(MANAGER_PIN);
  return {
    admins: [
      { id: 1, name: 'Owner Test', role: 'owner', pin_hash: o.pin_hash, pin_salt: o.pin_salt, slack_user_id: 'U_O', is_active: true, last_login_at: null },
      { id: 2, name: 'Manager Test', role: 'manager', pin_hash: m.pin_hash, pin_salt: m.pin_salt, slack_user_id: 'U_M', is_active: true, last_login_at: null },
    ],
    sessions: [], audits: [], seq: 1,
  };
}

function makeDb(mem) {
  return {
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) { mem.audits.push({ action: params[0], target_id: params[2] }); return resp([]); }
      if (/SELECT COUNT\(\*\)::int n FROM v3\.admin_users WHERE is_active = true/.test(s)) {
        return resp([{ n: mem.admins.filter((a) => a.is_active).length }]);
      }
      if (/SELECT COUNT\(\*\)::int n FROM v3\.admin_users WHERE role = 'owner' AND is_active = true/.test(s)) {
        return resp([{ n: mem.admins.filter((a) => a.is_active && a.role === 'owner').length }]);
      }
      if (/SELECT id, name, role, pin_hash, pin_salt FROM v3\.admin_users WHERE is_active = true/.test(s)) {
        return resp(mem.admins.filter((a) => a.is_active));
      }
      if (/INSERT INTO v3\.admin_sessions/.test(s)) {
        mem.sessions.push({ id: mem.seq++, admin_user_id: params[0], session_token: params[1], expires_at: params[4], logged_out_at: null });
        return resp([]);
      }
      if (/UPDATE v3\.admin_users SET last_login_at/.test(s)) return resp([]);
      if (/FROM v3\.admin_sessions s JOIN v3\.admin_users u/.test(s)) {
        const sess = mem.sessions.find((x) => x.session_token === params[0] && !x.logged_out_at && new Date(x.expires_at) > new Date());
        if (!sess) return resp([]);
        const u = mem.admins.find((a) => a.id === sess.admin_user_id && a.is_active);
        if (!u) return resp([]);
        return resp([{ session_id: sess.id, admin_user_id: u.id, name: u.name, role: u.role }]);
      }
      if (/UPDATE v3\.admin_sessions SET last_activity_at/.test(s)) return resp([]);
      if (/UPDATE v3\.admin_sessions SET logged_out_at = NOW\(\) WHERE session_token/.test(s)) {
        const sess = mem.sessions.find((x) => x.session_token === params[0]); if (sess) sess.logged_out_at = new Date(); return resp([]);
      }
      if (/UPDATE v3\.admin_sessions SET logged_out_at = NOW\(\) WHERE admin_user_id/.test(s)) {
        mem.sessions.filter((x) => x.admin_user_id === params[0] && !x.logged_out_at).forEach((x) => { x.logged_out_at = new Date(); }); return resp([]);
      }
      if (/SELECT u\.id, u\.name, u\.role, u\.slack_user_id/.test(s)) {
        return resp(mem.admins.map((a) => ({ id: a.id, name: a.name, role: a.role, slack_user_id: a.slack_user_id, email: null, is_active: a.is_active, last_login_edt: null, active_session_count: mem.sessions.filter((x) => x.admin_user_id === a.id && !x.logged_out_at).length })));
      }
      if (/SELECT id FROM v3\.admin_users WHERE id = \$1/.test(s)) {
        const a = mem.admins.find((x) => x.id === params[0]); return resp(a ? [{ id: a.id }] : []);
      }
      if (/SELECT id, pin_hash, pin_salt FROM v3\.admin_users WHERE is_active = true AND id <> \$1/.test(s)) {
        return resp(mem.admins.filter((a) => a.is_active && a.id !== params[0]));
      }
      if (/UPDATE v3\.admin_users SET pin_hash = \$2, pin_salt = \$3/.test(s)) {
        const a = mem.admins.find((x) => x.id === params[0]); if (a) { a.pin_hash = params[1]; a.pin_salt = params[2]; } return resp([]);
      }
      if (/SELECT role, is_active FROM v3\.admin_users WHERE id = \$1/.test(s)) {
        const a = mem.admins.find((x) => x.id === params[0]); return resp(a ? [{ role: a.role, is_active: a.is_active }] : []);
      }
      if (/UPDATE v3\.admin_users SET role = \$2/.test(s)) {
        const a = mem.admins.find((x) => x.id === params[0]); if (a) a.role = params[1]; return resp([]);
      }
      if (/UPDATE v3\.admin_users SET is_active = \$2/.test(s)) {
        const a = mem.admins.find((x) => x.id === params[0]); if (a) a.is_active = params[1]; return resp([]);
      }
      return resp([]);
    }),
  };
}

let server, base, mem;
async function call(method, path, body, tok) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (tok) headers.Authorization = 'Bearer ' + tok;
  const r = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
const login = async (creds) => (await call('POST', '/api/adminpanel/auth/login', creds));

beforeEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  mem = makeMem();
  const app = express();
  app.use('/', createAdminRouter({ db: makeDb(mem), slack: { postAs: jest.fn() }, adminPassword: PW }));
  server = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('Fase 1 — RBAC login', () => {
  test('PIN owner → token + role=owner', async () => {
    const r = await login({ pin: OWNER_PIN });
    expect(r.status).toBe(200);
    expect(r.body.admin.role).toBe('owner');
    expect(r.body.token).toBeTruthy();
  });
  test('PIN manager → role=manager', async () => {
    const r = await login({ pin: MANAGER_PIN });
    expect(r.status).toBe(200);
    expect(r.body.admin.role).toBe('manager');
  });
  test('PIN inválido → 401 wrong_pin', async () => {
    const r = await login({ pin: '999999' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('wrong_pin');
  });
  test('senha de emergência DESATIVADA quando há admins → 401 password_disabled', async () => {
    const r = await login({ password: PW });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('password_disabled');
  });
});

describe('Fase 1 — RBAC autorização', () => {
  test('manager GET /admins → 403', async () => {
    const tok = (await login({ pin: MANAGER_PIN })).body.token;
    const r = await call('GET', '/api/adminpanel/admins', undefined, tok);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
  });
  test('owner GET /admins → 200 lista', async () => {
    const tok = (await login({ pin: OWNER_PIN })).body.token;
    const r = await call('GET', '/api/adminpanel/admins', undefined, tok);
    expect(r.status).toBe(200);
    expect(r.body.admins).toHaveLength(2);
    expect(r.body.me.role).toBe('owner');
    // não vaza hash/salt
    expect(JSON.stringify(r.body)).not.toMatch(/pin_hash|pin_salt/);
  });
  test('owner muda PIN de outro admin → OK + audit', async () => {
    const tok = (await login({ pin: OWNER_PIN })).body.token;
    const r = await call('POST', '/api/adminpanel/admins/2/pin', { pin: '333333' }, tok);
    expect(r.status).toBe(200);
    expect(opAuth.verifyPin('333333', mem.admins[1].pin_salt, mem.admins[1].pin_hash)).toBe(true);
    expect(mem.audits.some((a) => a.action === 'admin_user.pin_changed')).toBe(true);
  });
  test('não muda a própria role → 400', async () => {
    const tok = (await login({ pin: OWNER_PIN })).body.token;
    const r = await call('PUT', '/api/adminpanel/admins/1/role', { role: 'manager' }, tok);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('cannot_change_own_role');
  });
  test('não desativa a si mesmo → 400', async () => {
    const tok = (await login({ pin: OWNER_PIN })).body.token;
    const r = await call('PUT', '/api/adminpanel/admins/1/active', { active: false }, tok);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('cannot_deactivate_self');
  });
  test('owner desativa o OUTRO owner quando há 2 → 200 (sobra 1)', async () => {
    const tok = (await login({ pin: OWNER_PIN })).body.token;
    await call('PUT', '/api/adminpanel/admins/2/role', { role: 'owner' }, tok); // 2 owners
    const r = await call('PUT', '/api/adminpanel/admins/2/active', { active: false }, tok);
    expect(r.status).toBe(200);
  });
});

// Guard do "último owner" em isolamento: db reporta 1 owner ativo e o alvo
// (id2, != logado) é owner ativo → desativar deve dar 400 last_owner.
describe('Fase 1 — guard last_owner (branch isolado)', () => {
  test('desativar quando só há 1 owner ativo → 400 last_owner', async () => {
    const o = opAuth.hashPin(OWNER_PIN);
    const sessions = [];
    const db = { query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) return resp([]);
      if (/SELECT COUNT\(\*\)::int n FROM v3\.admin_users WHERE is_active = true/.test(s)) return resp([{ n: 2 }]);
      if (/SELECT id, name, role, pin_hash, pin_salt FROM v3\.admin_users WHERE is_active = true/.test(s)) {
        return resp([{ id: 1, name: 'O', role: 'owner', pin_hash: o.pin_hash, pin_salt: o.pin_salt }]);
      }
      if (/INSERT INTO v3\.admin_sessions/.test(s)) { sessions.push({ token: params[1], admin_user_id: params[0], expires_at: params[4] }); return resp([]); }
      if (/UPDATE v3\.admin_users SET last_login_at/.test(s)) return resp([]);
      if (/FROM v3\.admin_sessions s JOIN v3\.admin_users u/.test(s)) {
        const x = sessions.find((y) => y.token === params[0]); return x ? resp([{ session_id: 1, admin_user_id: 1, name: 'O', role: 'owner' }]) : resp([]);
      }
      if (/UPDATE v3\.admin_sessions SET last_activity_at/.test(s)) return resp([]);
      // alvo id2 é owner ativo, mas só há 1 owner segundo a contagem:
      if (/SELECT role, is_active FROM v3\.admin_users WHERE id = \$1/.test(s)) return resp([{ role: 'owner', is_active: true }]);
      if (/SELECT COUNT\(\*\)::int n FROM v3\.admin_users WHERE role = 'owner' AND is_active = true/.test(s)) return resp([{ n: 1 }]);
      return resp([]);
    } };
    const app = express();
    app.use('/', createAdminRouter({ db, slack: { postAs: jest.fn() }, adminPassword: PW }));
    const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const b = `http://127.0.0.1:${srv.address().port}`;
    const lr = await fetch(b + '/api/adminpanel/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: OWNER_PIN }) });
    const tok = (await lr.json()).token;
    const r = await fetch(b + '/api/adminpanel/admins/2/active', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ active: false }) });
    const j = await r.json();
    expect(r.status).toBe(400);
    expect(j.error).toBe('last_owner');
    await new Promise((x) => srv.close(x));
  });
});
