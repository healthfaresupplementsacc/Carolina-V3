'use strict';
/**
 * Entrega 2 commit 4: production_counts CRUD endpoints.
 *
 * GET    /api/admin/counts?date=YYYY-MM-DD
 * POST   /api/admin/count/create
 * PUT    /api/admin/count/:id
 * DELETE /api/admin/count/:id  (soft delete)
 *
 * Every mutation writes admin_audit_log.
 */

jest.mock('../db');
jest.mock('../slack/client');
jest.mock('../parser');
jest.mock('../eod');

const db = require('../db');
const express = require('express');

beforeEach(() => { jest.clearAllMocks(); });

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

function findAudit(action) {
  return db.query.mock.calls.find((c) =>
    /INSERT INTO admin_audit_log/.test(c[0]) && c[1][1] === action
  );
}

describe('GET /api/admin/counts', () => {
  test('lists production_counts for date, deleted_at IS NULL', async () => {
    db.query = jest.fn().mockResolvedValue({
      rows: [{ id: 1, supplement_name: 'Berberine', count: 256 }],
    });
    const r = await request('GET', '/api/admin/counts?pin=510510&date=2026-05-15');
    expect(r.status).toBe(200);
    expect(r.body[0].supplement_name).toBe('Berberine');
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/FROM production_counts/);
    expect(sql).toMatch(/deleted_at IS NULL/);
  });

  test('wrong pin → 403', async () => {
    const r = await request('GET', '/api/admin/counts?pin=wrong');
    expect(r.status).toBe(403);
  });
});

describe('POST /api/admin/count/create', () => {
  test('inserts + writes audit (production_count.create)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/INSERT INTO production_counts/.test(sql)) return Promise.resolve({ rows: [{ id: 33 }] });
      if (/SELECT \* FROM production_counts/.test(sql)) return Promise.resolve({ rows: [{ id: 33, count: 256 }] });
      return Promise.resolve({ rows: [] });
    });

    const r = await request('POST', '/api/admin/count/create', {
      pin: '510510', supplement_name: 'Berberine', batch_number: '0119',
      count: 256, operator: 'Bruno', reported_at: '2026-05-15 14:00',
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(33);
    expect(findAudit('production_count.create')).toBeTruthy();
  });

  test('400 when supplement_name missing', async () => {
    const r = await request('POST', '/api/admin/count/create', { pin: '510510', count: 100 });
    expect(r.status).toBe(400);
  });

  test('400 when count invalid', async () => {
    const r = await request('POST', '/api/admin/count/create', {
      pin: '510510', supplement_name: 'Berberine', count: -5,
    });
    expect(r.status).toBe(400);
  });
});

describe('PUT /api/admin/count/:id', () => {
  test('edits count + writes audit with before/after', async () => {
    let select = 0;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM production_counts WHERE id = \$1/.test(sql)) {
        select++;
        return Promise.resolve({
          rows: [{ id: 5, count: select === 1 ? 100 : 200, supplement_name: 'Berberine' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/count/5', { pin: '510510', count: 200 });
    expect(r.status).toBe(200);
    const audit = findAudit('production_count.edit');
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit[1][4]).count).toBe(100); // before
    expect(JSON.parse(audit[1][5]).count).toBe(200); // after
  });

  test('404 when not found', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await request('PUT', '/api/admin/count/999', { pin: '510510', count: 100 });
    expect(r.status).toBe(404);
  });

  test('400 when count invalid', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5, count: 100 }] });
    const r = await request('PUT', '/api/admin/count/5', { pin: '510510', count: 'abc' });
    expect(r.status).toBe(400);
  });

  test('400 when nothing to update', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5, count: 100 }] });
    const r = await request('PUT', '/api/admin/count/5', { pin: '510510' });
    expect(r.status).toBe(400);
  });
});

describe('DELETE /api/admin/count/:id (soft delete)', () => {
  test('sets deleted_at + writes audit', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM production_counts/.test(sql)) return Promise.resolve({ rows: [{ id: 5, deleted_at: null }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await request('DELETE', '/api/admin/count/5?pin=510510');
    expect(r.status).toBe(200);
    const updateCall = db.query.mock.calls.find((c) =>
      /UPDATE production_counts SET deleted_at = NOW\(\)/.test(c[0])
    );
    expect(updateCall).toBeTruthy();
    expect(findAudit('production_count.delete')).toBeTruthy();
  });

  test('400 when already deleted', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5, deleted_at: '2026-05-15' }] });
    const r = await request('DELETE', '/api/admin/count/5?pin=510510');
    expect(r.status).toBe(400);
  });
});
