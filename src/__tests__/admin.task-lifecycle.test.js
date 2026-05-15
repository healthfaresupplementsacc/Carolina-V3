'use strict';
/**
 * Entrega 2 commit 7: task lifecycle endpoints + helpers in PUT.
 *
 * NEW:
 *   POST   /api/admin/task/:id/reopen
 *   DELETE /api/admin/task/:id            (status='deleted')
 *
 * EXTENDED:
 *   PUT    /api/admin/task/:id            now accepts helpers, task_type,
 *                                         status, description, closed_by.
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

describe('PUT /api/admin/task/:id — extended fields', () => {
  test('helpers, task_type, status, description, closed_by all editable', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM tasks/.test(sql)) return Promise.resolve({ rows: [{ id: 5, helpers: null, task_type: 'producao' }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/task/5', {
      pin: '510510',
      helpers: 'Ana, Bruno',
      task_type: 'revisao',
      status: 'closed',
      description: 'manutenção',
      closed_by: 'Vitor',
    });
    expect(r.status).toBe(200);
    const updateCall = db.query.mock.calls.find((c) =>
      /UPDATE tasks SET/.test(c[0]) && /helpers/.test(c[0]) && /task_type/.test(c[0])
    );
    expect(updateCall).toBeTruthy();
    expect(findAudit('task.edit')).toBeTruthy();
  });

  test('404 when task not found', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await request('PUT', '/api/admin/task/999', { pin: '510510', helpers: 'X' });
    expect(r.status).toBe(404);
  });
});

describe('POST /api/admin/task/:id/reopen', () => {
  test('closed task → open, clears ended_at/duration/closed_by + audit', async () => {
    let n = 0;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM tasks/.test(sql)) {
        n++;
        return Promise.resolve({
          rows: [{
            id: 5,
            status: n === 1 ? 'closed' : 'open',
            ended_at: n === 1 ? '2026-05-15T15:00:00Z' : null,
            closed_by: n === 1 ? 'Vitor' : null,
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('POST', '/api/admin/task/5/reopen', { pin: '510510' });
    expect(r.status).toBe(200);
    const updateCall = db.query.mock.calls.find((c) =>
      /UPDATE tasks SET[\s\S]*status = 'open'[\s\S]*ended_at = NULL/.test(c[0])
    );
    expect(updateCall).toBeTruthy();
    const audit = findAudit('task.reopen');
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit[1][4]).status).toBe('closed');
    expect(JSON.parse(audit[1][5]).status).toBe('open');
  });

  test('400 when task already open', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5, status: 'open' }] });
    const r = await request('POST', '/api/admin/task/5/reopen', { pin: '510510' });
    expect(r.status).toBe(400);
  });

  test('400 when task is deleted (must un-delete via PUT first)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5, status: 'deleted' }] });
    const r = await request('POST', '/api/admin/task/5/reopen', { pin: '510510' });
    expect(r.status).toBe(400);
  });

  test('404 when task not found', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await request('POST', '/api/admin/task/999/reopen', { pin: '510510' });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /api/admin/task/:id (soft delete)', () => {
  test('sets status=deleted + audit (task.delete)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM tasks/.test(sql)) return Promise.resolve({ rows: [{ id: 5, status: 'closed' }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await request('DELETE', '/api/admin/task/5?pin=510510');
    expect(r.status).toBe(200);
    const updateCall = db.query.mock.calls.find((c) =>
      /UPDATE tasks SET status = 'deleted'/.test(c[0])
    );
    expect(updateCall).toBeTruthy();
    expect(findAudit('task.delete')).toBeTruthy();
  });

  test('400 when already deleted', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5, status: 'deleted' }] });
    const r = await request('DELETE', '/api/admin/task/5?pin=510510');
    expect(r.status).toBe(400);
  });

  test('can delete an open task too', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM tasks/.test(sql)) return Promise.resolve({ rows: [{ id: 5, status: 'open' }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await request('DELETE', '/api/admin/task/5?pin=510510');
    expect(r.status).toBe(200);
  });
});
