'use strict';
/**
 * Bug N3 (smoke test report): breaks from previous days were stuck OPEN in
 * the DB (Ana at 8h53m+, Vitor older). cleanupStaleBreaks runs at boot to
 * auto-close any pause whose started_at (in America/New_York) is BEFORE
 * today, setting ended_at = started_at + 1h and ended_reason = 'auto_cleanup_stale'.
 *
 * Idempotent: same-day open breaks are NOT touched.
 */

jest.mock('pg', () => {
  const mPool = { query: jest.fn(), on: jest.fn(), end: jest.fn() };
  return { Pool: jest.fn(() => mPool) };
});

const { Pool } = require('pg');
const mockPool = new Pool();

// Lazy-require AFTER mock setup
const db = require('../db');

beforeEach(() => {
  mockPool.query.mockReset();
});

describe('N3 — cleanupStaleBreaks closes only PRE-TODAY open pauses', () => {
  test('UPDATE has correct WHERE: ended_at IS NULL + started_at date < today (ET)', async () => {
    mockPool.query.mockResolvedValue({ rows: [
      { id: 1, operator: 'Ana', started_at: '2026-05-13T20:00:00Z' },
    ]});

    await db.cleanupStaleBreaks();

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE pauses/);
    expect(sql).toMatch(/SET ended_at = started_at \+ INTERVAL '1 hour'/);
    expect(sql).toMatch(/ended_reason = 'auto_cleanup_stale'/);
    expect(sql).toMatch(/ended_at IS NULL/);
    expect(sql).toMatch(/started_at AT TIME ZONE 'America\/New_York'/);
    expect(sql).toMatch(/< \(NOW\(\) AT TIME ZONE 'America\/New_York'\)::date/);
    expect(sql).toMatch(/RETURNING id, operator, started_at/);
  });

  test('logs count when stale rows are closed', async () => {
    mockPool.query.mockResolvedValue({ rows: [
      { id: 7, operator: 'Ana', started_at: '2026-05-13T13:00:00Z' },
      { id: 8, operator: 'Vitor', started_at: '2026-05-12T16:00:00Z' },
    ]});

    const log = jest.spyOn(console, 'log').mockImplementation();
    const closed = await db.cleanupStaleBreaks();
    expect(closed.length).toBe(2);
    expect(log.mock.calls.some((c) => /N3 cleanup: closed 2 stale break/.test(c[0]))).toBe(true);
    log.mockRestore();
  });

  test('idempotent: subsequent calls return empty when nothing left to close', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });
    const closed = await db.cleanupStaleBreaks();
    expect(closed).toEqual([]);
  });

  test('survives DB error without throwing', async () => {
    mockPool.query.mockRejectedValue(new Error('connection lost'));
    const err = jest.spyOn(console, 'error').mockImplementation();
    const closed = await db.cleanupStaleBreaks();
    expect(closed).toEqual([]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
