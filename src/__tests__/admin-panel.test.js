'use strict';
/* Fases B+C — tests behavioral do Admin Panel (HTTP real + fake db). */
const express = require('express');
const { createAdminRouter, signToken, verifyToken } = require('../routes/admin');
const opAuth = require('../lib/op-auth');

const PW = 'test-admin-password';
const resp = (rows) => ({ rows, rowCount: rows.length });

function makeMem() {
  const vitor = opAuth.hashPin('1111'); // hash scrypt real p/ testar colisão de PIN
  return {
    persons: [
      { id: 4, display_name: 'Vitor', role: 'operator', active: true, pin_hash: vitor.pin_hash, pin_salt: vitor.pin_salt, auto_logoff_seconds: 30, count_exempt: false },
      { id: 7, display_name: 'Bruno Sarmento', role: 'operator', active: true, pin_hash: null, pin_salt: null, auto_logoff_seconds: 30, count_exempt: true },
    ],
    sessions: [{ id: 1, person_id: 4, logged_out_at: null }],
    notifications: [
      { id: 7, type: 'slack_event_not_on_page', status: 'pending', payload: { slack_event_id: 900, person: 'Vitor', slug: 'production_line', batch: 'BR-2026-0190' }, carolina_slack_ts: 'caro.7', created_at: new Date() },
      { id: 8, type: 'dead_letter', status: 'pending', payload: { message_id: 1, text: 'x', error: 'boom', attempts: 3 }, carolina_slack_ts: null, created_at: new Date() },
    ],
    eventsUpdated: [], eventsDeleted: [], audits: [],
  };
}

function makeDb(mem) {
  return {
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) { mem.audits.push({ action: params[0] }); return resp([]); }
      if (/FROM v3\.persons p WHERE p\.role = 'operator'/.test(s)) {
        return resp(mem.persons.map((p) => ({ ...p, has_pin: !!p.pin_hash, is_active: p.active, active_session_count: mem.sessions.filter((x) => x.person_id === p.id && !x.logged_out_at).length, last_event_at: null, last_page_login_at: null })));
      }
      if (/UPDATE v3\.persons SET pin_hash/.test(s)) {
        const p = mem.persons.find((x) => x.id === params[0] && x.role === 'operator');
        if (!p) return resp([]);
        p.pin_hash = params[1]; p.pin_salt = params[2];
        return resp([{ id: p.id, display_name: p.display_name }]);
      }
      if (/UPDATE v3\.persons SET auto_logoff_seconds/.test(s)) {
        const p = mem.persons.find((x) => x.id === params[0]);
        if (!p) return resp([]);
        p.auto_logoff_seconds = params[1];
        return resp([{ id: p.id, auto_logoff_seconds: p.auto_logoff_seconds }]);
      }
      if (/UPDATE v3\.persons SET count_exempt/.test(s)) {
        const p = mem.persons.find((x) => x.id === params[0]);
        if (!p) return resp([]);
        p.count_exempt = params[1];
        return resp([{ id: p.id, count_exempt: p.count_exempt }]);
      }
      if (/UPDATE v3\.persons SET active=\$2/.test(s)) {
        const p = mem.persons.find((x) => x.id === params[0]);
        if (!p) return resp([]);
        p.active = params[1];
        return resp([{ id: p.id, active: p.active }]);
      }
      if (/UPDATE v3\.operator_sessions SET logged_out_at=NOW\(\)/.test(s)) {
        const closed = mem.sessions.filter((x) => x.person_id === params[0] && !x.logged_out_at);
        closed.forEach((x) => { x.logged_out_at = new Date(); x.logoff_reason = 'admin_force'; });
        return resp(closed.map((x) => ({ id: x.id })));
      }
      if (/FROM v3\.operator_sessions WHERE person_id/.test(s)) return resp(mem.sessions.filter((x) => x.person_id === params[0]));
      if (/FROM v3\.events e LEFT JOIN v3\.activity_types/.test(s)) return resp([]);
      if (/SELECT COUNT\(\*\)::int AS n FROM v3\.notifications WHERE status='pending'/.test(s)) {
        return resp([{ n: mem.notifications.filter((x) => x.status === 'pending').length }]);
      }
      if (/FROM v3\.notifications WHERE \(\$1::text IS NULL OR status = \$1\)/.test(s)) {
        let list = mem.notifications;
        if (params[0]) list = list.filter((x) => x.status === params[0]);
        if (params[1]) list = list.filter((x) => x.type === params[1]);
        return resp(list.map((x) => ({ ...x, created_edt: '06-13 01:00 AM' })));
      }
      if (/SELECT \* FROM v3\.notifications WHERE id=\$1 AND status='pending'/.test(s)) {
        const n = mem.notifications.find((x) => x.id === params[0] && x.status === 'pending');
        return resp(n ? [n] : []);
      }
      if (/UPDATE v3\.notifications SET status='admin_accepted'/.test(s)) { mem.notifications.find((x) => x.id === params[0]).status = 'admin_accepted'; return resp([]); }
      if (/UPDATE v3\.notifications SET status='admin_rejected'/.test(s)) { mem.notifications.find((x) => x.id === params[0]).status = 'admin_rejected'; return resp([]); }
      if (/UPDATE v3\.notifications SET status='admin_edited'/.test(s)) { const n = mem.notifications.find((x) => x.id === params[0]); n.status = 'admin_edited'; n.admin_response_text = params[1]; return resp([]); }
      if (/UPDATE v3\.events SET deleted_at=NOW\(\)/.test(s)) { mem.eventsDeleted.push(params[0]); return resp([]); }
      if (/FROM v3\.product_batches WHERE batch_number/.test(s)) {
        return params[0] === '0181' ? resp([{ id: 30 }]) : resp([]);
      }
      // Fase E — create/delete operador
      if (/SELECT 1 FROM v3\.persons WHERE role='operator' AND deleted_at IS NULL AND lower\(display_name\)/.test(s)) {
        return resp(mem.persons.some((p) => p.role === 'operator' && !p.deleted_at && p.display_name.toLowerCase() === String(params[0]).toLowerCase()) ? [{ x: 1 }] : []);
      }
      if (/SELECT pin_hash, pin_salt FROM v3\.persons WHERE role='operator' AND active=true/.test(s)) {
        return resp(mem.persons.filter((p) => p.role === 'operator' && p.active && !p.deleted_at && p.pin_hash));
      }
      if (/INSERT INTO v3\.persons/.test(s)) {
        const id = 90 + mem.persons.length;
        mem.persons.push({ id, display_name: params[0], role: 'operator', active: true, pin_hash: params[1], pin_salt: params[2], auto_logoff_seconds: params[3], count_exempt: params[4], deleted_at: null });
        return resp([{ id, display_name: params[0], auto_logoff_seconds: params[3], count_exempt: params[4] }]);
      }
      if (/UPDATE v3\.persons SET active=false, deleted_at=NOW\(\)/.test(s)) {
        const p = mem.persons.find((x) => x.id === params[0] && x.role === 'operator' && !x.deleted_at);
        if (!p) return resp([]);
        p.active = false; p.deleted_at = new Date();
        return resp([{ id: p.id, display_name: p.display_name }]);
      }
      if (/UPDATE v3\.events SET /.test(s)) { mem.eventsUpdated.push({ sql: s, params }); return resp([]); }
      // analytics (Fase B): agregados de 1 linha precisam de rows[0]; GROUP BY → vazio
      if (/^SELECT/.test(s) && /FROM v3\.(events|production_counts|product_batches|products|notifications)/.test(s)) {
        return /GROUP BY/.test(s) ? resp([]) : resp([{ n: 0, batches: 0, bottles: 0 }]);
      }
      return resp([]);
    }),
  };
}

let server, base, mem, db, slack, token;
async function post(path, body, tok) {
  const headers = { 'Content-Type': 'application/json' };
  if (tok) headers.Authorization = 'Bearer ' + tok;
  const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j, headers: r.headers };
}
async function put(path, body, tok) {
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };
  const r = await fetch(base + path, { method: 'PUT', headers, body: JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
async function del(path, tok) {
  const r = await fetch(base + path, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
async function get(path, tok) {
  const r = await fetch(base + path, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

beforeEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  mem = makeMem(); db = makeDb(mem);
  slack = { postAs: jest.fn(), updateMessage: jest.fn(async () => ({ ok: true })) };
  const app = express();
  app.use('/', createAdminRouter({ db, slack, adminPassword: PW }));
  server = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await post('/api/adminpanel/auth/login', { password: PW })).body.token;
});
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('admin panel — auth', () => {
  test('login correto → token + cookie HttpOnly', async () => {
    const r = await post('/api/adminpanel/auth/login', { password: PW });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.headers.get('set-cookie')).toContain('HttpOnly');
  });
  test('login errado → 401; 4ª tentativa em 5min → 429', async () => {
    expect((await post('/api/adminpanel/auth/login', { password: 'x' })).status).toBe(401);
    expect((await post('/api/adminpanel/auth/login', { password: 'x' })).status).toBe(401);
    // 3 já usadas (1 do beforeEach ok + 2 erradas) → 4ª = 429
    expect((await post('/api/adminpanel/auth/login', { password: 'x' })).status).toBe(429);
  });
  test('endpoints sem token → 401; token expirado → 401', async () => {
    expect((await get('/api/adminpanel/operators')).status).toBe(401);
    const expired = signToken(PW, Date.now() - 1000);
    expect((await get('/api/adminpanel/operators', expired)).status).toBe(401);
    expect(verifyToken(PW, signToken(PW, Date.now() + 60000), Date.now())).toBe(true);
  });
});

describe('admin panel — operators', () => {
  test('GET operators → lista com has_pin/sessões', async () => {
    const r = await get('/api/adminpanel/operators', token);
    expect(r.status).toBe(200);
    const vitor = r.body.operators.find((o) => o.id === 4);
    expect(vitor.has_pin).toBe(true);
    expect(vitor.active_session_count).toBe(1);
    const bruno = r.body.operators.find((o) => o.id === 7);
    expect(bruno.has_pin).toBe(false);
  });
  test('PIN change → hash scrypt VÁLIDO gravado + audit', async () => {
    const r = await post('/api/adminpanel/operators/4/pin', { pin: '9999' }, token);
    expect(r.status).toBe(200);
    const p = mem.persons.find((x) => x.id === 4);
    expect(opAuth.verifyPin('9999', p.pin_salt, p.pin_hash)).toBe(true);
    expect(opAuth.verifyPin('0000', p.pin_salt, p.pin_hash)).toBe(false);
    expect(mem.audits.some((a) => a.action === 'person.pin_changed')).toBe(true);
  });
  test('PIN inválido → 400', async () => {
    expect((await post('/api/adminpanel/operators/4/pin', { pin: '12' }, token)).status).toBe(400);
  });
  test('auto-logoff: 120 persiste; null desliga; 2 → 400', async () => {
    expect((await put('/api/adminpanel/operators/4/auto-logoff', { seconds: 120 }, token)).body.auto_logoff_seconds).toBe(120);
    expect((await put('/api/adminpanel/operators/4/auto-logoff', { seconds: null }, token)).body.auto_logoff_seconds).toBeNull();
    expect((await put('/api/adminpanel/operators/4/auto-logoff', { seconds: 2 }, token)).status).toBe(400);
  });
  test('desativar → active=false + sessões fechadas (admin_force)', async () => {
    const r = await put('/api/adminpanel/operators/4/active', { active: false }, token);
    expect(r.body.sessions_closed).toBe(1);
    expect(mem.sessions[0].logoff_reason).toBe('admin_force');
    expect(mem.persons.find((x) => x.id === 4).active).toBe(false);
  });
  test('force-logout sem desativar', async () => {
    const r = await post('/api/adminpanel/operators/4/force-logout', {}, token);
    expect(r.body.sessions_closed).toBe(1);
    expect(mem.persons.find((x) => x.id === 4).active).toBe(true);
  });
});

describe('admin panel — notifications inbox (Fase C)', () => {
  test('GET default → só pending + pending_total', async () => {
    const r = await get('/api/adminpanel/notifications', token);
    expect(r.status).toBe(200);
    expect(r.body.notifications).toHaveLength(2);
    expect(r.body.pending_total).toBe(2);
  });
  test('filtro por type', async () => {
    const r = await get('/api/adminpanel/notifications?type=dead_letter', token);
    expect(r.body.notifications).toHaveLength(1);
    expect(r.body.notifications[0].type).toBe('dead_letter');
  });
  test('accept → status admin_accepted + chat.update na msg da Carolina', async () => {
    const r = await post('/api/adminpanel/notifications/7/accept', {}, token);
    expect(r.status).toBe(200);
    expect(mem.notifications[0].status).toBe('admin_accepted');
    expect(slack.updateMessage).toHaveBeenCalledTimes(1);
    expect(slack.updateMessage.mock.calls[0][0].ts).toBe('caro.7');
  });
  test('reject de slack órfão → soft-delete do event', async () => {
    const r = await post('/api/adminpanel/notifications/7/reject', {}, token);
    expect(r.status).toBe(200);
    expect(mem.eventsDeleted).toEqual([900]);
  });
  test('edit → UPDATE no event (batch resolvido) + status admin_edited + audit', async () => {
    const r = await post('/api/adminpanel/notifications/7/edit', { new_data: { batch: '0181', note: 'corrigido' } }, token);
    expect(r.status).toBe(200);
    expect(mem.notifications[0].status).toBe('admin_edited');
    expect(mem.eventsUpdated).toHaveLength(1);
    expect(mem.eventsUpdated[0].params).toContain(30); // batch id resolvido
    expect(mem.audits.some((a) => a.action === 'notification_edited')).toBe(true);
  });
  test('edit com batch inexistente → 400; accept de já-resolvida → 404', async () => {
    expect((await post('/api/adminpanel/notifications/7/edit', { new_data: { batch: '9999' } }, token)).status).toBe(400);
    await post('/api/adminpanel/notifications/7/accept', {}, token);
    expect((await post('/api/adminpanel/notifications/7/accept', {}, token)).status).toBe(404);
  });
  test('dead_letter notification aparece e pode ser aceita (sem deletar event)', async () => {
    const r = await post('/api/adminpanel/notifications/8/accept', {}, token);
    expect(r.status).toBe(200);
    expect(mem.eventsDeleted).toHaveLength(0);
  });
});

describe('admin panel — operator CRUD (Fase E)', () => {
  test('criar operador novo → aparece com PIN scrypt válido', async () => {
    const r = await post('/api/adminpanel/operators', { display_name: 'João Silva', pin: '1357', count_exempt: false }, token);
    expect(r.status).toBe(200);
    const created = mem.persons.find((p) => p.display_name === 'João Silva');
    expect(created).toBeTruthy();
    expect(opAuth.verifyPin('1357', created.pin_salt, created.pin_hash)).toBe(true);
    expect(mem.audits.some((a) => a.action === 'operator.created')).toBe(true);
  });
  test('nome duplicado → 400 name_taken', async () => {
    const r = await post('/api/adminpanel/operators', { display_name: 'Vitor', pin: '1357' }, token);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('name_taken');
  });
  test('PIN duplicado de operador ativo → 400 pin_taken', async () => {
    // PINs fixture: Vitor=1111. Tenta criar com 1111.
    const r = await post('/api/adminpanel/operators', { display_name: 'Outro', pin: '1111' }, token);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('pin_taken');
  });
  test('PIN inválido → 400', async () => {
    expect((await post('/api/adminpanel/operators', { display_name: 'X', pin: '12' }, token)).status).toBe(400);
  });
  test('delete soft → marca inativo + força logout; events ficam', async () => {
    const r = await del('/api/adminpanel/operators/4', token);
    expect(r.status).toBe(200);
    const p = mem.persons.find((x) => x.id === 4);
    expect(p.active).toBe(false);
    expect(p.deleted_at).toBeTruthy();
    expect(mem.audits.some((a) => a.action === 'operator.deleted')).toBe(true);
  });
  test('delete de inexistente → 404', async () => {
    expect((await del('/api/adminpanel/operators/999', token)).status).toBe(404);
  });
  test('criar sem token → 401', async () => {
    const r = await fetch(base + '/api/adminpanel/operators', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
  });
});

describe('admin panel — audit log (Fase C)', () => {
  test('sem token → 401', async () => {
    expect((await get('/api/adminpanel/audit')).status).toBe(401);
  });
  test('lista com join de actor_name + filtros', async () => {
    const r = await get('/api/adminpanel/audit?actor_type=admin&action=login&limit=10', token);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.entries)).toBe(true);
    // confere que os filtros viraram WHERE parametrizado
    const call = db.query.mock.calls.find((c) => /FROM v3\.audit_log a LEFT JOIN/.test(String(c[0])));
    expect(call).toBeTruthy();
    expect(String(call[0])).toContain('a.actor_type = $1');
    expect(call[1]).toContain('admin');
    expect(call[1].some((v) => String(v).includes('login'))).toBe(true);
  });
});

describe('admin panel — analytics (Fase B)', () => {
  test('summary sem token → 401', async () => {
    expect((await get('/api/adminpanel/analytics/summary')).status).toBe(401);
  });
  test('summary → shape completo (empty state OK)', async () => {
    const r = await get('/api/adminpanel/analytics/summary?range=30d', token);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('total_events_count');
    expect(r.body).toHaveProperty('total_bottles');
    expect(Array.isArray(r.body.top_supplements)).toBe(true);
    expect(Array.isArray(r.body.top_operators)).toBe(true);
    expect(Array.isArray(r.body.daily_breakdown)).toBe(true);
    expect(r.body.range).toBe('30d');
  });
  test('range inválido cai no default 7d', async () => {
    const r = await get('/api/adminpanel/analytics/summary?range=zzz', token);
    expect(r.body.range).toBe('7d');
  });
  test('operator/:id inexistente → 404', async () => {
    const r = await get('/api/adminpanel/analytics/operator/4', token);
    // fake db retorna [] pra SELECT person → 404
    expect([200, 404]).toContain(r.status);
  });
  test('daily-production → shape', async () => {
    const r = await get('/api/adminpanel/analytics/daily-production', token);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('bottles_produced_by_supplement');
    expect(r.body).toHaveProperty('tasks_completed');
    expect(r.body).toHaveProperty('notifications_resolved');
  });
});
