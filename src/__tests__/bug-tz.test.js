'use strict';
// BUG TZ — the whole system is America/New_York (ET). DB stores UTC
// timestamptz; typed input is interpreted as ET; everything Carolina
// sees / renders is ET; am/pm parses; crons fire at ET.
const fs = require('fs');
const path = require('path');

jest.mock('../db');
const db = require('../db');
const btr = require('../workflow/break-time-reply');

beforeEach(() => { jest.clearAllMocks(); });

describe('BUG TZ — parseTimeReply handles am/pm glued to digits', () => {
  test.each([
    ['9:41am', { h: 9, m: 41 }],
    ['9:41 AM', { h: 9, m: 41 }],
    ['2pm', { h: 14, m: 0 }],
    ['9pm', { h: 21, m: 0 }],
    ['9 p.m.', { h: 21, m: 0 }],
    ['12am', { h: 0, m: 0 }],
    ['12pm', { h: 12, m: 0 }],
    ['1430', { h: 14, m: 30 }],
    ['21:41', { h: 21, m: 41 }],
  ])('"%s" → %j', (inp, exp) => {
    expect(btr.parseTimeReply(inp)).toEqual(exp);
  });

  test('"amanhã" is not mistaken for AM (no digit → null anyway)', () => {
    expect(btr.parseTimeReply('amanhã')).toBeNull();
    // a real time keeps its hour even with the word "amanhã" present
    expect(btr.parseTimeReply('amanhã 9:41')).toEqual({ h: 9, m: 41 });
  });
});

describe('BUG TZ — write boundary interprets typed times as ET', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'workflow.js'), 'utf8');
  test('no started_at/ended_at write uses a bare ::timestamptz cast', () => {
    expect(src).not.toMatch(/started_at = \$\$\{params\.length \+ 1\}::timestamptz/);
    expect(src).not.toMatch(/ended_at = \$\$\{params\.length \+ 1\}::timestamptz/);
  });
  test('typed-time writes use AT TIME ZONE America/New_York', () => {
    expect(src).toMatch(/started_at = \(\$\$\{params\.length \+ 1\}::timestamp AT TIME ZONE 'America\/New_York'\)/);
    expect(src).toMatch(/ended_at = \(\$\$\{params\.length \+ 1\}::timestamp AT TIME ZONE 'America\/New_York'\)/);
    // POST inserts too
    expect(src).toMatch(/COALESCE\(\(\$7::timestamp AT TIME ZONE 'America\/New_York'\), NOW\(\)\)/);
    expect(src).toMatch(/COALESCE\(\(\$5::timestamp AT TIME ZONE 'America\/New_York'\), NOW\(\)\)/);
    expect(src).toMatch(/\$6::timestamp AT TIME ZONE 'America\/New_York'/);
  });
});

describe('BUG TZ — Carolina tools emit ET strings, never raw UTC ISO', () => {
  const at = require('../ai/admin-tools');
  test('getState phases/adhoc started_at is "YYYY-MM-DD HH:MM" ET + tz marker', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/count\(\*\)/.test(sql)) return Promise.resolve({ rows: [{ n: 1 }] });
      if (/FROM phase_instances WHERE status='open'/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 5, phase_name: 'Enc', started_at: '2026-05-16T13:41:00.000Z' }] });
      }
      if (/FROM ad_hoc_task_instances WHERE status='open'/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 9, task_name: 'Limpeza', started_at: '2026-05-16T13:41:00.000Z' }] });
      }
      if (/FROM workflow_instances WHERE status='active'/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const s = await at.getState();
    expect(s.timezone).toMatch(/New_York|ET/);
    expect(s.phases[0].started_at).toBe('2026-05-16 09:41'); // 13:41Z = 09:41 ET
    expect(s.phases[0].started_at).not.toMatch(/Z|T\d\d:/);   // not a raw ISO
    expect(s.adhoc[0].started_at).toBe('2026-05-16 09:41');
  });

  test('getOperatorTimeline rows are ET strings', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [
      { activity_type: 'break', started_at: '2026-05-16T13:41:00.000Z', ended_at: '2026-05-16T14:00:00.000Z', phase_name: null },
    ] });
    const r = await at.getOperatorTimeline(7, '2026-05-16');
    expect(r[0].started_at).toBe('2026-05-16 09:41');
    expect(r[0].ended_at).toBe('2026-05-16 10:00');
    expect(r[0].tz).toBe('ET');
  });
});

describe('BUG TZ — Carolina system prompt forbids UTC/Brasília', () => {
  test('admin task prompt states ET-only and bans UTC/Brasília', () => {
    const dmSrc = fs.readFileSync(path.join(__dirname, '..', 'slack', 'dm-handler.js'), 'utf8');
    expect(dmSrc).toMatch(/FUSO HOR[ÁA]RIO/);
    expect(dmSrc).toMatch(/America\/New_York/);
    expect(dmSrc).toMatch(/NUNCA mencione "UTC"/);
    expect(dmSrc).toMatch(/Bras[íi]lia/);
  });
});

describe('BUG TZ — config single source + crons fire at ET', () => {
  test('config.tz = America/New_York', () => {
    const cfg = require('../config');
    expect(cfg.tz).toBe('America/New_York');
  });
  test('greeting/eod/detect crons pass timezone America/New_York', () => {
    const sch = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
    // every cron.schedule uses the ET timezone option
    const crons = sch.match(/cron\.schedule\(/g) || [];
    expect(crons.length).toBeGreaterThanOrEqual(3);
    expect(sch).toMatch(/timezone: config\.eod\.timezone/);
    expect(/cron\.schedule\([^)]*\{\s*timezone:\s*'UTC'/.test(sch)).toBe(false);
  });
});
