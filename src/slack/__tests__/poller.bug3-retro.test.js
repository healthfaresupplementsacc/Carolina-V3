'use strict';
/**
 * Bug 3 — operator answers the "que horas vc saiu?" retro-break question
 * in the PRODUCTION channel with a bare time ("13:30"). The parser
 * resolves no operator, so the answer used to be lost. The poller must
 * resolve the operator by Slack account, apply the time, and confirm
 * (channel post self-suppresses under silent_text; admin chat always).
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

const SIMONE_SLACK = 'U07FG34TMPF';
const SIMONE_ID = 7;

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
  tasks.handleParsed = jest.fn().mockResolvedValue();
  tasks.clearPendingQuestion = jest.fn().mockResolvedValue();
  tasks.handlePendingResponse = jest.fn().mockResolvedValue(false);
  orders.handleOrdersStart = jest.fn().mockResolvedValue();
  orders.handleOrdersFinish = jest.fn().mockResolvedValue();
});

function wire({ pending }) {
  db.query = jest.fn().mockImplementation((sql, p) => {
    if (/SELECT id, text, edited_at FROM messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/SELECT id FROM operators WHERE slack_user_id = \$1/.test(sql)) {
      return Promise.resolve({ rows: p && p[0] === SIMONE_SLACK ? [{ id: SIMONE_ID }] : [] });
    }
    if (/SELECT id FROM operators WHERE LOWER\(name\)/.test(sql)) return Promise.resolve({ rows: [] });
    if (/SELECT name FROM operators WHERE id = \$1/.test(sql)) return Promise.resolve({ rows: [{ name: 'Simone' }] });
    if (/SELECT value FROM app_state WHERE key = \$1/.test(sql)) {
      if (p && p[0] === 'brk_time_' + SIMONE_ID && pending) {
        return Promise.resolve({ rows: [{ value: JSON.stringify({ pauseId: 1, oalId: 2, attempts: 0, day: '2026-05-16' }) }] });
      }
      return Promise.resolve({ rows: [] });
    }
    if (/SELECT key FROM app_state WHERE key LIKE 'brk_time_%'/.test(sql)) {
      return Promise.resolve({ rows: pending ? [{ key: 'brk_time_' + SIMONE_ID }] : [] });
    }
    return Promise.resolve({ rows: [] }); // INSERT/UPDATE/DELETE/etc.
  });
  slackClient.fetchMessages = jest.fn().mockResolvedValue([
    { ts: '1700000000.000000', user: SIMONE_SLACK, text: '13:30', username: 'simone' },
  ]);
  slackClient.fetchRecentMessages = jest.fn().mockResolvedValue([]);
}

describe('Bug 3 — production-channel retro-break wiring', () => {
  test('bare "13:30" from Simone with a pending question → resolved + confirmed', async () => {
    wire({ pending: true });
    await poller.poll();

    // resolved → reaction on the message
    expect(slackClient.addReaction).toHaveBeenCalled();
    // confirmation mirrored to the admin chat (always — silent_text-safe)
    expect(slackClient.postToChannel).toHaveBeenCalledWith(
      'C0B36DR5MP1', expect.stringMatching(/Atualizei o break.*Simone.*13:30/s));
    // the time reply was consumed — not treated as a normal task
    expect(tasks.handleParsed).not.toHaveBeenCalled();
    // the pending question was cleared (handleReply DELETEs brk_time_7)
    const del = db.query.mock.calls.find((c) => /DELETE FROM app_state WHERE key = \$1/.test(c[0]) && c[1] && c[1][0] === 'brk_time_' + SIMONE_ID);
    expect(del).toBeTruthy();
  });

  test('no pending question → not consumed, no false confirmation', async () => {
    wire({ pending: false });
    await poller.poll();
    expect(slackClient.postToChannel).not.toHaveBeenCalledWith(
      'C0B36DR5MP1', expect.stringMatching(/Atualizei o break/));
  });
});
