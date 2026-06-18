'use strict';
/* Painel admin — revisão de lotes desconhecidos (auto-criados pelo operador).
   Listar / contar (badge) / confirmar (vira válido) / rejeitar (soft-delete). PINs fictícios. */
const express = require('express');
const { createAdminRouter } = require('../routes/admin');
const opAuth = require('../lib/op-auth');

const PW = 'emergency-pw';
const OWNER_PIN = '111111';
const resp = (rows) => ({ rows, rowCount: rows.length });

function makeMem() {
  const o = opAuth.hashPin(OWNER_PIN);
  return {
    admins: [{ id: 1, name: 'Owner', role: 'owner', pin_hash: o.pin_hash, pin_salt: o.pin_salt, is_active: true }],
    batches: [
      { id: 70, batch_number: '0218', product_id: 56, product: 'Plant Sterols', origin: 'operator_created', created_by: 'Vitor', created_via: 'op_page', deleted_at: null, events: 1 },
      { id: 71, batch_number: 'XYZ-9', product_id: null, product: null, origin: 'operator_created', created_by: 'Ana', created_via: 'op_page', deleted_at: null, events: 1 },
      { id: 72, batch_number: 'BR-2026-0100', product_id: 1, product: 'Magnesium', origin: 'pipeline', created_by: null, created_via: null, deleted_at: null, events: 3 },
    ],
    sessions: [], audits: [],
  };
}
function makeDb(mem) {
  return {
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) { mem.audits.push({ action: params[0], target_id: params[2] }); return resp([]); }
      if (/COUNT\(\*\)::int n FROM v3\.admin_users WHERE is_active = true/.test(s)) return resp([{ n: mem.admins.filter((a) => a.is_active).length }]);
      if (/SELECT id, name, role, pin_hash, pin_salt FROM v3\.admin_users WHERE is_active = true/.test(s)) return resp(mem.admins.filter((a) => a.is_active));
      if (/INSERT INTO v3\.admin_sessions/.test(s)) { mem.sessions.push({ token: params[1], admin_user_id: params[0] }); return resp([]); }
      if (/UPDATE v3\.admin_users SET last_login_at/.test(s)) return resp([]);
      if (/FROM v3\.admin_sessions s JOIN v3\.admin_users u/.test(s)) {
        const x = mem.sessions.find((y) => y.token === params[0]); if (!x) return resp([]);
        const u = mem.admins.find((a) => a.id === x.admin_user_id && a.is_active);
        return u ? resp([{ session_id: 1, admin_user_id: u.id, name: u.name, role: u.role }]) : resp([]);
      }
      if (/UPDATE v3\.admin_sessions SET last_activity_at/.test(s)) return resp([]);
      // ── unknown-batches ──
      if (/COUNT\(\*\)::int AS count FROM v3\.product_batches WHERE origin = 'operator_created'/.test(s)) {
        return resp([{ count: mem.batches.filter((b) => b.origin === 'operator_created' && !b.deleted_at).length }]);
      }
      if (/SELECT pb\.id, pb\.batch_number/.test(s) && /FROM v3\.product_batches pb/.test(s)) {
        const rows = mem.batches.filter((b) => b.origin === 'operator_created' && !b.deleted_at)
          .map((b) => ({ id: b.id, batch_number: b.batch_number, product_id: b.product_id, product: b.product, created_via: b.created_via, created_at_edt: 'Jun 18, 08:40 AM', created_by: b.created_by, events_count: b.events }));
        return resp(rows);
      }
      if (/UPDATE v3\.product_batches SET origin = 'operator_confirmed'/.test(s)) {
        const b = mem.batches.find((x) => x.id === params[0] && x.origin === 'operator_created' && !x.deleted_at);
        if (!b) return resp([]);
        b.origin = 'operator_confirmed';
        return resp([{ id: b.id, batch_number: b.batch_number }]);
      }
      if (/UPDATE v3\.product_batches SET deleted_at = NOW\(\), reviewed_at/.test(s)) {
        const b = mem.batches.find((x) => x.id === params[0] && x.origin === 'operator_created' && !x.deleted_at);
        if (!b) return resp([]);
        b.deleted_at = new Date();
        return resp([{ id: b.id, batch_number: b.batch_number }]);
      }
      // gaps (Passada 2)
      if (/FROM v3\.activity_gaps g JOIN v3\.persons p/.test(s) && /SUM\(g\.gap_minutes\)/.test(s) && /GROUP BY/.test(s)) {
        return resp([{ display_name: 'Vitor', gaps: 2, total_min: 55, avg_min: 28 }]);
      }
      if (/FROM v3\.activity_gaps g JOIN v3\.persons p/.test(s)) {
        return resp((mem.gaps || []).map((g) => ({ id: g.id, display_name: 'Vitor', gap_minutes: g.gap_minutes, justification_type: g.type, justification_note: g.note, started_edt: '01:00 PM', created_edt: 'Jun 18, 01:30 PM' })));
      }
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

describe('admin — lotes desconhecidos', () => {
  test('lista só os operator_created não-deletados (não pipeline)', async () => {
    const tok = await login(OWNER_PIN);
    const r = await call('GET', '/api/adminpanel/unknown-batches', undefined, tok);
    expect(r.status).toBe(200);
    expect(r.body.batches).toHaveLength(2);
    expect(r.body.batches.map((b) => b.batch_number).sort()).toEqual(['0218', 'XYZ-9']);
  });

  test('badge: contagem dos pendentes', async () => {
    const tok = await login(OWNER_PIN);
    const r = await call('GET', '/api/adminpanel/metrics/unknown-batches-count', undefined, tok);
    expect(r.body.count).toBe(2);
  });

  test('confirmar → origin operator_confirmed, some da lista + badge', async () => {
    const tok = await login(OWNER_PIN);
    const c = await call('POST', '/api/adminpanel/unknown-batches/70/confirm', {}, tok);
    expect(c.status).toBe(200);
    expect(mem.batches.find((b) => b.id === 70).origin).toBe('operator_confirmed');
    expect((await call('GET', '/api/adminpanel/metrics/unknown-batches-count', undefined, tok)).body.count).toBe(1);
    expect(mem.audits.some((a) => a.action === 'batch.confirmed')).toBe(true);
  });

  test('rejeitar → soft-delete, some da lista', async () => {
    const tok = await login(OWNER_PIN);
    const r = await call('POST', '/api/adminpanel/unknown-batches/71/reject', {}, tok);
    expect(r.status).toBe(200);
    expect(mem.batches.find((b) => b.id === 71).deleted_at).toBeTruthy();
    expect(mem.audits.some((a) => a.action === 'batch.rejected')).toBe(true);
  });

  test('confirmar lote inexistente/pipeline → 404', async () => {
    const tok = await login(OWNER_PIN);
    expect((await call('POST', '/api/adminpanel/unknown-batches/72/confirm', {}, tok)).status).toBe(404); // pipeline
    expect((await call('POST', '/api/adminpanel/unknown-batches/999/confirm', {}, tok)).status).toBe(404);
  });

  test('sem auth → 401', async () => {
    expect((await call('GET', '/api/adminpanel/unknown-batches')).status).toBe(401);
    expect((await call('POST', '/api/adminpanel/unknown-batches/70/confirm', {})).status).toBe(401);
  });
});

describe('admin — gaps de atividade (Passada 2)', () => {
  test('lista gaps + resumo por operador', async () => {
    mem.gaps = [{ id: 1, gap_minutes: 25, type: 'bathroom', note: 'banheiro' }, { id: 2, gap_minutes: 30, type: 'help', note: 'ajudei colega' }];
    const tok = await login(OWNER_PIN);
    const r = await call('GET', '/api/adminpanel/gaps', undefined, tok);
    expect(r.status).toBe(200);
    expect(r.body.gaps).toHaveLength(2);
    expect(r.body.summary[0]).toMatchObject({ display_name: 'Vitor', total_min: 55 });
  });
  test('sem auth → 401', async () => {
    expect((await call('GET', '/api/adminpanel/gaps')).status).toBe(401);
  });
});
