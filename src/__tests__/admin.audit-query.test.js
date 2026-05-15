'use strict';
/**
 * Entrega 2 commit 9: audit log viewer endpoint.
 *
 * GET /api/admin/audit?pin=XXX
 *   &entity_type=task|pause|orders_session|...
 *   &entity_id=5
 *   &action=task.edit
 *   &since=YYYY-MM-DD
 *   &limit=100&offset=0
 *
 * Returns { rows, total, limit, offset }.
 */

jest.mock('../db');
jest.mock('../slack/client');
jest.mock('../parser');
jest.mock('../eod');

const db = require('../db');
const express = require('express');

beforeEach(() => { jest.clearAllMocks(); });

function request(method, url) {
  return new Promise((resolve) => {
    const http = require('http');
    const app = express();
    app.use(express.json());
    app.use('/api', require('../routes/api'));
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method }, (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          server.close();
          let parsed = null; try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', () => { server.close(); resolve({ status: 0, body: null }); });
      req.end();
    });
  });
}

describe('GET /api/admin/audit', () => {
  test('no filters → SELECT with no WHERE, default limit=100', async () => {
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 1, action: 'task.edit' }] })
      .mockResolvedValueOnce({ rows: [{ total: 17 }] });
    const r = await request('GET', '/api/admin/audit?pin=510510');
    expect(r.status).toBe(200);
    expect(r.body.rows.length).toBe(1);
    expect(r.body.total).toBe(17);
    expect(r.body.limit).toBe(100);
    expect(r.body.offset).toBe(0);

    const sel = db.query.mock.calls[0][0];
    expect(sel).toMatch(/FROM admin_audit_log/);
    expect(sel).not.toMatch(/WHERE/);
    expect(sel).toMatch(/ORDER BY created_at DESC/);
    expect(sel).toMatch(/LIMIT 100 OFFSET 0/);
  });

  test('filter by entity_type + entity_id', async () => {
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    await request('GET', '/api/admin/audit?pin=510510&entity_type=task&entity_id=5');
    const sel = db.query.mock.calls[0];
    expect(sel[0]).toMatch(/WHERE entity_type = \$1 AND entity_id\s+= \$2/);
    expect(sel[1]).toEqual(['task', '5']);
  });

  test('filter by action', async () => {
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    await request('GET', '/api/admin/audit?pin=510510&action=task.merge');
    const sel = db.query.mock.calls[0];
    expect(sel[0]).toMatch(/WHERE action\s+= \$1/);
    expect(sel[1]).toEqual(['task.merge']);
  });

  test('filter by since=YYYY-MM-DD', async () => {
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    await request('GET', '/api/admin/audit?pin=510510&since=2026-05-15');
    const sel = db.query.mock.calls[0];
    expect(sel[0]).toMatch(/created_at >= \$1::date/);
    expect(sel[1]).toEqual(['2026-05-15']);
  });

  test('invalid since= is dropped silently (no WHERE clause)', async () => {
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    await request('GET', '/api/admin/audit?pin=510510&since=garbage');
    const sel = db.query.mock.calls[0];
    expect(sel[0]).not.toMatch(/created_at >=/);
  });

  test('limit clamped to [1, 500]', async () => {
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    await request('GET', '/api/admin/audit?pin=510510&limit=99999');
    const sel = db.query.mock.calls[0][0];
    expect(sel).toMatch(/LIMIT 500/);
  });

  test('offset clamped to >= 0', async () => {
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    await request('GET', '/api/admin/audit?pin=510510&offset=-5');
    const sel = db.query.mock.calls[0][0];
    expect(sel).toMatch(/OFFSET 0/);
  });

  test('combined filters all parametrize', async () => {
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    await request('GET', '/api/admin/audit?pin=510510&entity_type=pause&action=pause.close&since=2026-05-15&limit=50&offset=10');
    const sel = db.query.mock.calls[0];
    expect(sel[0]).toMatch(/LIMIT 50 OFFSET 10/);
    expect(sel[1]).toEqual(['pause', 'pause.close', '2026-05-15']);
  });

  test('wrong pin → 403', async () => {
    const r = await request('GET', '/api/admin/audit?pin=wrong');
    expect(r.status).toBe(403);
  });
});
