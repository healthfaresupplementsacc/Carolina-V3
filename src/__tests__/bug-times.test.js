'use strict';
// BUG TIMES — Carolina recited 3-5h breaks as fact. A break that long
// is impossible (forgotten "Voltei"). Tools now flag duration_suspicious
// (>90min) and the prompt makes her call it out + offer fix/discard.
jest.mock('../db');
const db = require('../db');
const at = require('../ai/admin-tools');
const fs = require('fs');
const path = require('path');

beforeEach(() => { jest.clearAllMocks(); });

// 10:00 AM → 1:53 PM = 3h53m (suspicious); 5:24 PM open (short, fine);
// a tidy 30-min break (not suspicious).
function wireOal() {
  db.query = jest.fn((sql, p) => {
    if (/FROM operators\s+WHERE LOWER\(name\)/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 3, name: 'Simone' }] });
    }
    if (/FROM operator_activity_log oal\s+JOIN operators o/.test(sql)) {
      return Promise.resolve({ rows: [
        { activity_type: 'break', started_at: '2026-05-16T14:00:00.000Z',
          ended_at: '2026-05-16T17:53:00.000Z', phase_name: null,
          operator: 'Simone', duration_minutes: 233 },               // 3h53
        { activity_type: 'break', started_at: '2026-05-16T19:00:00.000Z',
          ended_at: '2026-05-16T19:30:00.000Z', phase_name: null,
          operator: 'Simone', duration_minutes: 30 },                // ok
        { activity_type: 'break', started_at: '2026-05-16T21:24:00.000Z',
          ended_at: null, phase_name: null,
          operator: 'Simone', duration_minutes: 5 },                 // ongoing, short
      ] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('BUG TIMES — duration_suspicious flag (>90min)', () => {
  test('get_breaks_today flags the 3-5h break, not the 30-min one', async () => {
    wireOal();
    const r = await at.getBreaksToday('2026-05-16');
    expect(r.has_suspicious).toBe(true);
    expect(r.suspicious_count).toBe(1);
    expect(r.suspicious_threshold_min).toBe(90);
    const long = r.breaks.find((b) => b.duration_minutes === 233);
    const short = r.breaks.find((b) => b.duration_minutes === 30);
    expect(long.duration_suspicious).toBe(true);
    expect(short.duration_suspicious).toBe(false);
    expect(r.note).toMatch(/Voltei|impossível/i);
  });

  test('getOperatorTimeline tags suspicious break rows', async () => {
    wireOal();
    const rows = await at.getOperatorTimeline('Simone', '2026-05-16');
    const long = rows.find((x) => x.duration_minutes === 233);
    const ok = rows.find((x) => x.duration_minutes === 30);
    expect(long.duration_suspicious).toBe(true);
    expect(ok.duration_suspicious).toBe(false);
  });

  test('runTool envelope surfaces has_suspicious for the asked operator', async () => {
    wireOal();
    const env = await at.runTool('get_operator_timeline', { operator: 'Simone' });
    expect(env.has_suspicious).toBe(true);
    expect(env.suspicious_count).toBe(1);
    expect(env.note).toMatch(/Voltei|impossível/i);
  });

  test('30-min only day → no suspicious flag, no note', async () => {
    db.query = jest.fn((sql) => {
      if (/FROM operator_activity_log oal\s+JOIN operators o/.test(sql)) {
        return Promise.resolve({ rows: [
          { operator: 'Vitor', started_at: '2026-05-16T18:00:00.000Z',
            ended_at: '2026-05-16T18:30:00.000Z', duration_minutes: 30 },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await at.getBreaksToday('2026-05-16');
    expect(r.has_suspicious).toBe(false);
    expect(r.suspicious_count).toBe(0);
    expect(r.note).toBeUndefined();
    expect(r.breaks[0].duration_suspicious).toBe(false);
  });

  test('get_breaks_today is a registered read tool', () => {
    expect(at.READ_TOOLS.has('get_breaks_today')).toBe(true);
    expect(at.TOOL_DEFS.find((t) => t.name === 'get_breaks_today')).toBeTruthy();
  });
});

describe('BUG TIMES — Carolina is told to call it out', () => {
  test('prompt instructs commenting + offering fix/discard on suspicious breaks', () => {
    const dm = fs.readFileSync(path.join(__dirname, '..', 'slack', 'dm-handler.js'), 'utf8');
    expect(dm).toMatch(/DURAÇÃO SUSPEITA|duration_suspicious/);
    expect(dm).toMatch(/90min/);
    expect(dm).toMatch(/Voltei/);
    expect(dm).toMatch(/corrija o horário ou descarte/i);
  });
});
