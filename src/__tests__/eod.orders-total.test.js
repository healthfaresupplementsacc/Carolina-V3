'use strict';
/**
 * B14: orders_sessions counts must contribute to the day's totals (not be
 * dropped silently). getDayOrdersTotal sums every session's order_count and
 * is wired into the dashboard payload + the EOD summary.
 */

jest.mock('../db');

const db = require('../db');
const orders = require('../orders');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('B14 — getDayOrdersTotal', () => {
  test('returns total and sessionCount from SUM aggregation', async () => {
    db.query = jest.fn().mockResolvedValue({
      rows: [{ total: 255, session_count: 2 }],
    });

    const result = await orders.getDayOrdersTotal('2026-05-14');
    expect(result).toEqual({ total: 255, sessionCount: 2 });

    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/SUM\(order_count\)/);
    expect(sql).toMatch(/COUNT\(\*\)/);
    expect(sql).toMatch(/orders_sessions/);
  });

  test('returns zero when no sessions for that date', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ total: 0, session_count: 0 }] });
    const result = await orders.getDayOrdersTotal('2026-05-14');
    expect(result).toEqual({ total: 0, sessionCount: 0 });
  });

  test('handles empty rows gracefully', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const result = await orders.getDayOrdersTotal('2026-05-14');
    expect(result).toEqual({ total: 0, sessionCount: 0 });
  });

  test('uses today (ET) when date is null', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ total: 100, session_count: 1 }] });
    await orders.getDayOrdersTotal(null);
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/NOW\(\) AT TIME ZONE 'America\/New_York'/);
  });
});
