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

// app_state-backed key/value store + captured audit rows.
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
    if (/INSERT INTO admin_audit_log/.test(sql)) {
      store.audit.push({ action: params[1], entity_type: params[2], entity_id: params[3],
        before: params[4], after: params[5] });
      return Promise.resolve({ rows: [{ id: store.audit.length }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

let store;
beforeEach(() => {
  jest.clearAllMocks();
  store = { kv: {}, audit: [] };
  wireDb(store);
  require('../app-state').invalidateAppNameCache();
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
