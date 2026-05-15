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

describe('ad_hoc_tasks CRUD (Fase 2.5)', () => {
  test('GET pending_only=1 filters admin_approved=false', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await request('GET', '/api/ad-hoc-tasks?pending_only=1');
    expect(db.query.mock.calls[0][0]).toMatch(/admin_approved = FALSE/);
  });

  test('POST creates with admin_approved defaulting to true', async () => {
    let captured = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/INSERT INTO ad_hoc_tasks/.test(sql)) {
        captured = params;
        return Promise.resolve({ rows: [{ id: 99 }] });
      }
      if (/SELECT \* FROM ad_hoc_tasks/.test(sql)) return Promise.resolve({ rows: [{ id: 99 }] });
      return Promise.resolve({ rows: [] });
    });
    await request('POST', '/api/admin/ad-hoc-tasks', { pin: '510510', name: 'NewTask' });
    expect(captured[2]).toBe(true);
  });

  test('POST 409 on duplicate name', async () => {
    db.query = jest.fn().mockRejectedValue(new Error('duplicate key value violates unique constraint'));
    const r = await request('POST', '/api/admin/ad-hoc-tasks', { pin: '510510', name: 'Limpeza' });
    expect(r.status).toBe(409);
  });

  test('PUT toggling admin_approved=false→true → action=approve', async () => {
    let auditAction = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT \* FROM ad_hoc_tasks WHERE id/.test(sql)) {
        // First snapshot (before): admin_approved=false
        // Second snapshot (after): admin_approved=true
        return Promise.resolve({
          rows: [{ id: 5, admin_approved: db.query.mock.calls.filter((c) => /SELECT \* FROM ad_hoc_tasks/.test(c[0])).length > 1 ? true : false }],
        });
      }
      if (/INSERT INTO admin_audit_log/.test(sql)) {
        auditAction = params[1];
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/ad-hoc-tasks/5', { pin: '510510', admin_approved: true });
    expect(r.status).toBe(200);
    expect(auditAction).toBe('ad_hoc_task.approve');
  });

  test('POST /merge-into re-points instances + deactivates source', async () => {
    let repointed = false, sourceDeactivated = false;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT \* FROM ad_hoc_tasks WHERE id = \$1 LIMIT 1/.test(sql)) {
        const id = params[0];
        if (id === 7)  return Promise.resolve({ rows: [{ id: 7, name: 'limpando', admin_approved: false }] });
        if (id === 1)  return Promise.resolve({ rows: [{ id: 1, name: 'Limpeza', admin_approved: true }] });
        return Promise.resolve({ rows: [] });
      }
      if (/UPDATE ad_hoc_task_instances\s+SET ad_hoc_task_id/.test(sql)) { repointed = true; return Promise.resolve({ rows: [] }); }
      if (/UPDATE ad_hoc_tasks\s+SET is_active = FALSE/.test(sql)) { sourceDeactivated = true; return Promise.resolve({ rows: [] }); }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('POST', '/api/admin/ad-hoc-tasks/7/merge-into/1', { pin: '510510' });
    expect(r.status).toBe(200);
    expect(r.body.merged_into).toBe(1);
    expect(repointed).toBe(true);
    expect(sourceDeactivated).toBe(true);
  });

  test('POST /merge-into rejects same id', async () => {
    const r = await request('POST', '/api/admin/ad-hoc-tasks/5/merge-into/5', { pin: '510510' });
    expect(r.status).toBe(400);
  });
});

describe('ad_hoc_task_instances CRUD', () => {
  test('GET joins ad_hoc_tasks for admin_approved flag', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await request('GET', '/api/ad-hoc-task-instances');
    expect(db.query.mock.calls[0][0]).toMatch(/LEFT JOIN ad_hoc_tasks/);
  });

  test('PUT can set linked_workflow_instance_id (fallback duplo)', async () => {
    let linkedSet = false;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT \* FROM ad_hoc_task_instances WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 10 }] });
      }
      if (/UPDATE ad_hoc_task_instances SET/.test(sql)) {
        if (/linked_workflow_instance_id/.test(sql)) linkedSet = true;
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/ad-hoc-task-instances/10', {
      pin: '510510', linked_workflow_instance_id: 99,
    });
    expect(r.status).toBe(200);
    expect(linkedSet).toBe(true);
  });

  test('DELETE soft deletes', async () => {
    let softDel = false;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM ad_hoc_task_instances WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 10 }] });
      }
      if (/UPDATE ad_hoc_task_instances SET status = 'deleted'/.test(sql)) {
        softDel = true; return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('DELETE', '/api/admin/ad-hoc-task-instances/10?pin=510510');
    expect(r.status).toBe(200);
    expect(softDel).toBe(true);
  });
});
