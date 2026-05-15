'use strict';
/**
 * Bug N2 (smoke test report): messages with close timestamps were being lost.
 * Root cause: the poller used to setLastTs to the LAST message of the batch
 * even if a message in the middle threw — every message after the failure
 * was skipped forever (oldest=newLastTs excludes them next poll).
 *
 * Fix: track last successful ts per-message; on first error, stop the batch
 * and DO NOT advance last_processed_ts past the failing message. The
 * unique-key dedup on slack_ts (exact decimal precision) makes re-processing
 * already-processed messages a no-op.
 */

jest.mock('../../db');
jest.mock('../client');
jest.mock('../../tasks');
jest.mock('../../orders');
jest.mock('../../formulation');
jest.mock('../../eod');

const db = require('../../db');
const slackClient = require('../client');
const tasks = require('../../tasks');
const orders = require('../../orders');
const eod = require('../../eod');
const poller = require('../poller');

beforeEach(() => {
  jest.clearAllMocks();
  eod.checkMorningReminder = jest.fn().mockResolvedValue();
  eod.checkCleaningDuration = jest.fn().mockResolvedValue();
  eod.checkSixPmReminder = jest.fn().mockResolvedValue();
  eod.checkEod = jest.fn().mockResolvedValue();
  eod.handleProductionSummary = jest.fn().mockResolvedValue();

  slackClient.addReaction = jest.fn().mockResolvedValue();
  slackClient.postMessage = jest.fn().mockResolvedValue();
  slackClient.postToChannel = jest.fn().mockResolvedValue();
  slackClient.fetchRecentMessages = jest.fn().mockResolvedValue([]);

  tasks.handleParsed = jest.fn().mockResolvedValue();
  tasks.clearPendingQuestion = jest.fn().mockResolvedValue();
  tasks.handlePendingResponse = jest.fn().mockResolvedValue(false);
  orders.handleOrdersStart = jest.fn().mockResolvedValue();
  orders.handleOrdersFinish = jest.fn().mockResolvedValue();
});

describe('Bug N2 — last_ts only advances past successfully processed messages', () => {
  test('error on middle msg halts batch, last_ts stays at previous success', async () => {
    let setLastTsValue = null;
    let processedTs = [];
    let throwOn = '1700000002.000000';

    db.query = jest.fn().mockImplementation((sql, params) => {
      // setLastTs writes to app_state with key='last_processed_ts'
      if (/INSERT INTO app_state.*'last_processed_ts'/.test(sql)) {
        setLastTsValue = params[0];
        return Promise.resolve({ rows: [] });
      }
      // Track when a message INSERT fires (proxy for processMessage success)
      if (/INSERT INTO messages/.test(sql)) {
        const ts = params[0];
        if (ts === throwOn) {
          return Promise.reject(new Error('simulated DB failure'));
        }
        processedTs.push(ts);
      }
      // Make existing-message SELECT return empty (fresh msg)
      if (/SELECT id, text, edited_at FROM messages/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      // last_processed_ts read at start
      if (/SELECT value FROM app_state WHERE key = 'last_processed_ts'/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    slackClient.fetchMessages = jest.fn().mockResolvedValue([
      { ts: '1700000001.000000', user: 'U07FG34TMPF', text: 'S: Berberine', username: 'simone' },
      { ts: '1700000002.000000', user: 'U07FG34TMPF', text: 'S: Glutathione', username: 'simone' },
      { ts: '1700000003.000000', user: 'U07FG34TMPF', text: 'S: Saw Palmetto', username: 'simone' },
    ]);

    await poller.poll();

    // First message succeeded, second threw, third NOT processed
    expect(processedTs).toEqual(['1700000001.000000']);
    // last_processed_ts advanced to the first message's ts, NOT the batch tail
    expect(setLastTsValue).toBe('1700000001.000000');
  });

  test('all messages succeed → last_ts advances to the last one', async () => {
    let setLastTsValue = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/INSERT INTO app_state.*'last_processed_ts'/.test(sql)) {
        setLastTsValue = params[0];
      }
      if (/SELECT id, text, edited_at FROM messages/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    slackClient.fetchMessages = jest.fn().mockResolvedValue([
      { ts: '1700000001.000000', user: 'U07FG34TMPF', text: 'a', username: 'simone' },
      { ts: '1700000002.000000', user: 'U07FG34TMPF', text: 'b', username: 'simone' },
      { ts: '1700000003.000000', user: 'U07FG34TMPF', text: 'c', username: 'simone' },
    ]);

    await poller.poll();
    expect(setLastTsValue).toBe('1700000003.000000');
  });

  test('first message fails → last_ts is NOT advanced (no setLastTs call)', async () => {
    let setLastTsCalled = false;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/INSERT INTO app_state.*'last_processed_ts'/.test(sql)) {
        setLastTsCalled = true;
      }
      if (/INSERT INTO messages/.test(sql)) {
        return Promise.reject(new Error('boom'));
      }
      if (/SELECT id, text, edited_at FROM messages/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    slackClient.fetchMessages = jest.fn().mockResolvedValue([
      { ts: '1700000001.000000', user: 'U07FG34TMPF', text: 'a', username: 'simone' },
    ]);

    await poller.poll();
    expect(setLastTsCalled).toBe(false);
  });

  test('close-timestamps (same second, different decimals) processed independently', async () => {
    const processedTs = [];
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/INSERT INTO messages/.test(sql)) {
        processedTs.push(params[0]);
      }
      if (/SELECT id, text, edited_at FROM messages/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Three messages within the same second, different decimal portions.
    slackClient.fetchMessages = jest.fn().mockResolvedValue([
      { ts: '1700000001.000010', user: 'U07FG34TMPF', text: 'a', username: 'simone' },
      { ts: '1700000001.000020', user: 'U07FG34TMPF', text: 'b', username: 'simone' },
      { ts: '1700000001.000030', user: 'U07FG34TMPF', text: 'c', username: 'simone' },
    ]);

    await poller.poll();
    // All three got their own INSERT — none deduplicated by truncated seconds.
    expect(processedTs).toEqual([
      '1700000001.000010',
      '1700000001.000020',
      '1700000001.000030',
    ]);
  });
});
