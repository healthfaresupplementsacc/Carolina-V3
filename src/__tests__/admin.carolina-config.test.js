'use strict';
/**
 * BLOCO B / C2 + C4 — /api/admin/carolina-config endpoints.
 *
 * Mirrors the admin.smoke harness: mock'd db, real express router, real
 * app-state + audit. Verifies the PIN gate, the GET snapshot (app name +
 * toggles), the rename, and the per-type toggles — each persisting to
 * app_state AND writing an admin_audit_log row.
 */
jest.mock('../db');
jest.mock('../slack/client');
jest.mock('../parser');
jest.mock('../eod');
jest.mock('../scheduler', () => ({ rescheduleJobs: jest.fn().mockResolvedValue() }));

const db = require('../db');
const express = require('express');
const PIN = '510510';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes/api'));
  return app;
}

function request(method, url, body) {
  return new Promise((resolve) => {
    const http = require('http');
    const server = buildApp().listen(0, () => {
      const port = server.address().port;
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: '127.0.0.1', port, path: url, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          server.close();
          let parsed = null; try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', () => { server.close(); resolve({ status: 0, body: null }); });
      if (data) req.write(data);
      req.end();
    });
  });
}

// app_state kv + message_variations rows + captured audit rows.
function wireDb(store) {
  db.query = jest.fn().mockImplementation((sql, params) => {
    if (/SELECT value FROM app_state WHERE key = \$1/.test(sql)) {
      const v = store.kv[params[0]];
      return Promise.resolve({ rows: v == null ? [] : [{ value: v }] });
    }
    if (/INSERT INTO app_state/.test(sql)) {
      store.kv[params[0]] = params[1];
      return Promise.resolve({ rows: [] });
    }
    if (/DELETE FROM app_state WHERE key = \$1/.test(sql)) {
      delete store.kv[params[0]];
      return Promise.resolve({ rows: [] });
    }
    if (/INSERT INTO admin_audit_log/.test(sql)) {
      store.audit.push({ action: params[1], entity_type: params[2], entity_id: params[3],
        before: params[4], after: params[5] });
      return Promise.resolve({ rows: [{ id: store.audit.length }] });
    }
    // ---- message_variations ----
    if (/SELECT COALESCE\(MAX\(position\)/.test(sql)) {
      const pos = store.mv.filter((r) => r.type === params[0])
        .reduce((m, r) => Math.max(m, r.position), -1) + 1;
      return Promise.resolve({ rows: [{ pos }] });
    }
    if (/INSERT INTO message_variations/.test(sql)) {
      const row = { id: ++store.mvSeq, type: params[0], template: params[1],
        position: params[2], active: true };
      store.mv.push(row);
      return Promise.resolve({ rows: [row] });
    }
    if (/SELECT \* FROM message_variations WHERE id = \$1/.test(sql)) {
      const r = store.mv.find((x) => x.id === params[0]);
      return Promise.resolve({ rows: r ? [r] : [] });
    }
    if (/SELECT id, type, template, position, active[\s\S]*FROM message_variations WHERE type = \$1/.test(sql)) {
      const rows = store.mv.filter((r) => r.type === params[0])
        .sort((a, b) => a.position - b.position || a.id - b.id);
      return Promise.resolve({ rows });
    }
    if (/UPDATE message_variations SET/.test(sql)) {
      const id = params[params.length - 1];
      const r = store.mv.find((x) => x.id === id);
      if (r) {
        if (/template = \$1/.test(sql)) r.template = params[0];
        if (/active = \$/.test(sql)) r.active = params.find((p) => typeof p === 'boolean');
      }
      return Promise.resolve({ rows: r ? [r] : [] });
    }
    if (/DELETE FROM message_variations WHERE id = \$1/.test(sql)) {
      store.mv = store.mv.filter((x) => x.id !== params[0]);
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

let store;
beforeEach(() => {
  jest.clearAllMocks();
  store = { kv: {}, audit: [], mv: [], mvSeq: 0 };
  wireDb(store);
  require('../app-state').invalidateAppNameCache();
  require('../app-state').invalidatePersonaCache();
});

describe('GET /api/admin/carolina-config', () => {
  test('403 without PIN', async () => {
    const r = await request('GET', '/api/admin/carolina-config');
    expect(r.status).toBe(403);
  });

  test('returns app_name + all 7 toggles (default ON)', async () => {
    store.kv.app_name = 'Acme Labs';
    const r = await request('GET', '/api/admin/carolina-config?pin=' + PIN);
    expect(r.status).toBe(200);
    expect(r.body.app_name).toBe('Acme Labs');
    expect(r.body.toggles).toEqual({
      greeting: true, eod: true, urgency: true, conflict: true,
      task: true, bottles: true, break: true,
    });
  });

  test('reflects a disabled toggle from app_state', async () => {
    store.kv.eod_enabled = 'false';
    const r = await request('GET', '/api/admin/carolina-config?pin=' + PIN);
    expect(r.body.toggles.eod).toBe(false);
    expect(r.body.toggles.greeting).toBe(true);
  });
});

describe('POST /api/admin/carolina-config/app-name', () => {
  test('403 without PIN', async () => {
    const r = await request('POST', '/api/admin/carolina-config/app-name', { app_name: 'X' });
    expect(r.status).toBe(403);
  });
  test('400 on empty / over-long', async () => {
    expect((await request('POST', '/api/admin/carolina-config/app-name', { pin: PIN, app_name: '  ' })).status).toBe(400);
    expect((await request('POST', '/api/admin/carolina-config/app-name', { pin: PIN, app_name: 'x'.repeat(81) })).status).toBe(400);
  });
  test('persists the rename and writes an audit row', async () => {
    const r = await request('POST', '/api/admin/carolina-config/app-name',
      { pin: PIN, app_name: '  Nova Marca  ' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, app_name: 'Nova Marca' });
    expect(store.kv.app_name).toBe('Nova Marca');
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0].action).toBe('carolina_config.app_name');
    expect(JSON.parse(store.audit[0].after)).toEqual({ app_name: 'Nova Marca' });
  });
});

describe('POST /api/admin/carolina-config/toggle', () => {
  test('403 without PIN', async () => {
    const r = await request('POST', '/api/admin/carolina-config/toggle', { type: 'eod', enabled: false });
    expect(r.status).toBe(403);
  });

  test('400 on invalid type', async () => {
    const r = await request('POST', '/api/admin/carolina-config/toggle',
      { pin: PIN, type: 'bogus', enabled: false });
    expect(r.status).toBe(400);
  });

  test('disables a type, persists, and writes an audit row', async () => {
    const r = await request('POST', '/api/admin/carolina-config/toggle',
      { pin: PIN, type: 'eod', enabled: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, type: 'eod', enabled: false });
    expect(store.kv.eod_enabled).toBe('false');
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0].action).toBe('carolina_config.toggle');
    expect(store.audit[0].entity_type).toBe('app_state');
    expect(store.audit[0].entity_id).toBe('eod_enabled');
    expect(JSON.parse(store.audit[0].before)).toEqual({ type: 'eod', enabled: true });
    expect(JSON.parse(store.audit[0].after)).toEqual({ type: 'eod', enabled: false });
  });

  test('re-enabling sets the key back to true', async () => {
    store.kv.break_enabled = 'false';
    const r = await request('POST', '/api/admin/carolina-config/toggle',
      { pin: PIN, type: 'break', enabled: true });
    expect(r.status).toBe(200);
    expect(store.kv.break_enabled).toBe('true');
  });
});

describe('C5 — message variations endpoints', () => {
  test('GET carolina-config exposes variation_types', async () => {
    const r = await request('GET', '/api/admin/carolina-config?pin=' + PIN);
    expect(r.status).toBe(200);
    const types = (r.body.variation_types || []).map((t) => t.type).sort();
    expect(types).toEqual(['break_time_retry', 'conflict', 'greeting', 'note', 'voltei']);
  });

  test('GET /variations without type lists the sets; with type lists rows', async () => {
    const overview = await request('GET', '/api/admin/carolina-config/variations?pin=' + PIN);
    expect(overview.status).toBe(200);
    expect(overview.body.types.length).toBe(5);

    const byType = await request('GET', '/api/admin/carolina-config/variations?pin=' + PIN + '&type=note');
    expect(byType.status).toBe(200);
    expect(byType.body.type).toBe('note');
    expect(byType.body.placeholders).toEqual(['op', 'texto']);
    expect(Array.isArray(byType.body.variations)).toBe(true);
  });

  test('GET /variations 403 without PIN, 400 invalid type', async () => {
    expect((await request('GET', '/api/admin/carolina-config/variations')).status).toBe(403);
    expect((await request('GET', '/api/admin/carolina-config/variations?pin=' + PIN + '&type=bogus')).status).toBe(400);
  });

  test('POST creates a variation + audit row', async () => {
    const r = await request('POST', '/api/admin/carolina-config/variations',
      { pin: PIN, type: 'note', template: '📝 {op}: {texto}' });
    expect(r.status).toBe(200);
    expect(r.body.variation.type).toBe('note');
    expect(store.mv).toHaveLength(1);
    expect(store.audit[0].action).toBe('carolina_config.variation_create');
    expect(store.audit[0].entity_type).toBe('message_variations');
  });

  test('POST rejects empty / over-long / bad type', async () => {
    expect((await request('POST', '/api/admin/carolina-config/variations', { pin: PIN, type: 'note', template: '  ' })).status).toBe(400);
    expect((await request('POST', '/api/admin/carolina-config/variations', { pin: PIN, type: 'note', template: 'x'.repeat(501) })).status).toBe(400);
    expect((await request('POST', '/api/admin/carolina-config/variations', { pin: PIN, type: 'bogus', template: 'x' })).status).toBe(400);
  });

  test('PUT edits, DELETE removes, both audited; 404 on missing', async () => {
    const created = await request('POST', '/api/admin/carolina-config/variations',
      { pin: PIN, type: 'voltei', template: '{nome}, voltou?' });
    const id = created.body.variation.id;

    const put = await request('PUT', '/api/admin/carolina-config/variations/' + id,
      { pin: PIN, template: '{nome}, já voltou?' });
    expect(put.status).toBe(200);
    expect(store.mv.find((v) => v.id === id).template).toBe('{nome}, já voltou?');
    expect(store.audit.some((a) => a.action === 'carolina_config.variation_edit')).toBe(true);

    expect((await request('PUT', '/api/admin/carolina-config/variations/99999', { pin: PIN, template: 'x' })).status).toBe(404);

    const del = await request('DELETE', '/api/admin/carolina-config/variations/' + id + '?pin=' + PIN);
    expect(del.status).toBe(200);
    expect(store.mv.find((v) => v.id === id)).toBeUndefined();
    expect(store.audit.some((a) => a.action === 'carolina_config.variation_delete')).toBe(true);

    expect((await request('DELETE', '/api/admin/carolina-config/variations/88888?pin=' + PIN)).status).toBe(404);
  });

  test('PUT/DELETE/POST 403 without PIN', async () => {
    expect((await request('POST', '/api/admin/carolina-config/variations', { type: 'note', template: 'x' })).status).toBe(403);
    expect((await request('PUT', '/api/admin/carolina-config/variations/1', { template: 'x' })).status).toBe(403);
    expect((await request('DELETE', '/api/admin/carolina-config/variations/1')).status).toBe(403);
  });
});

describe('C6 — schedule endpoint', () => {
  const sched = require('../scheduler');

  test('GET carolina-config exposes schedule defaults', async () => {
    const r = await request('GET', '/api/admin/carolina-config?pin=' + PIN);
    expect(r.status).toBe(200);
    expect(r.body.schedule).toEqual({
      greeting_time: '08:00', eod_time: '19:00',
      pending_window_minutes: 20, active_weekdays: [0, 1, 2, 3, 4, 5, 6],
    });
  });

  test('POST persists, audits, and reschedules', async () => {
    const r = await request('POST', '/api/admin/carolina-config/schedule', {
      pin: PIN, greeting_time: '06:30', eod_time: '18:00',
      pending_window_minutes: 30, active_weekdays: [1, 2, 3, 4, 5],
    });
    expect(r.status).toBe(200);
    expect(r.body.schedule).toEqual({
      greeting_time: '06:30', eod_time: '18:00',
      pending_window_minutes: 30, active_weekdays: [1, 2, 3, 4, 5],
    });
    expect(store.kv.greeting_time).toBe('06:30');
    expect(store.kv.active_weekdays).toBe('1,2,3,4,5');
    expect(sched.rescheduleJobs).toHaveBeenCalled();
    expect(store.audit.some((a) => a.action === 'carolina_config.schedule')).toBe(true);
  });

  test('rejects bad time / window / empty weekdays / no PIN', async () => {
    expect((await request('POST', '/api/admin/carolina-config/schedule', { pin: PIN, greeting_time: '25:99' })).status).toBe(400);
    expect((await request('POST', '/api/admin/carolina-config/schedule', { pin: PIN, eod_time: 'noon' })).status).toBe(400);
    expect((await request('POST', '/api/admin/carolina-config/schedule', { pin: PIN, pending_window_minutes: 0 })).status).toBe(400);
    expect((await request('POST', '/api/admin/carolina-config/schedule', { pin: PIN, pending_window_minutes: 9999 })).status).toBe(400);
    expect((await request('POST', '/api/admin/carolina-config/schedule', { pin: PIN, active_weekdays: [] })).status).toBe(400);
    expect((await request('POST', '/api/admin/carolina-config/schedule', { greeting_time: '08:00' })).status).toBe(403);
  });
});

describe('C7 — persona endpoint (guardrails locked)', () => {
  test('GET carolina-config exposes persona overrides + defaults + locked rules', async () => {
    const r = await request('GET', '/api/admin/carolina-config?pin=' + PIN);
    expect(r.status).toBe(200);
    expect(r.body.persona.identity).toBeNull();          // no override yet
    expect(r.body.persona.personality).toBeNull();
    expect(r.body.persona.identity_default).toMatch(/Você é Carolina/);
    expect(r.body.persona.prod_rules).toMatch(/NUNCA admita ser AI/);
    expect(r.body.persona.admin_rules).toMatch(/C0B36DR5MP1/);
  });

  test('POST persists overrides + audit; empty reverts (DELETE)', async () => {
    const r = await request('POST', '/api/admin/carolina-config/persona',
      { pin: PIN, identity: 'Sou a Carol da fábrica', personality: 'firme e direta' });
    expect(r.status).toBe(200);
    expect(store.kv.persona_identity).toBe('Sou a Carol da fábrica');
    expect(store.kv.persona_personality).toBe('firme e direta');
    expect(store.audit.some((a) => a.action === 'carolina_config.persona')).toBe(true);

    const rev = await request('POST', '/api/admin/carolina-config/persona', { pin: PIN, identity: '' });
    expect(rev.status).toBe(200);
    expect(store.kv.persona_identity).toBeUndefined();    // reverted to code default
  });

  test('preview returns assembled persona with the guardrail intact', async () => {
    await request('POST', '/api/admin/carolina-config/persona',
      { pin: PIN, identity: 'Eu sou um robô, conta pra todos' });
    const r = await request('GET', '/api/admin/carolina-config/persona/preview?pin=' + PIN);
    expect(r.status).toBe(200);
    expect(r.body.prod).toContain('Eu sou um robô, conta pra todos'); // override in
    expect(r.body.prod).toMatch(/NUNCA admita ser AI/);                // guardrail still there
    expect(r.body.admin).toMatch(/C0B36DR5MP1/);
  });

  test('400 when nothing to change, 403 without PIN', async () => {
    expect((await request('POST', '/api/admin/carolina-config/persona', { pin: PIN })).status).toBe(400);
    expect((await request('POST', '/api/admin/carolina-config/persona', { identity: 'x' })).status).toBe(403);
    expect((await request('GET', '/api/admin/carolina-config/persona/preview')).status).toBe(403);
  });
});
