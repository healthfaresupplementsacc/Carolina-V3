'use strict';
/**
 * Entrega 3 Fase 2.1 — API CRUD for workflow_templates.
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

describe('workflow_templates GET endpoints', () => {
  test('GET /api/workflow-templates returns only active by default', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [
      { id: 1, name: 'Produção de Suplemento', is_active: true },
      { id: 2, name: 'Picking & Packing', is_active: true },
    ]});
    const r = await request('GET', '/api/workflow-templates');
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(2);
    expect(db.query.mock.calls[0][0]).toMatch(/WHERE is_active = TRUE/);
  });

  test('GET ?include_inactive=1 returns all', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await request('GET', '/api/workflow-templates?include_inactive=1');
    expect(db.query.mock.calls[0][0]).not.toMatch(/WHERE is_active/);
  });

  test('GET /api/workflow-templates/:id returns workflow with phases nested', async () => {
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Produção de Suplemento', allows_product: true }] })
      .mockResolvedValueOnce({ rows: [
        { id: 10, name: 'Formulação', sequence_order: 1 },
        { id: 11, name: 'Mix', sequence_order: 2 },
      ]});
    const r = await request('GET', '/api/workflow-templates/1');
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Produção de Suplemento');
    expect(r.body.phases.length).toBe(2);
    expect(r.body.phases[0].name).toBe('Formulação');
  });

  test('GET /api/workflow-templates/:id 404 when missing', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await request('GET', '/api/workflow-templates/999');
    expect(r.status).toBe(404);
  });

  test('GET /api/workflow-templates/:id rejects non-numeric id', async () => {
    const r = await request('GET', '/api/workflow-templates/abc');
    expect(r.status).toBe(400);
  });
});

describe('workflow_templates admin endpoints', () => {
  test('POST without PIN → 403', async () => {
    const r = await request('POST', '/api/admin/workflow-templates', { name: 'X' });
    expect(r.status).toBe(403);
  });

  test('POST with valid PIN creates + audits', async () => {
    let inserted = false, audited = false;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/INSERT INTO workflow_templates/.test(sql)) {
        inserted = true;
        return Promise.resolve({ rows: [{ id: 42 }] });
      }
      if (/SELECT \* FROM workflow_templates/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 42, name: 'New', allows_product: false }] });
      }
      if (/INSERT INTO admin_audit_log/.test(sql)) {
        audited = true;
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('POST', '/api/admin/workflow-templates', {
      pin: '510510', name: 'New', description: 'desc', allows_product: false,
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(42);
    expect(inserted).toBe(true);
    expect(audited).toBe(true);
  });

  test('POST returns 400 without name', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await request('POST', '/api/admin/workflow-templates', { pin: '510510' });
    expect(r.status).toBe(400);
  });

  test('POST returns 409 on duplicate name', async () => {
    db.query = jest.fn().mockRejectedValue(new Error('duplicate key value violates unique constraint'));
    const r = await request('POST', '/api/admin/workflow-templates', { pin: '510510', name: 'Existing' });
    expect(r.status).toBe(409);
  });

  test('PUT edits and audits', async () => {
    let audited = false;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT \* FROM workflow_templates/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, name: 'Before' }] });
      }
      if (/INSERT INTO admin_audit_log/.test(sql)) { audited = true; return Promise.resolve({ rows: [{ id: 1 }] }); }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('PUT', '/api/admin/workflow-templates/1', {
      pin: '510510', description: 'updated',
    });
    expect(r.status).toBe(200);
    expect(audited).toBe(true);
  });

  test('PUT returns 404 when not found', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] }); // snapshot returns no row
    const r = await request('PUT', '/api/admin/workflow-templates/999', { pin: '510510' });
    expect(r.status).toBe(404);
  });

  test('DELETE soft-deletes (is_active=false) and reports active instances', async () => {
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT \* FROM workflow_templates/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, name: 'X', is_active: true }] });
      }
      if (/SELECT COUNT\(\*\)::int AS n FROM workflow_instances/.test(sql)) {
        return Promise.resolve({ rows: [{ n: 3 }] });
      }
      if (/UPDATE workflow_templates SET is_active = FALSE/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('DELETE', '/api/admin/workflow-templates/1?pin=510510');
    expect(r.status).toBe(200);
    expect(r.body.warning).toMatch(/3 inst[âa]ncia/);
  });

  test('DELETE returns 404 when not found', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await request('DELETE', '/api/admin/workflow-templates/999?pin=510510');
    expect(r.status).toBe(404);
  });
});
