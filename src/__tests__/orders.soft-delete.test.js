'use strict';
/**
 * Regression for the bug found in prod (Entrega 2):
 *
 *   The dashboard's [Excluir] button on orders_sessions sends
 *   PUT /admin/order/:id with { status: 'deleted' }. The row was being
 *   updated correctly, but getTodayOrders() / getDayOrdersTotal() did
 *   not filter status='deleted' nor deleted_at IS NOT NULL, so the
 *   row kept showing in the dashboard list and counted in the total.
 *
 *   The fix is in src/orders.js: both list/total queries now require
 *     (status IS NULL OR status != 'deleted') AND deleted_at IS NULL
 */

jest.mock('../db');
const db = require('../db');
const orders = require('../orders');

beforeEach(() => { jest.clearAllMocks(); });

describe('getTodayOrders filters out soft-deleted rows', () => {
  test('SQL excludes status=\'deleted\' AND deleted_at IS NOT NULL', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await orders.getTodayOrders('2026-05-15');
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/FROM orders_sessions/);
    expect(sql).toMatch(/status IS NULL OR status\s*!=\s*'deleted'/);
    expect(sql).toMatch(/deleted_at IS NULL/);
  });

  test('today (date=null) uses ET current date + same filter', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await orders.getTodayOrders(null);
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/NOW\(\) AT TIME ZONE 'America\/New_York'/);
    expect(sql).toMatch(/status\s*!=\s*'deleted'/);
    expect(sql).toMatch(/deleted_at IS NULL/);
  });
});

describe('getDayOrdersTotal filters out soft-deleted rows', () => {
  test('SUM excludes deleted sessions (status + deleted_at)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ total: 100, session_count: 2 }] });
    await orders.getDayOrdersTotal('2026-05-15');
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/SUM\(order_count\)/);
    expect(sql).toMatch(/status\s*!=\s*'deleted'/);
    expect(sql).toMatch(/deleted_at IS NULL/);
  });

  test('a deleted row inserted between today and yesterday is not counted', async () => {
    // Simulate the SQL evaluation by checking the rows the mock receives.
    // (We can't run real SQL here, but we can confirm the WHERE clause
    // contains the right predicates against representative scenarios.)
    db.query = jest.fn().mockImplementation((sql) => {
      // Confirm both predicates present so a row with status='deleted'
      // OR with deleted_at != NULL would be excluded by Postgres.
      expect(sql).toMatch(/AND \(status IS NULL OR status\s*!=\s*'deleted'\)/);
      expect(sql).toMatch(/AND deleted_at IS NULL/);
      return Promise.resolve({ rows: [{ total: 0, session_count: 0 }] });
    });
    await orders.getDayOrdersTotal('2026-05-15');
  });
});

describe('PUT /admin/order/:id with status=\'deleted\' is the canonical soft-delete path', () => {
  // The frontend [Excluir] button on orders chips calls:
  //   PUT /api/admin/order/:id  { pin, status: 'deleted' }
  // Confirm the existing PUT endpoint accepts status — and that the row
  // it produces would be excluded by the list query above.
  jest.mock('../slack/client');
  jest.mock('../parser');
  jest.mock('../eod');

  const express = require('express');
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
          let chunks = ''; res.on('data', (c) => { chunks += c; });
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: chunks }); });
        });
        req.on('error', () => { server.close(); resolve({ status: 0 }); });
        if (data) req.write(data);
        req.end();
      });
    });
  }

  test('PUT /admin/order/:id with status=deleted updates the row + audits', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 99, status: 'open' }] });
    const r = await request('PUT', '/api/admin/order/99', { pin: '510510', status: 'deleted' });
    expect(r.status).toBe(200);
    const updateCall = db.query.mock.calls.find((c) =>
      /UPDATE orders_sessions SET[\s\S]*status\s*=\s*\$/.test(c[0])
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall[1]).toContain('deleted');
    const auditCall = db.query.mock.calls.find((c) =>
      /INSERT INTO admin_audit_log/.test(c[0]) && c[1][1] === 'orders_session.edit'
    );
    expect(auditCall).toBeTruthy();
  });
});
