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

describe('phase_instances CRUD (Fase 2.4)', () => {
  test('GET list joins workflow_instances for product_name', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await request('GET', '/api/phase-instances?workflow_instance_id=5');
    expect(db.query.mock.calls[0][0]).toMatch(/LEFT JOIN workflow_instances/);
    expect(db.query.mock.calls[0][1]).toEqual([5]);
  });

  test('POST resolves phase_name from phase_template if not given', async () => {
    let inserted = false;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT name FROM phase_templates WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ name: 'Encapsulação' }] });
      }
      if (/INSERT INTO phase_instances/.test(sql)) {
        inserted = true;
        // Check that phase_name was passed as 'Encapsulação'
        expect(params[2]).toBe('Encapsulação');
        return Promise.resolve({ rows: [{ id: 50 }] });
      }
      if (/SELECT \* FROM phase_instances/.test(sql)) return Promise.resolve({ rows: [{ id: 50 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await request('POST', '/api/admin/phase-instances', {
      pin: '510510', workflow_instance_id: 10, phase_template_id: 3,
    });
    expect(r.status).toBe(200);
    expect(inserted).toBe(true);
  });

  test('PUT moving phase to another workflow → action="moved"', async () => {
    let auditAction = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT \* FROM phase_instances WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 50, workflow_instance_id: 10 }] });
      }
      if (/INSERT INTO admin_audit_log/.test(sql)) {
        auditAction = params[1];
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/phase-instances/50', {
      pin: '510510', workflow_instance_id: 20,
    });
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(true);
    expect(auditAction).toBe('phase_instance.moved');
  });

  test('PUT batch_number change → action="batch_changed" + batch_change_approved=false', async () => {
    let auditAction = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT \* FROM phase_instances WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 50, batch_number: null }] });
      }
      if (/UPDATE phase_instances SET/.test(sql)) {
        expect(sql).toMatch(/batch_change_approved = FALSE/);
        return Promise.resolve({ rows: [] });
      }
      if (/INSERT INTO admin_audit_log/.test(sql)) {
        auditAction = params[1];
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/phase-instances/50', {
      pin: '510510', batch_number: '0125',
    });
    expect(r.body.batch_changed).toBe(true);
    expect(auditAction).toBe('phase_instance.batch_changed');
  });

  test('DELETE soft deletes', async () => {
    let softDel = false;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM phase_instances WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 50 }] });
      }
      if (/UPDATE phase_instances SET status = 'deleted'/.test(sql)) {
        softDel = true; return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('DELETE', '/api/admin/phase-instances/50?pin=510510');
    expect(r.status).toBe(200);
    expect(softDel).toBe(true);
  });
});
