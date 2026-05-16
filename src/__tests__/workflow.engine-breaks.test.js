'use strict';
jest.mock('../db');
const db = require('../db');
const engine = require('../workflow/engine');

beforeEach(() => { jest.clearAllMocks(); });

describe('engine — break/return primitives (Fase 3.3)', () => {
  test('startBreak inserts pauses row AND oal with activity_type=break', async () => {
    let insertedOal = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/INSERT INTO pauses/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 30 }] });
      }
      if (/FROM operator_activity_log\s+WHERE operator_id = \$1 AND ended_at IS NULL/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 100 }] });
      }
      if (/UPDATE operator_activity_log\s+SET ended_at/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/INSERT INTO operator_activity_log/.test(sql)) {
        insertedOal = params;
        return Promise.resolve({ rows: [{ id: 31 }] });
      }
      if (/UPDATE operator_activity_log SET left_for_id/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.startBreak({
      operatorId: 5, reason: 'almoço', slackTs: '1700000000.000000',
    });
    expect(r.pauseId).toBe(30);
    expect(r.oalId).toBe(31);
    expect(r.previousOalId).toBe(100);
    expect(insertedOal[1]).toBe('break');
    expect(insertedOal[4]).toBe(30); // pause_id
  });

  test('endBreak closes break oal + pause row and opens idle', async () => {
    let closedPause = false, openedIdle = false;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/FROM operator_activity_log\s+WHERE operator_id = \$1 AND ended_at IS NULL AND activity_type = 'break'/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 40, pause_id: 30, started_at: '2026-05-15T12:00:00Z' }] });
      }
      if (/UPDATE operator_activity_log/.test(sql) && /SET ended_at/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/UPDATE pauses SET ended_at/.test(sql)) {
        closedPause = true;
        // ended_reason='manual_return'
        expect(/ended_reason = 'manual_return'/.test(sql)).toBe(true);
        return Promise.resolve({ rows: [] });
      }
      if (/INSERT INTO operator_activity_log/.test(sql)) {
        if (params[1] === 'idle') openedIdle = true;
        return Promise.resolve({ rows: [{ id: 41 }] });
      }
      if (/UPDATE operator_activity_log SET left_for_id/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.endBreak({ operatorId: 5, when: '2026-05-15T13:00:00Z' });
    expect(r.wasOnBreak).toBe(true);
    expect(r.durationSeconds).toBe(3600);
    expect(closedPause).toBe(true);
    expect(openedIdle).toBe(true);
  });

  test('F6 — endBreak with no open break creates an untracked break', async () => {
    const seen = [];
    db.query = jest.fn().mockImplementation((sql) => {
      seen.push(sql);
      // current break lookup → none
      if (/activity_type = 'break'/.test(sql) && /ended_at IS NULL/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/SELECT name FROM operators WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ name: 'Ana' }] });
      }
      if (/INSERT INTO pauses/.test(sql)) return Promise.resolve({ rows: [{ id: 77 }] });
      if (/INSERT INTO operator_activity_log/.test(sql)) return Promise.resolve({ rows: [{ id: 88 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.endBreak({ operatorId: 5 });
    expect(r.wasOnBreak).toBe(false);
    expect(r.untrackedBreak).toBe(true);
    expect(r.pauseId).toBe(77);
    // an untracked pause row was inserted with the marker reason
    expect(seen.some((s) => /INSERT INTO pauses[\s\S]*untracked_return/.test(s))).toBe(true);
  });

  test('getCurrentActivity returns active row with joined display fields', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{
      id: 100, activity_type: 'phase', phase_name: 'Linha de Produção',
      product_name: 'Green Tea', batch_number: '0098',
    }]});
    const r = await engine.getCurrentActivity(5);
    expect(r.activity_type).toBe('phase');
    expect(r.product_name).toBe('Green Tea');
  });

  test('getCurrentActivity returns null when nothing active', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await engine.getCurrentActivity(5);
    expect(r).toBeNull();
  });
});
