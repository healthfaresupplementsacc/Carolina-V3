'use strict';
/**
 * B15: F without a matching open task should NOT be silently dropped.
 * Instead, record a closed task with duration_seconds=0 (a "point event")
 * so it shows up in the timeline and admin can reconcile.
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

describe('B15 — F without match becomes a point-event', () => {
  test('"F: Limpeza" with no open Limpeza → INSERT closed task duration=0', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      // First SELECT for operator+supplement match — empty
      if (/SELECT id, started_at, slack_start_ts.* FROM tasks/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      // Pauses subquery (called later but won't reach here)
      return Promise.resolve({ rows: [] });
    });

    await tasks.handleParsed(
      {
        type: 'finish',
        operator: 'Ana',
        supplement: null,
        batch: null,
        description: 'F: Limpeza',
        ts: '1700000000.000000',
        raw: 'F: Limpeza',
      },
      { ts: '1700000000.000000' }
    );

    const insertCall = db.query.mock.calls.find((c) =>
      /INSERT INTO tasks/.test(c[0])
    );
    expect(insertCall).toBeTruthy();
    const sql = insertCall[0];
    // duration_seconds=0, status='closed', task_type='outro'
    expect(sql).toMatch(/0, 0, 'closed', 'outro'/);
    // started_at = ended_at (same param)
    const params = insertCall[1];
    expect(params[0]).toBe('Ana'); // operator
    expect(params[3]).toBe('F: Limpeza'); // description
  });

  test('"F: Berberine" with NO open Berberine but a matching closed one earlier → still point-event', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });

    await tasks.handleParsed(
      {
        type: 'finish',
        operator: 'Vitor',
        supplement: 'Berberine',
        batch: null,
        description: 'F: Berberine',
        ts: '1700000000.000000',
        raw: 'F: Berberine',
      },
      { ts: '1700000000.000000' }
    );

    const insertCall = db.query.mock.calls.find((c) =>
      /INSERT INTO tasks/.test(c[0])
    );
    expect(insertCall).toBeTruthy();
    const params = insertCall[1];
    expect(params[1]).toBe('Berberine');
  });

  test('"F: Berberine" with matching open task → does NOT create point-event (normal close)', async () => {
    let insertHappened = false;
    let updateHappened = false;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, started_at, slack_start_ts.* FROM tasks/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: 42, started_at: '2026-05-14T10:00:00Z', slack_start_ts: '1699996400.000000' }],
        });
      }
      if (/SELECT SUM\(EXTRACT\(EPOCH FROM/.test(sql)) {
        return Promise.resolve({ rows: [{ pause_seconds: 0 }] });
      }
      if (/INSERT INTO tasks/.test(sql)) {
        insertHappened = true;
      }
      if (/UPDATE tasks SET/.test(sql)) {
        updateHappened = true;
      }
      return Promise.resolve({ rows: [] });
    });

    await tasks.handleParsed(
      {
        type: 'finish',
        operator: 'Vitor',
        supplement: 'Berberine',
        batch: null,
        description: 'F: Berberine',
        ts: '1700000000.000000',
        raw: 'F: Berberine',
      },
      { ts: '1700000000.000000' }
    );

    expect(insertHappened).toBe(false);
    expect(updateHappened).toBe(true);
  });
});
