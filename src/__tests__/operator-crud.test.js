'use strict';
// OPERATOR-CRUD — full employee management endpoints (PARTE F).
jest.mock('../db');
jest.mock('../admin/audit', () => ({
  checkPin: jest.fn(() => true),
  auditAction: jest.fn().mockResolvedValue(),
  snapshotRow: jest.fn(),
}));
const db = require('../db');
const { auditAction, snapshotRow } = require('../admin/audit');
const express = require('express');
const http = require('http');

function req(method, url, body) {
  return new Promise((resolve) => {
    const app = express(); app.use(express.json());
    app.use('/api', require('../routes/api'));
    const s = app.listen(0, () => {
      const port = s.address().port;
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({ hostname: '127.0.0.1', port, path: url, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
        (res) => { let c = ''; res.on('data', d => c += d);
          res.on('end', () => { s.close(); let b; try { b = JSON.parse(c); } catch { b = c; } resolve({ status: res.statusCode, body: b }); }); });
      r.on('error', () => { s.close(); resolve({ status: 0 }); });
      if (data) r.write(data); r.end();
    });
  });
}
beforeEach(() => { jest.clearAllMocks(); snapshotRow.mockResolvedValue({ id: 7, name: 'X', is_temporary: true }); });

describe('OPERATOR-CRUD — create (permanent + helper)', () => {
  test('permanent → 200, audit operator.create, both active flags TRUE', async () => {
    const sqls = [];
    db.query = jest.fn((s, p) => { sqls.push({ s: String(s), p }); return Promise.resolve({ rows: [{ id: 7 }] }); });
    const r = await req('POST', '/api/admin/operators', { pin: '510510', name: 'João', role: 'operator' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id: 7, is_temporary: false });
    const ins = sqls.find(x => /INSERT INTO operators/.test(x.s));
    expect(ins.s).toMatch(/active, is_active, is_temporary, expires_at, hired_at/);
    expect(ins.s).toMatch(/TRUE, TRUE, \$4, \$5::timestamptz, NOW\(\)/);
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.create' }));
  });

  test('helper default 30d → expires_at ~30 days out, audit operator.create_helper', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 8 }] });
    const r = await req('POST', '/api/admin/operators', { pin: '510510', name: 'Maria', is_temporary: true });
    expect(r.status).toBe(200);
    expect(r.body.is_temporary).toBe(true);
    const days = (new Date(r.body.expires_at) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.create_helper' }));
  });

  test('helper explicit expires_at honored; bad role / no name → 400', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 9 }] });
    const ok = await req('POST', '/api/admin/operators', { pin: '510510', name: 'Zé', is_temporary: true, expires_at: '2026-06-01' });
    expect(ok.status).toBe(200);
    expect(ok.body.expires_at.slice(0, 10)).toBe('2026-06-01');
    expect((await req('POST', '/api/admin/operators', { pin: '510510', name: 'X', role: 'king' })).status).toBe(400);
    expect((await req('POST', '/api/admin/operators', { pin: '510510' })).status).toBe(400);
  });
});

describe('OPERATOR-CRUD — edit / deactivate / reactivate / promote', () => {
  test('PUT edits, invalid role 400, missing 404', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await req('PUT', '/api/admin/operators/7', { pin: '510510', name: 'Novo', role: 'manager' });
    expect(r.status).toBe(200);
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.edit' }));
    expect((await req('PUT', '/api/admin/operators/7', { pin: '510510', role: 'boss' })).status).toBe(400);
    snapshotRow.mockResolvedValueOnce(null);
    expect((await req('PUT', '/api/admin/operators/999', { pin: '510510', name: 'Z' })).status).toBe(404);
  });

  test('deactivate sets BOTH active+is_active FALSE, audited', async () => {
    const sqls = [];
    db.query = jest.fn((s) => { sqls.push(String(s)); return Promise.resolve({ rows: [] }); });
    const r = await req('POST', '/api/admin/operators/7/deactivate', { pin: '510510' });
    expect(r.status).toBe(200);
    expect(sqls.some(s => /UPDATE operators SET active = FALSE, is_active = FALSE/.test(s))).toBe(true);
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.deactivate' }));
  });

  test('reactivate sets BOTH TRUE, audited', async () => {
    const sqls = [];
    db.query = jest.fn((s) => { sqls.push(String(s)); return Promise.resolve({ rows: [] }); });
    const r = await req('POST', '/api/admin/operators/7/reactivate', { pin: '510510' });
    expect(r.status).toBe(200);
    expect(sqls.some(s => /UPDATE operators SET active = TRUE, is_active = TRUE/.test(s))).toBe(true);
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.reactivate' }));
  });

  test('promote helper → permanent (expires_at NULL); already permanent → 400', async () => {
    const sqls = [];
    db.query = jest.fn((s) => { sqls.push(String(s)); return Promise.resolve({ rows: [] }); });
    snapshotRow.mockResolvedValue({ id: 7, name: 'H', is_temporary: true });
    const r = await req('POST', '/api/admin/operators/7/promote', { pin: '510510' });
    expect(r.status).toBe(200);
    expect(sqls.some(s => /SET is_temporary = FALSE, expires_at = NULL/.test(s))).toBe(true);
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.promote' }));
    snapshotRow.mockResolvedValue({ id: 7, name: 'P', is_temporary: false });
    expect((await req('POST', '/api/admin/operators/7/promote', { pin: '510510' })).status).toBe(400);
  });
});

describe('OPERATOR-CRUD — delete guard + list filters', () => {
  test('DELETE blocked (409) when there is linked activity', async () => {
    snapshotRow.mockResolvedValue({ id: 7, name: 'Vitor' });
    db.query = jest.fn((s) => {
      if (/EXISTS\(SELECT 1 FROM operator_activity_log/.test(s)) return Promise.resolve({ rows: [{ oal: true, tasks: false, pauses: false }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await req('DELETE', '/api/admin/operators/7?pin=510510');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/desative em vez de excluir/i);
  });

  test('DELETE allowed (200) when no activity; missing → 404', async () => {
    snapshotRow.mockResolvedValue({ id: 7, name: 'NewGuy' });
    const sqls = [];
    db.query = jest.fn((s) => {
      sqls.push(String(s));
      if (/EXISTS\(SELECT 1 FROM operator_activity_log/.test(s)) return Promise.resolve({ rows: [{ oal: false, tasks: false, pauses: false }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await req('DELETE', '/api/admin/operators/7?pin=510510');
    expect(r.status).toBe(200);
    expect(sqls.some(s => /DELETE FROM operators WHERE id = \$1/.test(s))).toBe(true);
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.delete' }));
    snapshotRow.mockResolvedValueOnce(null);
    expect((await req('DELETE', '/api/admin/operators/999?pin=510510')).status).toBe(404);
  });

  test('GET applies role/status/type filters in SQL', async () => {
    let captured = '';
    db.query = jest.fn((s) => { if (/FROM operators/.test(s)) captured = String(s); return Promise.resolve({ rows: [] }); });
    await req('GET', '/api/admin/operators?pin=510510&role=manager&status=inactive&type=temp');
    expect(captured).toMatch(/COALESCE\(role,'operator'\) = \$1/);
    expect(captured).toMatch(/is_active = FALSE/);
    expect(captured).toMatch(/is_temporary = TRUE/);
    expect(captured).toMatch(/is_temporary, expires_at, hired_at/);
  });
});
