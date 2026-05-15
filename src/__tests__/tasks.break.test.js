'use strict';
/**
 * B5: 'voltei' during an open break closes the break (handlePauseEnd).
 * B6: any new activity (S:, P:, orders_start, formulation_start) during an
 *     open break implicitly closes the break.
 */

jest.mock('../db');
jest.mock('../slack/client');
jest.mock('../eod', () => ({ isAfterSixPmEt: () => false }));

const db = require('../db');
const slackClient = require('../slack/client');
const tasks = require('../tasks');

beforeEach(() => {
  jest.clearAllMocks();
  slackClient.postMessage = jest.fn().mockResolvedValue();
  slackClient.postToChannel = jest.fn().mockResolvedValue();
});

describe('B5 — voltei closes open break', () => {
  test('handlePauseEnd updates the most recent open pause', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 99, started_at: '2026-05-14T12:00:00Z' }] });
    const closed = await tasks.handlePauseEnd(
      { operator: 'Ana', ts: '1700000900.000000' },
      { ts: '1700000900.000000' }
    );
    expect(closed).toBe(true);
    const updateCalls = db.query.mock.calls.filter((c) => /UPDATE pauses SET ended_at/.test(c[0]));
    expect(updateCalls.length).toBe(1);
    // Operator was passed to the UPDATE
    expect(updateCalls[0][1][1]).toBe('Ana');
  });

  test('handlePauseEnd with no operator returns false (no UPDATE)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const closed = await tasks.handlePauseEnd(
      { operator: null, ts: '1700000900.000000' },
      { ts: '1700000900.000000' }
    );
    expect(closed).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('handlePauseEnd returns false when no open break found', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const closed = await tasks.handlePauseEnd(
      { operator: 'Ana', ts: '1700000900.000000' },
      { ts: '1700000900.000000' }
    );
    expect(closed).toBe(false);
  });
});

describe('B6 — new task during break implicitly ends the break', () => {
  test('closeOpenBreakFor finds and closes break by pauses.operator', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 77, started_at: '2026-05-14T12:00:00Z' }] });
    const closed = await tasks.closeOpenBreakFor(
      'Bruno',
      '2026-05-14T13:00:00Z',
      'auto_new_task'
    );
    expect(closed).toBe(true);
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE pauses SET ended_at/);
    expect(sql).toMatch(/p\.operator = \$2 OR t\.operator = \$2/);
  });

  test('closeOpenBreakFor with no operator is a no-op', async () => {
    db.query = jest.fn();
    const closed = await tasks.closeOpenBreakFor(null, '2026-05-14T13:00:00Z', 'auto_new_task');
    expect(closed).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('closeOpenBreakFor returns false when no break is open', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const closed = await tasks.closeOpenBreakFor('Bruno', '2026-05-14T13:00:00Z', 'auto_new_task');
    expect(closed).toBe(false);
  });
});
