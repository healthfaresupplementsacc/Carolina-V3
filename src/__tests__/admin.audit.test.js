'use strict';
/**
 * Entrega 2 commit 2: auditAction helper + retrofit on existing /admin/*
 * endpoints. Per the user's explicit ask:
 *   "TODOS os endpoints /admin/* existentes hoje [...] chamem auditAction().
 *    Sem exceção. A partir do deploy, qualquer ação admin tem log."
 *
 * These tests cover both the helper behavior and the retrofit on each pre-
 * existing /admin/* route. New endpoints (commits 3-9) bring their own
 * test files.
 */

jest.mock('../db');
jest.mock('../slack/client');
jest.mock('../parser');
jest.mock('../eod');

const db = require('../db');
const slackClient = require('../slack/client');
const parser = require('../parser');
const eod = require('../eod');

const { auditAction, snapshotRow, checkPin, getAdminPin } = require('../admin/audit');

beforeEach(() => {
  jest.clearAllMocks();
  // Default db.query: empty rows for every SELECT, return id=1 for RETURNING
  db.query = jest.fn().mockResolvedValue({ rows: [{ id: 1 }] });
  slackClient.postMessage = jest.fn().mockResolvedValue('1700000000.000001');
  slackClient.fetchMessages = jest.fn().mockResolvedValue([]);
  parser.parseMessage = jest.fn().mockReturnValue({ type: 'unknown' });
  parser.addCustomSupplement = jest.fn();
  parser.listSupplements = jest.fn().mockReturnValue([]);
  eod.handleProductionSummary = jest.fn().mockResolvedValue();
});

describe('auditAction helper', () => {
  test('writes a row with action/entity/before/after/source', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 99 }] });
    const id = await auditAction({
      req: { ip: '127.0.0.1', headers: { 'user-agent': 'jest' }, originalUrl: '/api/admin/task/1', method: 'PUT' },
      action: 'task.edit',
      entityType: 'task',
      entityId: 42,
      before: { id: 42, supplement_name: 'Berberina' },
      after: { id: 42, supplement_name: 'Berberine' },
    });
    expect(id).toBe(99);

    const call = db.query.mock.calls[0];
    expect(call[0]).toMatch(/INSERT INTO admin_audit_log/);
    const params = call[1];
    expect(params[1]).toBe('task.edit');
    expect(params[2]).toBe('task');
    expect(params[3]).toBe('42');
    // before / after serialized
    expect(JSON.parse(params[4])).toEqual({ id: 42, supplement_name: 'Berberina' });
    expect(JSON.parse(params[5])).toEqual({ id: 42, supplement_name: 'Berberine' });
    expect(params[6]).toBe('api');
    expect(JSON.parse(params[7])).toEqual(expect.objectContaining({ method: 'PUT', path: '/api/admin/task/1' }));
  });

  test('DB failure during audit does not throw (returns null + logs)', async () => {
    db.query = jest.fn().mockRejectedValue(new Error('connection lost'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation();
    const id = await auditAction({
      action: 'task.edit', entityType: 'task', entityId: 42,
    });
    expect(id).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('null before/after are stored as NULL, not JSON "null"', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    await auditAction({ action: 'broadcast', entityType: 'broadcast' });
    const params = db.query.mock.calls[0][1];
    expect(params[4]).toBeNull(); // before
    expect(params[5]).toBeNull(); // after
  });
});

describe('checkPin / getAdminPin', () => {
  const originalEnv = process.env.ADMIN_PIN;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ADMIN_PIN;
    else process.env.ADMIN_PIN = originalEnv;
  });

  test('falls back to legacy 510510 when ADMIN_PIN env not set', () => {
    delete process.env.ADMIN_PIN;
    expect(getAdminPin()).toBe('510510');
    expect(checkPin({ body: { pin: '510510' } })).toBe(true);
    expect(checkPin({ body: { pin: 'wrong'  } })).toBe(false);
  });

  test('honors ADMIN_PIN env var when set', () => {
    process.env.ADMIN_PIN = 'newpin42';
    expect(getAdminPin()).toBe('newpin42');
    expect(checkPin({ body: { pin: 'newpin42' } })).toBe(true);
    expect(checkPin({ body: { pin: '510510'   } })).toBe(false);
  });

  test('accepts pin via query string (for GET endpoints like /export)', () => {
    delete process.env.ADMIN_PIN;
    expect(checkPin({ query: { pin: '510510' } })).toBe(true);
  });

  test('rejects missing pin', () => {
    delete process.env.ADMIN_PIN;
    expect(checkPin({ body: {} })).toBe(false);
    expect(checkPin({})).toBe(false);
  });
});

describe('retrofit — every pre-existing /admin/* endpoint emits an audit row', () => {
  // Build a tiny express app that mounts the real router.
  const express = require('express');
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api', require('../routes/api'));
  });

  const request = (method, url, body) =>
    new Promise((resolve) => {
      const http = require('http');
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
            resolve({ status: res.statusCode, body: chunks ? safeJson(chunks) : null });
          });
        });
        req.on('error', () => { server.close(); resolve({ status: 0, body: null }); });
        if (data) req.write(data);
        req.end();
      });
    });

  function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

  function auditCallCount() {
    return db.query.mock.calls.filter((c) => /INSERT INTO admin_audit_log/.test(c[0])).length;
  }

  test('POST /admin/task/:id/close → 1 audit row (action=task.close)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5, supplement_name: 'X', status: 'open' }] });
    const r = await request('POST', '/api/admin/task/5/close', { pin: '510510' });
    expect(r.status).toBe(200);
    const auditCall = db.query.mock.calls.find((c) => /INSERT INTO admin_audit_log/.test(c[0]));
    expect(auditCall).toBeTruthy();
    expect(auditCall[1][1]).toBe('task.close');
    expect(auditCall[1][2]).toBe('task');
    expect(auditCall[1][3]).toBe('5');
  });

  test('PUT /admin/task/:id → action=task.edit', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5 }] });
    const r = await request('PUT', '/api/admin/task/5', { pin: '510510', supplement_name: 'Berberine' });
    expect(r.status).toBe(200);
    const auditCall = db.query.mock.calls.find((c) => /INSERT INTO admin_audit_log/.test(c[0]));
    expect(auditCall[1][1]).toBe('task.edit');
  });

  test('POST /admin/task/create → action=task.create', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 7 }] });
    const r = await request('POST', '/api/admin/task/create', { pin: '510510', supplement_name: 'Berberine' });
    expect(r.status).toBe(200);
    const auditCall = db.query.mock.calls.find((c) => /INSERT INTO admin_audit_log/.test(c[0]));
    expect(auditCall[1][1]).toBe('task.create');
  });

  test('PUT /admin/order/:id → action=orders_session.edit', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5 }] });
    const r = await request('PUT', '/api/admin/order/5', { pin: '510510', order_count: 100 });
    expect(r.status).toBe(200);
    const auditCall = db.query.mock.calls.find((c) => /INSERT INTO admin_audit_log/.test(c[0]));
    expect(auditCall[1][1]).toBe('orders_session.edit');
  });

  test('POST /admin/order/create → action=orders_session.create', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 8 }] });
    const r = await request('POST', '/api/admin/order/create', { pin: '510510', started_at: '2026-05-15 09:00' });
    expect(r.status).toBe(200);
    const auditCall = db.query.mock.calls.find((c) => /INSERT INTO admin_audit_log/.test(c[0]));
    expect(auditCall[1][1]).toBe('orders_session.create');
  });

  test('PUT /admin/formulation/:id → action=formulation.edit', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 3 }] });
    const r = await request('PUT', '/api/admin/formulation/3', { pin: '510510', supplement_name: 'NAC' });
    expect(r.status).toBe(200);
    const auditCall = db.query.mock.calls.find((c) => /INSERT INTO admin_audit_log/.test(c[0]));
    expect(auditCall[1][1]).toBe('formulation.edit');
  });

  test('POST /admin/broadcast → action=broadcast', async () => {
    const r = await request('POST', '/api/admin/broadcast', { pin: '510510', message: 'oi pessoal' });
    expect(r.status).toBe(200);
    const auditCall = db.query.mock.calls.find((c) => /INSERT INTO admin_audit_log/.test(c[0]));
    expect(auditCall[1][1]).toBe('broadcast');
  });

  test('POST /admin/supplement → action=supplement.create', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] }); // before snapshot empty → create
    const r = await request('POST', '/api/admin/supplement', { pin: '510510', canonical_name: 'Mullein', aliases: 'mulein' });
    expect(r.status).toBe(200);
    const auditCall = db.query.mock.calls.find((c) => /INSERT INTO admin_audit_log/.test(c[0]));
    expect(auditCall[1][1]).toBe('supplement.create');
  });

  test('DELETE /admin/supplement/:name → action=supplement.delete', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ canonical_name: 'OldX' }] });
    const r = await request('DELETE', '/api/admin/supplement/OldX?pin=510510');
    expect(r.status).toBe(200);
    const auditCall = db.query.mock.calls.find((c) => /INSERT INTO admin_audit_log/.test(c[0]));
    expect(auditCall[1][1]).toBe('supplement.delete');
  });

  test('POST /admin/set-total → action=set_total', async () => {
    const r = await request('POST', '/api/admin/set-total', { pin: '510510', total: 1234 });
    expect(r.status).toBe(200);
    const auditCall = db.query.mock.calls.find((c) => /INSERT INTO admin_audit_log/.test(c[0]));
    expect(auditCall[1][1]).toBe('set_total');
  });

  test('POST /admin/rescan-summary (no match) → action=rescan_summary.no_match', async () => {
    slackClient.fetchMessages = jest.fn().mockResolvedValue([]);
    const r = await request('POST', '/api/admin/rescan-summary', { pin: '510510' });
    expect(r.status).toBe(200);
    const auditCall = db.query.mock.calls.find((c) => /INSERT INTO admin_audit_log/.test(c[0]));
    expect(auditCall[1][1]).toBe('rescan_summary.no_match');
  });

  test('POST /cleanup-stale-tasks → action=cleanup_stale_tasks', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
    const r = await request('POST', '/api/cleanup-stale-tasks', { pin: '510510' });
    expect(r.status).toBe(200);
    const auditCall = db.query.mock.calls.find((c) => /INSERT INTO admin_audit_log/.test(c[0]));
    expect(auditCall[1][1]).toBe('cleanup_stale_tasks');
  });

  test('wrong PIN → 403 and NO audit row written', async () => {
    const r = await request('POST', '/api/admin/broadcast', { pin: 'wrong', message: 'x' });
    expect(r.status).toBe(403);
    const auditCall = db.query.mock.calls.find((c) => /INSERT INTO admin_audit_log/.test(c[0]));
    expect(auditCall).toBeFalsy();
  });
});
