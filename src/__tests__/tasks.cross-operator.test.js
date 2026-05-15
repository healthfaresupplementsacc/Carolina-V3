'use strict';
/**
 * B9: when Vitor sends "F: Fenugreek" and Bruno has the open Fenugreek task,
 * close Bruno's task with closed_by=Vitor AND announce in the channel.
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

describe('B9 — cross-operator finish', () => {
  test('Vitor F: Fenugreek closes Brunos open Fenugreek + announces', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      // First query (operator=Vitor + supplement=Fenugreek): no match (Vitor has no open Fenugreek)
      // Second query (cross-operator fallback): finds Bruno's open Fenugreek
      const calls = db.query.mock.calls.length;
      if (/SELECT id, started_at, slack_start_ts, operator, supplement_name FROM tasks/.test(sql)) {
        if (/operator = \$\d+/.test(sql) && !/supplement_name = \$1\s*\n?\s*ORDER/.test(sql)) {
          // The combined operator+supplement query — return empty
          return Promise.resolve({ rows: [] });
        }
        // Cross-operator query (supplement only)
        return Promise.resolve({
          rows: [{
            id: 42,
            started_at: '2026-05-14T10:00:00Z',
            slack_start_ts: '1699996400.000000',
            operator: 'Bruno',
            supplement_name: 'Fenugreek',
          }],
        });
      }
      if (/SELECT SUM/.test(sql)) {
        return Promise.resolve({ rows: [{ pause_seconds: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await tasks.handleParsed(
      {
        type: 'finish',
        operator: 'Vitor',
        supplement: 'Fenugreek',
        batch: null,
        ts: '1700000000.000000',
        raw: 'F: Fenugreek',
      },
      { ts: '1700000000.000000' }
    );

    // The UPDATE was called with closed_by='Vitor' and task.id=42
    const updateCall = db.query.mock.calls.find((c) =>
      /UPDATE tasks SET\s*\n?\s*ended_at/.test(c[0])
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall[1][4]).toBe('Vitor'); // closed_by
    expect(updateCall[1][5]).toBe(42); // task.id

    // Cross-operator announcement was posted
    expect(slackClient.postMessage).toHaveBeenCalled();
    const announce = slackClient.postMessage.mock.calls[0][0];
    expect(announce).toMatch(/Vitor/);
    expect(announce).toMatch(/Bruno/);
    expect(announce).toMatch(/Fenugreek/);
  });

  test('same-operator finish does NOT trigger cross-operator announce', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, started_at, slack_start_ts, operator, supplement_name FROM tasks/.test(sql)) {
        return Promise.resolve({
          rows: [{
            id: 7,
            started_at: '2026-05-14T10:00:00Z',
            slack_start_ts: '1699996400.000000',
            operator: 'Vitor',
            supplement_name: 'Berberine',
          }],
        });
      }
      if (/SELECT SUM/.test(sql)) {
        return Promise.resolve({ rows: [{ pause_seconds: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await tasks.handleParsed(
      {
        type: 'finish',
        operator: 'Vitor',
        supplement: 'Berberine',
        batch: null,
        ts: '1700000000.000000',
        raw: 'F: Berberine',
      },
      { ts: '1700000000.000000' }
    );

    // No cross-operator announce (closer = starter)
    expect(slackClient.postMessage).not.toHaveBeenCalled();
  });
});
