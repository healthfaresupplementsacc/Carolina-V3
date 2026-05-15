'use strict';
/**
 * Entrega 2 commit 3: pause CRUD endpoints (closes the original B17).
 *
 * GET    /api/admin/pauses          → list
 * POST   /api/admin/pause/create    → retroactive
 * PUT    /api/admin/pause/:id       → edit any field
 * POST   /api/admin/pause/:id/close → admin force-close (B17)
 * DELETE /api/admin/pause/:id       → soft delete
 *
 * Every mutation must hit admin_audit_log.
 */

jest.mock('../db');
jest.mock('../slack/client');
jest.mock('../parser');
jest.mock('../eod');

const db = require('../db');
const express = require('express');

beforeEach(() => {
  jest.clearAllMocks();
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes/api'));
  return app;
}

function request(method, url, body) {
  return new Promise((resolve) => {
    const app = buildApp();
    const http = require('http');
    const server = app.listen(0, () => {
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

function findAudit(action) {
  return db.query.mock.calls.find((c) =>
    /INSERT INTO admin_audit_log/.test(c[0]) && c[1][1] === action
  );
}

describe('GET /api/admin/pauses', () => {
  test('returns rows filtered by date + deleted_at IS NULL', async () => {
    db.query = jest.fn().mockResolvedValue({
      rows: [
        { id: 1, operator: 'Ana', started_at: '...', deleted_at: null },
        { id: 2, operator: 'Vitor', started_at: '...', deleted_at: null },
      ],
    });
    const r = await request('GET', '/api/admin/pauses?pin=510510&date=2026-05-15');
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(2);
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/FROM pauses p/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/'2026-05-15'::date/);
  });

  test('wrong PIN → 403', async () => {
    const r = await request('GET', '/api/admin/pauses?pin=wrong');
    expect(r.status).toBe(403);
  });
});

describe('POST /api/admin/pause/create', () => {
  test('inserts pause + writes audit (pause.create)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/INSERT INTO pauses/.test(sql)) return Promise.resolve({ rows: [{ id: 77 }] });
      if (/SELECT \* FROM pauses/.test(sql)) return Promise.resolve({ rows: [{ id: 77, operator: 'Ana' }] });
      return Promise.resolve({ rows: [] });
    });

    const r = await request('POST', '/api/admin/pause/create', {
      pin: '510510',
      operator: 'Ana',
      reason: 'almoço',
      started_at: '2026-05-15 12:30',
      ended_at: '2026-05-15 13:30',
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(77);

    const audit = findAudit('pause.create');
    expect(audit).toBeTruthy();
    expect(audit[1][2]).toBe('pause');
    expect(audit[1][3]).toBe('77');
  });

  test('400 when operator missing', async () => {
    const r = await request('POST', '/api/admin/pause/create', { pin: '510510', started_at: '2026-05-15 12:30' });
    expect(r.status).toBe(400);
  });

  test('400 when started_at missing', async () => {
    const r = await request('POST', '/api/admin/pause/create', { pin: '510510', operator: 'Ana' });
    expect(r.status).toBe(400);
  });
});

describe('PUT /api/admin/pause/:id', () => {
  test('edits fields + writes audit (pause.edit) with before/after', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM pauses WHERE id = \$1 LIMIT 1/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 5, operator: 'Ana', reason: 'banheiro', started_at: 'X', ended_at: null }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const r = await request('PUT', '/api/admin/pause/5', {
      pin: '510510', reason: 'almoço',
    });
    expect(r.status).toBe(200);

    const audit = findAudit('pause.edit');
    expect(audit).toBeTruthy();
    // before serialized
    expect(JSON.parse(audit[1][4]).operator).toBe('Ana');
  });

  test('404 when pause does not exist', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await request('PUT', '/api/admin/pause/999', { pin: '510510', reason: 'X' });
    expect(r.status).toBe(404);
  });

  test('400 when no fields supplied', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM pauses/.test(sql)) return Promise.resolve({ rows: [{ id: 5 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/pause/5', { pin: '510510' });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/admin/pause/:id/close (B17 — admin force-close)', () => {
  test('closes open pause + writes audit (pause.close) with ended_reason=admin_force_close', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM pauses WHERE id = \$1 LIMIT 1/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 12, operator: 'Ana', ended_at: null }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('POST', '/api/admin/pause/12/close', { pin: '510510' });
    expect(r.status).toBe(200);
    const updateCall = db.query.mock.calls.find((c) => /UPDATE pauses[\s\S]*ended_reason = 'admin_force_close'/.test(c[0]));
    expect(updateCall).toBeTruthy();
    const audit = findAudit('pause.close');
    expect(audit).toBeTruthy();
  });

  test('400 when pause already ended', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 12, ended_at: '2026-05-15T13:00:00Z' }] });
    const r = await request('POST', '/api/admin/pause/12/close', { pin: '510510' });
    expect(r.status).toBe(400);
  });

  test('404 when pause not found', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await request('POST', '/api/admin/pause/999/close', { pin: '510510' });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /api/admin/pause/:id (soft delete)', () => {
  test('sets deleted_at + writes audit (pause.delete)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM pauses/.test(sql)) return Promise.resolve({ rows: [{ id: 5, operator: 'Ana', deleted_at: null }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await request('DELETE', '/api/admin/pause/5?pin=510510');
    expect(r.status).toBe(200);
    const updateCall = db.query.mock.calls.find((c) => /UPDATE pauses SET deleted_at = NOW\(\)/.test(c[0]));
    expect(updateCall).toBeTruthy();
    const audit = findAudit('pause.delete');
    expect(audit).toBeTruthy();
  });

  test('400 when already soft-deleted', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5, deleted_at: '2026-05-15T10:00:00Z' }] });
    const r = await request('DELETE', '/api/admin/pause/5?pin=510510');
    expect(r.status).toBe(400);
  });
});
