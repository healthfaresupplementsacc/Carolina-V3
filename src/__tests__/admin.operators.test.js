'use strict';
/**
 * Entrega 2 commit 5: operators full CRUD endpoints.
 *
 * GET    /api/admin/operators
 * POST   /api/admin/operator/create
 * PUT    /api/admin/operator/:id
 * DELETE /api/admin/operator/:id  (sets active=false)
 */

jest.mock('../db');
jest.mock('../slack/client');
jest.mock('../parser');
jest.mock('../eod');

const db = require('../db');
const express = require('express');

beforeEach(() => { jest.clearAllMocks(); });

function request(method, url, body) {
  return new Promise((resolve) => {
    const http = require('http');
    const app = express();
    app.use(express.json());
    app.use('/api', require('../routes/api'));
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

describe('GET /api/admin/operators', () => {
  test('returns active + inactive ordered by active desc, name asc', async () => {
    db.query = jest.fn().mockResolvedValue({
      rows: [
        { id: 1, name: 'Ana', active: true,  aliases: '', role: null },
        { id: 2, name: 'Bruno', active: true, aliases: '', role: null },
        { id: 3, name: 'OldGuy', active: false, aliases: '', role: null },
      ],
    });
    const r = await request('GET', '/api/admin/operators?pin=510510');
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(3);
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/ORDER BY active DESC, name ASC/);
  });

  test('wrong pin → 403', async () => {
    const r = await request('GET', '/api/admin/operators?pin=wrong');
    expect(r.status).toBe(403);
  });
});

describe('POST /api/admin/operator/create', () => {
  test('inserts + audit (operator.create)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/INSERT INTO operators/.test(sql)) return Promise.resolve({ rows: [{ id: 42 }] });
      if (/SELECT \* FROM operators/.test(sql)) return Promise.resolve({ rows: [{ id: 42, name: 'Caroline' }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await request('POST', '/api/admin/operator/create', {
      pin: '510510', name: 'Caroline', slack_user_id: 'UABC123', aliases: 'Carol,Cá', role: 'operator',
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(42);
    expect(findAudit('operator.create')).toBeTruthy();
  });

  test('400 when name missing', async () => {
    const r = await request('POST', '/api/admin/operator/create', { pin: '510510' });
    expect(r.status).toBe(400);
  });

  test('409 on duplicate name (unique constraint)', async () => {
    db.query = jest.fn().mockRejectedValue(new Error('duplicate key value violates unique constraint'));
    const r = await request('POST', '/api/admin/operator/create', { pin: '510510', name: 'Ana' });
    expect(r.status).toBe(409);
  });
});

describe('PUT /api/admin/operator/:id', () => {
  test('edits + audit with before/after', async () => {
    let n = 0;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM operators/.test(sql)) {
        n++;
        return Promise.resolve({
          rows: [{ id: 5, name: 'Ana', role: n === 1 ? null : 'manager' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/operator/5', { pin: '510510', role: 'manager' });
    expect(r.status).toBe(200);
    const audit = findAudit('operator.edit');
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit[1][4]).role).toBeNull();
    expect(JSON.parse(audit[1][5]).role).toBe('manager');
  });

  test('404 when not found', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await request('PUT', '/api/admin/operator/999', { pin: '510510', name: 'Z' });
    expect(r.status).toBe(404);
  });

  test('400 when no fields supplied', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5, name: 'Ana' }] });
    const r = await request('PUT', '/api/admin/operator/5', { pin: '510510' });
    expect(r.status).toBe(400);
  });
});

describe('DELETE /api/admin/operator/:id (deactivate)', () => {
  test('sets active=false + audit (operator.deactivate)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM operators/.test(sql)) return Promise.resolve({ rows: [{ id: 5, name: 'Old', active: true }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await request('DELETE', '/api/admin/operator/5?pin=510510');
    expect(r.status).toBe(200);
    const updateCall = db.query.mock.calls.find((c) => /UPDATE operators SET active = FALSE/.test(c[0]));
    expect(updateCall).toBeTruthy();
    expect(findAudit('operator.deactivate')).toBeTruthy();
  });

  test('400 when already inactive', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5, active: false }] });
    const r = await request('DELETE', '/api/admin/operator/5?pin=510510');
    expect(r.status).toBe(400);
  });
});
