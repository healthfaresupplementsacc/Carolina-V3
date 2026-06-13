'use strict';
/* Fase 5 — metrics: role gating (finance owner-only) + GUARD CRÍTICO G12/G13:
   salário NUNCA é gravado nem logado. PINs fictícios. */
const express = require('express');
const { createAdminRouter } = require('../routes/admin');
const opAuth = require('../lib/op-auth');

const PW = 'emergency-pw';
const resp = (rows) => ({ rows, rowCount: rows.length });
const OWNER_PIN = '111111';
const MANAGER_PIN = '222222';
const SALARY = 37.77; // valor sentinela — não pode aparecer em nenhum query/log

function makeMem() {
  const o = opAuth.hashPin(OWNER_PIN); const m = opAuth.hashPin(MANAGER_PIN);
  return {
    admins: [
      { id: 1, name: 'Owner', role: 'owner', pin_hash: o.pin_hash, pin_salt: o.pin_salt, is_active: true },
      { id: 2, name: 'Manager', role: 'manager', pin_hash: m.pin_hash, pin_salt: m.pin_salt, is_active: true },
    ],
    sessions: [], seq: 1, queries: [], audits: [],
  };
}
function makeDb(mem) {
  return {
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      mem.queries.push({ s, params }); // registra TUDO p/ auditar vazamento de salário
      if (/INSERT INTO v3\.audit_log/.test(s)) { mem.audits.push({ action: params[0], metadata: params[3] }); return resp([]); }
      if (/COUNT\(\*\)::int n FROM v3\.admin_users WHERE is_active = true/.test(s)) return resp([{ n: mem.admins.filter((a) => a.is_active).length }]);
      if (/SELECT id, name, role, pin_hash, pin_salt FROM v3\.admin_users WHERE is_active = true/.test(s)) return resp(mem.admins.filter((a) => a.is_active));
      if (/INSERT INTO v3\.admin_sessions/.test(s)) { mem.sessions.push({ token: params[1], admin_user_id: params[0], expires_at: params[4] }); return resp([]); }
      if (/UPDATE v3\.admin_users SET last_login_at/.test(s)) return resp([]);
      if (/FROM v3\.admin_sessions s JOIN v3\.admin_users u/.test(s)) {
        const x = mem.sessions.find((y) => y.token === params[0]); if (!x) return resp([]);
        const u = mem.admins.find((a) => a.id === x.admin_user_id && a.is_active);
        return u ? resp([{ session_id: 1, admin_user_id: u.id, name: u.name, role: u.role }]) : resp([]);
      }
      if (/UPDATE v3\.admin_sessions SET last_activity_at/.test(s)) return resp([]);
      // metrics
      if (/FROM v3\.operator_sessions s JOIN v3\.persons p ON p\.id=s\.person_id WHERE s\.logged_out_at IS NULL ORDER BY p\.display_name/.test(s)) return resp([]);
      if (/bottles_today/.test(s)) return resp([{ bottles_today: 100, orders_today: 5, hours_today: 8 }]);
      if (/e\.ended_at IS NULL AND e\.deleted_at IS NULL AND e\.is_long_running=false AND e\.started_at < NOW\(\) - INTERVAL '1 hour'/.test(s)) return resp([]);
      if (/FROM v3\.task_targets t LEFT JOIN v3\.events_enriched/.test(s)) return resp([{ slug: 'cleaning', target_minutes: 13, method_applied: 'method_3_hibrido', actual_avg: 20, n: 5 }]);
      // finance agg + bottles
      if (/SUM\(CASE WHEN NOT is_long_running THEN duration_min ELSE 0 END\)\/60\.0,2\) AS hours/.test(s)) return resp([{ hours: 10, tasks: 8, productive_min: 400, support_min: 200 }]);
      if (/SUM\(pc\.bottles\),0\)::int n FROM v3\.production_counts pc JOIN v3\.events e/.test(s)) return resp([{ n: 500 }]);
      return resp([]);
    }),
  };
}

let server, base, mem;
async function call(method, path, body, tok) {
  const headers = {}; if (body !== undefined) headers['Content-Type'] = 'application/json'; if (tok) headers.Authorization = 'Bearer ' + tok;
  const r = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
const login = async (pin) => (await call('POST', '/api/adminpanel/auth/login', { pin })).body.token;

beforeEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  mem = makeMem();
  const app = express();
  app.use('/', createAdminRouter({ db: makeDb(mem), slack: { postAs: jest.fn() }, adminPassword: PW }));
  server = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('Fase 5 — metrics role gating', () => {
  test('manager acessa /metrics/realtime → 200', async () => {
    const tok = await login(MANAGER_PIN);
    expect((await call('GET', '/api/adminpanel/metrics/realtime', undefined, tok)).status).toBe(200);
  });
  test('manager NÃO acessa finance → 403', async () => {
    const tok = await login(MANAGER_PIN);
    const r = await call('POST', '/api/adminpanel/metrics/financial/calculate', { person_id: 4, hourly_salary: SALARY, range_days: 30 }, tok);
    expect(r.status).toBe(403);
  });
  test('owner acessa finance → 200', async () => {
    const tok = await login(OWNER_PIN);
    const r = await call('POST', '/api/adminpanel/metrics/financial/calculate', { person_id: 4, hourly_salary: SALARY, range_days: 30 }, tok);
    expect(r.status).toBe(200);
    expect(r.body.total_cost).toBe(Math.round(10 * SALARY * 100) / 100);
    expect(r.body.cost_per_bottle).toBeGreaterThan(0);
  });
});

describe('Fase 5 — GUARD G12/G13: salário nunca persiste/loga', () => {
  test('nenhum query recebe o salário como parâmetro', async () => {
    const tok = await login(OWNER_PIN);
    mem.queries.length = 0; // zera; foca no request de finance
    await call('POST', '/api/adminpanel/metrics/financial/calculate', { person_id: 4, hourly_salary: SALARY, range_days: 30 }, tok);
    const leaked = mem.queries.filter((q) => (q.params || []).some((p) => p === SALARY || String(p).includes(String(SALARY))));
    expect(leaked).toHaveLength(0);
  });
  test('audit finance_calculation NÃO contém salário', async () => {
    const tok = await login(OWNER_PIN);
    await call('POST', '/api/adminpanel/metrics/financial/calculate', { person_id: 4, hourly_salary: SALARY, range_days: 30 }, tok);
    const fin = mem.audits.find((a) => a.action === 'finance_calculation');
    expect(fin).toBeTruthy();
    expect(fin.metadata).not.toContain(String(SALARY));
    expect(fin.metadata).not.toMatch(/salary|salario/i);
  });
  test('salário inválido → 400', async () => {
    const tok = await login(OWNER_PIN);
    expect((await call('POST', '/api/adminpanel/metrics/financial/calculate', { person_id: 4, hourly_salary: 0, range_days: 30 }, tok)).status).toBe(400);
  });
});

describe('Fase 5 — targets', () => {
  test('targets-comparison shape', async () => {
    const tok = await login(OWNER_PIN);
    const r = await call('GET', '/api/adminpanel/metrics/targets-comparison', undefined, tok);
    expect(r.status).toBe(200);
    expect(r.body.targets[0]).toHaveProperty('delta_pct');
  });
  test('aplicar target → audit task_target.changed', async () => {
    const tok = await login(OWNER_PIN);
    const r = await call('POST', '/api/adminpanel/metrics/targets/cleaning', { custom_minutes: 15, method_applied: 'manual' }, tok);
    expect(r.status).toBe(200);
    expect(mem.audits.some((a) => a.action === 'task_target.changed')).toBe(true);
  });
});
