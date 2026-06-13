'use strict';
/* Fase 3 — schedule por operador por dia da semana. Login via fallback de
   emergência (0 admins → owner). Fake-db p/ operator_schedules. */
const express = require('express');
const { createAdminRouter } = require('../routes/admin');

const PW = 'emergency-pw';
const resp = (rows) => ({ rows, rowCount: rows.length });

function makeDb(mem) {
  return {
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) { mem.audits.push({ action: params[0], target_id: params[2] }); return resp([]); }
      if (/COUNT\(\*\)::int n FROM v3\.admin_users WHERE is_active = true/.test(s)) return resp([{ n: 0 }]);
      if (/FROM v3\.admin_sessions s JOIN v3\.admin_users u/.test(s)) return resp([]);
      if (/SELECT day_of_week, to_char\(expected_start_time/.test(s)) {
        return resp(mem.sched.filter((x) => x.person_id === params[0]));
      }
      if (/INSERT INTO v3\.operator_schedules/.test(s)) {
        const [pid, dow, start, end, wk, notes] = params;
        const ex = mem.sched.find((x) => x.person_id === pid && x.day_of_week === dow);
        const row = { person_id: pid, day_of_week: dow, expected_start_time: start, expected_end_time: end, is_workday: wk, notes };
        if (ex) Object.assign(ex, row); else mem.sched.push(row);
        return resp([]);
      }
      if (/DELETE FROM v3\.operator_schedules/.test(s)) {
        mem.sched = mem.sched.filter((x) => !(x.person_id === params[0] && x.day_of_week === params[1]));
        return resp([]);
      }
      return resp([]);
    }),
  };
}

let server, base, mem, token;
async function call(method, path, body, tok) {
  const headers = {}; if (body !== undefined) headers['Content-Type'] = 'application/json'; if (tok) headers.Authorization = 'Bearer ' + tok;
  const r = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

beforeEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  mem = { sched: [], audits: [] };
  const app = express();
  app.use('/', createAdminRouter({ db: makeDb(mem), slack: { postAs: jest.fn() }, adminPassword: PW }));
  server = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await call('POST', '/api/adminpanel/auth/login', { password: PW })).body.token;
});
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('Fase 3 — schedule', () => {
  test('sem token → 401', async () => {
    expect((await call('GET', '/api/adminpanel/operators/4/schedule')).status).toBe(401);
  });
  test('GET retorna 7 dias (default null)', async () => {
    const r = await call('GET', '/api/adminpanel/operators/4/schedule', undefined, token);
    expect(r.status).toBe(200);
    expect(r.body.days).toHaveLength(7);
    expect(r.body.days[0].day_of_week).toBe(0);
    expect(r.body.days[1].expected_start_time).toBeNull();
  });
  test('PUT válido → upsert + audit', async () => {
    const r = await call('PUT', '/api/adminpanel/operators/4/schedule/1', { expected_start_time: '08:00', expected_end_time: '17:00', is_workday: true }, token);
    expect(r.status).toBe(200);
    expect(mem.sched.find((x) => x.person_id === 4 && x.day_of_week === 1).expected_start_time).toBe('08:00');
    expect(mem.audits.some((a) => a.action === 'operator.schedule_changed')).toBe(true);
    // agora aparece no GET
    const g = await call('GET', '/api/adminpanel/operators/4/schedule', undefined, token);
    expect(g.body.days[1].expected_start_time).toBe('08:00');
  });
  test('PUT dia inválido (7) → 400', async () => {
    expect((await call('PUT', '/api/adminpanel/operators/4/schedule/7', { expected_start_time: '08:00' }, token)).status).toBe(400);
  });
  test('PUT fim <= início → 400 end_before_start', async () => {
    const r = await call('PUT', '/api/adminpanel/operators/4/schedule/2', { expected_start_time: '17:00', expected_end_time: '08:00', is_workday: true }, token);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('end_before_start');
  });
  test('PUT hora malformada → 400 bad_time', async () => {
    expect((await call('PUT', '/api/adminpanel/operators/4/schedule/3', { expected_start_time: '25:99' }, token)).status).toBe(400);
  });
  test('DELETE remove o dia', async () => {
    await call('PUT', '/api/adminpanel/operators/4/schedule/4', { expected_start_time: '08:00', expected_end_time: '17:00' }, token);
    const r = await call('DELETE', '/api/adminpanel/operators/4/schedule/4', undefined, token);
    expect(r.status).toBe(200);
    expect(mem.sched.find((x) => x.person_id === 4 && x.day_of_week === 4)).toBeUndefined();
  });
});
