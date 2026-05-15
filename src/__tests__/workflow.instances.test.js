'use strict';
/**
 * Entrega 3 Fase 2.3 — workflow_instances CRUD + merge.
 */

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

describe('workflow_instances list + detail', () => {
  test('GET defaults to status<>deleted', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await request('GET', '/api/workflow-instances');
    expect(db.query.mock.calls[0][0]).toMatch(/status <> 'deleted'/);
  });

  test('GET with status=active filters correctly', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await request('GET', '/api/workflow-instances?status=active');
    expect(db.query.mock.calls[0][1]).toEqual(['active']);
  });

  test('GET /workflow-instances/:id returns instance with phases', async () => {
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 5, product_name: 'Green Tea', batch_number: '0098' }] })
      .mockResolvedValueOnce({ rows: [{ id: 50, phase_name: 'Formulação' }] });
    const r = await request('GET', '/api/workflow-instances/5');
    expect(r.status).toBe(200);
    expect(r.body.product_name).toBe('Green Tea');
    expect(r.body.phases.length).toBe(1);
  });
});

describe('workflow_instances admin create + edit', () => {
  test('POST creates + audits', async () => {
    let audited = false;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/INSERT INTO workflow_instances/.test(sql)) return Promise.resolve({ rows: [{ id: 100 }] });
      if (/SELECT \* FROM workflow_instances/.test(sql)) return Promise.resolve({ rows: [{ id: 100 }] });
      if (/INSERT INTO admin_audit_log/.test(sql)) { audited = true; return Promise.resolve({ rows: [{ id: 1 }] }); }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('POST', '/api/admin/workflow-instances', {
      pin: '510510', workflow_template_id: 1, product_name: 'Green Tea',
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(100);
    expect(audited).toBe(true);
  });

  test('POST 400 without workflow_template_id', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await request('POST', '/api/admin/workflow-instances', { pin: '510510' });
    expect(r.status).toBe(400);
  });

  test('PUT batch_number change → batch_change_approved=false + action="batch_changed"', async () => {
    let auditAction = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT \* FROM workflow_instances WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, batch_number: null }] });
      }
      if (/UPDATE workflow_instances SET/.test(sql)) {
        // Check that the SET clause includes batch_change_approved = FALSE
        expect(sql).toMatch(/batch_change_approved = FALSE/);
        return Promise.resolve({ rows: [] });
      }
      if (/INSERT INTO admin_audit_log/.test(sql)) {
        auditAction = params[1]; // 2nd param is action
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/workflow-instances/1', {
      pin: '510510', batch_number: '0125',
    });
    expect(r.status).toBe(200);
    expect(r.body.batch_changed).toBe(true);
    expect(auditAction).toBe('workflow_instance.batch_changed');
  });

  test('PUT without batch change → normal edit action', async () => {
    let auditAction = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT \* FROM workflow_instances WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, batch_number: '0125' }] });
      }
      if (/INSERT INTO admin_audit_log/.test(sql)) {
        auditAction = params[1];
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/workflow-instances/1', {
      pin: '510510', notes: 'just notes',
    });
    expect(r.status).toBe(200);
    expect(r.body.batch_changed).toBe(false);
    expect(auditAction).toBe('workflow_instance.edit');
  });

  test('DELETE soft-deletes AND cascades phase_instances', async () => {
    let mainDel = false, cascDel = false;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM workflow_instances WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, status: 'active' }] });
      }
      if (/UPDATE workflow_instances SET status = 'deleted'/.test(sql)) {
        mainDel = true; return Promise.resolve({ rows: [] });
      }
      if (/UPDATE phase_instances SET status = 'deleted'/.test(sql)) {
        cascDel = true; return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('DELETE', '/api/admin/workflow-instances/1?pin=510510');
    expect(r.status).toBe(200);
    expect(mainDel).toBe(true);
    expect(cascDel).toBe(true);
  });
});

describe('workflow_instances merge', () => {
  test('POST /merge picks oldest as survivor + re-points phases + soft-deletes others', async () => {
    const ops = [];
    db.query = jest.fn().mockImplementation((sql, params) => {
      ops.push({ sql: sql.slice(0, 80), params });
      if (/FROM workflow_instances\s+WHERE id = ANY/.test(sql)) {
        return Promise.resolve({ rows: [
          { id: 10, started_at: '2026-05-10T10:00Z', status: 'active' },
          { id: 11, started_at: '2026-05-10T11:00Z', status: 'active' },
          { id: 12, started_at: '2026-05-10T12:00Z', status: 'active' },
        ]});
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('POST', '/api/admin/workflow-instances/merge', {
      pin: '510510', instance_ids: [11, 10, 12],
    });
    expect(r.status).toBe(200);
    expect(r.body.survivor_id).toBe(10);
    expect(r.body.merged_ids.sort()).toEqual([11, 12]);

    const repoint = ops.find((o) => /UPDATE phase_instances SET workflow_instance_id/.test(o.sql));
    expect(repoint.params).toEqual([10, [11, 12]]);
    const softDel = ops.find((o) => /UPDATE workflow_instances\s+SET status = 'deleted'/.test(o.sql));
    expect(softDel.params).toEqual([10, [11, 12]]);
  });

  test('POST /merge rejects with <2 ids', async () => {
    const r = await request('POST', '/api/admin/workflow-instances/merge', {
      pin: '510510', instance_ids: [10],
    });
    expect(r.status).toBe(400);
  });

  test('POST /merge rejects if some id missing', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 10 }] });
    const r = await request('POST', '/api/admin/workflow-instances/merge', {
      pin: '510510', instance_ids: [10, 11],
    });
    expect(r.status).toBe(400);
  });
});
