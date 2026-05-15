'use strict';
jest.mock('../db');
const db = require('../db');
const express = require('express');
const http = require('http');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes/workflow'));
  return app;
}
function request(method, url, body) {
  return new Promise((resolve) => {
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
beforeEach(() => { jest.clearAllMocks(); });

describe('operator_activity_log (Fase 2.6)', () => {
  test('GET joins operators + phase_instances + ad_hoc + workflow for display', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await request('GET', '/api/operator-activity-log?operator_id=1&date=2026-05-15');
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/LEFT JOIN operators o/);
    expect(sql).toMatch(/LEFT JOIN phase_instances pi/);
    expect(sql).toMatch(/LEFT JOIN workflow_instances wi/);
    expect(sql).toMatch(/LEFT JOIN ad_hoc_task_instances ati/);
    expect(db.query.mock.calls[0][1]).toEqual([1, '2026-05-15']);
  });

  test('GET active_only=1 filters ended_at IS NULL', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await request('GET', '/api/operator-activity-log?active_only=1');
    expect(db.query.mock.calls[0][0]).toMatch(/ended_at IS NULL/);
  });

  test('PUT validates activity_type enum', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM operator_activity_log/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, activity_type: 'phase' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/operator-activity-log/1', {
      pin: '510510', activity_type: 'bogus',
    });
    expect(r.status).toBe(400);
  });

  test('PUT recomputes duration_seconds when both timestamps present', async () => {
    let updSql = null;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM operator_activity_log/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      if (/UPDATE operator_activity_log SET/.test(sql)) {
        updSql = sql; return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    await request('PUT', '/api/admin/operator-activity-log/1', {
      pin: '510510', ended_at: '2026-05-15T15:00:00Z',
    });
    expect(updSql).toMatch(/duration_seconds = CASE WHEN ended_at IS NOT NULL/);
  });

  test('DELETE hard-deletes (no soft column in this table)', async () => {
    let deleted = false;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM operator_activity_log/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      if (/^DELETE FROM operator_activity_log/.test(sql)) {
        deleted = true; return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('DELETE', '/api/admin/operator-activity-log/1?pin=510510');
    expect(r.status).toBe(200);
    expect(deleted).toBe(true);
  });

  test('POST /move-operator with prior active row closes it and links', async () => {
    const ops = [];
    db.query = jest.fn().mockImplementation((sql, params) => {
      ops.push({ sql: sql.slice(0, 60), params });
      if (/FROM operator_activity_log\s+WHERE operator_id = \$1 AND ended_at IS NULL/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 100 }] }); // previous active row
      }
      if (/INSERT INTO operator_activity_log/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 200 }] });
      }
      if (/UPDATE operator_activity_log\s+SET ended_at = \$1/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('POST', '/api/admin/move-operator', {
      pin: '510510', operator_id: 5, target_phase_instance_id: 99,
    });
    expect(r.status).toBe(200);
    expect(r.body.new_oal_id).toBe(200);
    expect(r.body.previous_oal_id).toBe(100);

    const insertCall = ops.find((o) => /INSERT INTO operator_activity_log/.test(o.sql));
    expect(insertCall.params[6]).toBe(100); // came_back_from_id = previousId
    const closeCall = ops.find((o) => /UPDATE operator_activity_log\s+SET ended_at/.test(o.sql));
    expect(closeCall.params[1]).toBe(200); // left_for_id = newId
    expect(closeCall.params[2]).toBe(100);
  });

  test('POST /move-operator rejects both targets at once', async () => {
    const r = await request('POST', '/api/admin/move-operator', {
      pin: '510510', operator_id: 5,
      target_phase_instance_id: 99,
      target_ad_hoc_task_instance_id: 88,
    });
    expect(r.status).toBe(400);
  });

  test('POST /move-operator rejects neither target', async () => {
    const r = await request('POST', '/api/admin/move-operator', {
      pin: '510510', operator_id: 5,
    });
    expect(r.status).toBe(400);
  });

  test('POST /move-operator with no prior active row works', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/WHERE operator_id = \$1 AND ended_at IS NULL/.test(sql)) {
        return Promise.resolve({ rows: [] }); // no prior
      }
      if (/INSERT INTO operator_activity_log/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 200 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('POST', '/api/admin/move-operator', {
      pin: '510510', operator_id: 5, target_ad_hoc_task_instance_id: 88,
    });
    expect(r.status).toBe(200);
    expect(r.body.previous_oal_id).toBeNull();
  });
});
