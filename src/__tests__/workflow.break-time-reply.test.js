'use strict';
jest.mock('../db');
const db = require('../db');
const btr = require('../workflow/break-time-reply');

beforeEach(() => { jest.clearAllMocks(); });

describe('B4 — parseTimeReply', () => {
  test.each([
    ['14:30', { h: 14, m: 30 }],
    ['14h30', { h: 14, m: 30 }],
    ['14 30', { h: 14, m: 30 }],
    ['1430', { h: 14, m: 30 }],
    ['930', { h: 9, m: 30 }],
    ['14h', { h: 14, m: 0 }],
    ['9', { h: 9, m: 0 }],
    ['2:05 pm', { h: 14, m: 5 }],
    ['8 da manhã', { h: 8, m: 0 }],
  ])('parses %s', (input, expected) => {
    expect(btr.parseTimeReply(input)).toEqual(expected);
  });

  test.each(['assfdf', '', 'não sei', 'depois te falo', '99:99', '25:00'])(
    'rejects %s', (input) => {
      expect(btr.parseTimeReply(input)).toBeNull();
    }
  );
});

describe('B4 — handleReply', () => {
  test('no pending → handled:false', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    expect(await btr.handleReply(5, '14:30')).toEqual({ handled: false });
  });

  test('valid time → resolved, updates pause + oal, clears pending', async () => {
    const seen = [];
    db.query = jest.fn().mockImplementation((sql) => {
      seen.push(sql);
      if (/SELECT value FROM app_state/.test(sql)) {
        return Promise.resolve({ rows: [{ value: JSON.stringify({ pauseId: 7, oalId: 9, attempts: 0, day: '2026-05-16' }) }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await btr.handleReply(5, 'saí 14:30');
    expect(r.outcome).toBe('resolved');
    expect(seen.some((s) => /UPDATE pauses[\s\S]*started_at/.test(s))).toBe(true);
    expect(seen.some((s) => /UPDATE operator_activity_log/.test(s))).toBe(true);
    expect(seen.some((s) => /DELETE FROM app_state/.test(s))).toBe(true);
  });

  test('invalid 1st time → retry attempts=1', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT value FROM app_state/.test(sql)) {
        return Promise.resolve({ rows: [{ value: JSON.stringify({ pauseId: 7, attempts: 0 }) }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await btr.handleReply(5, 'assfdf');
    expect(r).toEqual({ handled: true, outcome: 'retry', attempts: 1 });
  });

  test('invalid 2nd time → gaveup, started_at NULL', async () => {
    const seen = [];
    db.query = jest.fn().mockImplementation((sql) => {
      seen.push(sql);
      if (/SELECT value FROM app_state/.test(sql)) {
        return Promise.resolve({ rows: [{ value: JSON.stringify({ pauseId: 7, attempts: 1 }) }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await btr.handleReply(5, 'sei la');
    expect(r.outcome).toBe('gaveup');
    expect(seen.some((s) => /UPDATE pauses SET started_at = NULL/.test(s))).toBe(true);
    expect(seen.some((s) => /DELETE FROM app_state/.test(s))).toBe(true);
  });
});

describe('A1 — handleAdminRetroReply (admin-chat retroactive break)', () => {
  function withRetro() {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT value FROM app_state WHERE key = 'retro_break_admin'/.test(sql)) {
        return Promise.resolve({ rows: [{ value: JSON.stringify({
          operatorId: 4, opName: 'Simone', pauseId: 70, oalId: 80,
          returnedAt: '2026-05-16T18:00:00Z' }) }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  test('no pending → handled:false', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    expect(await btr.handleAdminRetroReply('14:30')).toEqual({ handled: false });
  });

  test('valid time → creates retroactive break + audits break.retroactive_create', async () => {
    withRetro();
    const audit = jest.fn().mockResolvedValue();
    const r = await btr.handleAdminRetroReply('saiu 14:30', { auditAction: audit });
    expect(r.outcome).toBe('created');
    expect(r.operatorName).toBe('Simone');
    const calls = db.query.mock.calls.map((c) => c[0]);
    expect(calls.some((s) => /UPDATE pauses[\s\S]*started_at/.test(s))).toBe(true);
    expect(calls.some((s) => /UPDATE operator_activity_log/.test(s))).toBe(true);
    expect(calls.some((s) => /DELETE FROM app_state WHERE key = 'retro_break_admin'/.test(s))).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'break.retroactive_create', source: 'slack_admin',
    }));
  });

  test('"ignora" → outcome ignored, clears pending, no audit', async () => {
    withRetro();
    const audit = jest.fn();
    const r = await btr.handleAdminRetroReply('ignora', { auditAction: audit });
    expect(r.outcome).toBe('ignored');
    expect(audit).not.toHaveBeenCalled();
  });

  test('garbage → unparsed (keeps pending)', async () => {
    withRetro();
    const r = await btr.handleAdminRetroReply('sei lá cara');
    expect(r.outcome).toBe('unparsed');
  });
});
