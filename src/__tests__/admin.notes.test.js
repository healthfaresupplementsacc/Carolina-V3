'use strict';
/**
 * Entrega 2 commit 6: note editing endpoints.
 *
 * GET    /api/admin/notes?date=YYYY-MM-DD
 * PUT    /api/admin/note/:ts
 * DELETE /api/admin/note/:ts  (soft delete via deleted_at)
 *
 * Notes live as rows in `messages` with parsed_type='note'. Their
 * canonical ID is slack_ts (string with decimals, dot-separated).
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

describe('GET /api/admin/notes', () => {
  test('returns notes (parsed_type=note, deleted_at IS NULL) for date', async () => {
    db.query = jest.fn().mockResolvedValue({
      rows: [
        { slack_ts: '1700000001.000000', text: 'manutenção da maquina', linked_task_id: null, deleted_at: null },
      ],
    });
    const r = await request('GET', '/api/admin/notes?pin=510510&date=2026-05-15');
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(1);
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/parsed_type = 'note'/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/'2026-05-15'::date/);
  });
});

describe('PUT /api/admin/note/:ts', () => {
  test('edits text + writes audit (note.edit)', async () => {
    let n = 0;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM messages WHERE slack_ts = \$1/.test(sql)) {
        n++;
        return Promise.resolve({
          rows: [{ slack_ts: '1700000001.000000', text: n === 1 ? 'old' : 'new', linked_task_id: null }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/note/1700000001.000000', {
      pin: '510510', text: 'new',
    });
    expect(r.status).toBe(200);
    const audit = findAudit('note.edit');
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit[1][4]).text).toBe('old');
    expect(JSON.parse(audit[1][5]).text).toBe('new');
  });

  test('links to a task', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM messages/.test(sql)) return Promise.resolve({ rows: [{ slack_ts: '1700000001.000000', linked_task_id: null }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/note/1700000001.000000', {
      pin: '510510', linked_task_id: 42,
    });
    expect(r.status).toBe(200);
    const updateCall = db.query.mock.calls.find((c) =>
      /UPDATE messages SET linked_task_id/.test(c[0])
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall[1][0]).toBe(42);
  });

  test('404 when not found', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await request('PUT', '/api/admin/note/9999.000000', { pin: '510510', text: 'X' });
    expect(r.status).toBe(404);
  });

  test('400 when nothing to update', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ slack_ts: '1700000001.000000' }] });
    const r = await request('PUT', '/api/admin/note/1700000001.000000', { pin: '510510' });
    expect(r.status).toBe(400);
  });
});

describe('DELETE /api/admin/note/:ts (soft delete)', () => {
  test('sets deleted_at + audit (note.delete)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM messages/.test(sql)) return Promise.resolve({ rows: [{ slack_ts: '1700000001.000000', deleted_at: null }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await request('DELETE', '/api/admin/note/1700000001.000000?pin=510510');
    expect(r.status).toBe(200);
    const updateCall = db.query.mock.calls.find((c) =>
      /UPDATE messages SET deleted_at = NOW\(\)/.test(c[0])
    );
    expect(updateCall).toBeTruthy();
    expect(findAudit('note.delete')).toBeTruthy();
  });

  test('400 when already deleted', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ slack_ts: '1700000001.000000', deleted_at: '2026-05-15' }] });
    const r = await request('DELETE', '/api/admin/note/1700000001.000000?pin=510510');
    expect(r.status).toBe(400);
  });
});
