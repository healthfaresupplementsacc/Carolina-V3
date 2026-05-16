'use strict';
// BUG TZ-NAME — Carolina answered "que horas a Simone marcou o break"
// with VITOR's times. Root cause: get_operator_timeline only took an
// integer id, there was no name→id resolution, and get_state exposed
// only an aggregate break count — so she inferred from mixed lists.
// This pins: name resolution + per-operator SQL filter + self-identifying
// envelope + the hard system-prompt rule + get_state break detail.
jest.mock('../db');
const db = require('../db');
const at = require('../ai/admin-tools');
const fs = require('fs');
const path = require('path');

beforeEach(() => { jest.clearAllMocks(); });

// Simone is on an OPEN break (21:24Z = 17:24 ET). Vitor has two CLOSED
// (duplicated) breaks 18:29Z→20:15Z (= 14:29→16:15 ET) — the wrong times
// Carolina used to report for Simone.
const NAME_TO_ID = { simone: 3, vitor: 5, ana: 2 };
function wireDb() {
  db.query = jest.fn((sql, p) => {
    if (/FROM operators\s+WHERE LOWER\(name\)/.test(sql)) {
      const id = NAME_TO_ID[String(p[0]).toLowerCase()];
      return Promise.resolve({ rows: id ? [{ id, name: p[0] }] : [] });
    }
    if (/count\(\*\)::int n/.test(sql)) return Promise.resolve({ rows: [{ n: 2 }] });
    // break-detail list inside getState (no operator_id filter)
    if (/FROM operator_activity_log oal\s+JOIN operators o/.test(sql)
        && /activity_type='break' AND oal\.ended_at IS NULL/.test(sql)
        && !/oal\.operator_id = \$1/.test(sql)) {
      return Promise.resolve({ rows: [
        { operator: 'Simone', started_at: '2026-05-16T21:24:00.000Z' },
        { operator: 'Vitor', started_at: '2026-05-16T18:29:00.000Z' },
      ] });
    }
    // per-operator timeline (filtered by resolved id)
    if (/FROM operator_activity_log oal\s+JOIN operators o/.test(sql)
        && /oal\.operator_id = \$1/.test(sql)) {
      if (p[0] === 3) return Promise.resolve({ rows: [
        { activity_type: 'break', started_at: '2026-05-16T21:24:00.000Z',
          ended_at: null, phase_name: null, operator: 'Simone' },
      ] });
      if (p[0] === 5) return Promise.resolve({ rows: [
        { activity_type: 'break', started_at: '2026-05-16T18:29:00.000Z',
          ended_at: '2026-05-16T20:15:00.000Z', phase_name: null, operator: 'Vitor' },
        { activity_type: 'break', started_at: '2026-05-16T18:29:00.000Z',
          ended_at: '2026-05-16T20:15:00.000Z', phase_name: null, operator: 'Vitor' },
      ] });
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('BUG TZ-NAME — name resolution + per-operator filter', () => {
  test('resolveOperatorId maps a name to one operator; numeric short-circuits (no DB)', async () => {
    wireDb();
    expect(await at.resolveOperatorId('Simone')).toBe(3);
    expect(await at.resolveOperatorId('vitor')).toBe(5);
    expect(await at.resolveOperatorId('Ninguém')).toBeNull();
    db.query.mockClear();
    expect(await at.resolveOperatorId(7)).toBe(7);     // numeric id
    expect(await at.resolveOperatorId('42')).toBe(42);  // numeric string
    expect(db.query).not.toHaveBeenCalled();
  });

  test("get_operator_timeline('Simone') returns ONLY Simone's entries (her ET time)", async () => {
    wireDb();
    const rows = await at.getOperatorTimeline('Simone');
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.operator === 'Simone')).toBe(true);
    expect(rows[0].started_at).toBe('2026-05-16 17:24'); // 21:24Z ET, NOT Vitor's 14:29
    expect(rows[0].ended_at).toBeNull();                 // still on break
    expect(JSON.stringify(rows)).not.toContain('14:29'); // never Vitor's time
    expect(JSON.stringify(rows)).not.toContain('Vitor');
  });

  test('Simone on break + Vitor closed dup breaks → "break da Simone" resolves SIMONE', async () => {
    wireDb();
    const env = await at.runTool('get_operator_timeline', { operator: 'Simone' });
    expect(env.operator).toBe('Simone');
    expect(env.operator_id).toBe(3);
    expect(env.found).toBe(true);
    expect(env.entries.every((e) => e.operator === 'Simone')).toBe(true);
    expect(env.entries[0].started_at).toBe('2026-05-16 17:24');
    const s = JSON.stringify(env);
    expect(s).not.toContain('14:29');
    expect(s).not.toContain('16:15');
    expect(s).not.toContain('Vitor');
  });

  test('two people on break → timeline still scoped to the asked operator only', async () => {
    wireDb();
    const v = await at.runTool('get_operator_timeline', { operator: 'Vitor' });
    expect(v.operator).toBe('Vitor');
    expect(v.operator_id).toBe(5);
    expect(v.entries.every((e) => e.operator === 'Vitor')).toBe(true);
    expect(JSON.stringify(v)).not.toContain('Simone');
  });

  test('unknown name → found:false + note (Carolina must ask, not guess)', async () => {
    wireDb();
    const env = await at.runTool('get_operator_timeline', { operator: 'Fulano' });
    expect(env.found).toBe(false);
    expect(env.operator_id).toBeNull();
    expect(env.entries).toEqual([]);
    expect(env.note).toMatch(/não encontrado/i);
  });
});

describe('BUG TZ-NAME — get_state exposes WHO is on break (names + ET)', () => {
  test('getState().breaks lists on-break operators by name in ET', async () => {
    wireDb();
    const s = await at.getState();
    expect(Array.isArray(s.breaks)).toBe(true);
    const simone = s.breaks.find((b) => b.operator === 'Simone');
    expect(simone).toBeTruthy();
    expect(simone.started_at).toBe('2026-05-16 17:24');
    expect(simone.tz).toBe('ET');
  });
});

describe('BUG TZ-NAME — tool schema + hard system-prompt rule', () => {
  test('get_operator_timeline accepts operator NAME and is not id-required', () => {
    const def = at.TOOL_DEFS.find((t) => t.name === 'get_operator_timeline');
    expect(def.input_schema.properties.operator).toBeTruthy();
    expect(def.input_schema.required).toBeUndefined();
    expect(def.description).toMatch(/SEMPRE|nome/i);
  });

  test('admin prompt forces a per-operator timeline call, banning inference from lists', () => {
    const dm = fs.readFileSync(path.join(__dirname, '..', 'slack', 'dm-handler.js'), 'utf8');
    expect(dm).toMatch(/OPERADOR ESPEC[ÍI]FICO/);
    expect(dm).toMatch(/get_operator_timeline com operator = o NOME/);
    expect(dm).toMatch(/NUNCA infira[\s\S]*get_state/);
  });
});
