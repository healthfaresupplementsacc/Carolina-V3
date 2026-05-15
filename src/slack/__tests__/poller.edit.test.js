'use strict';
/**
 * B4: When a Slack message is edited, the poller must reprocess it as if it
 * were a new message — updating parsed_type, calling handlers, etc.
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

// Lazy-require AFTER mocks so the poller picks up the mocked deps
const poller = require('../poller');

beforeEach(() => {
  jest.clearAllMocks();
  // Default eod stubs (poller calls them at the end of poll())
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

describe('B4 — edited messages are reprocessed', () => {
  test('edited message text triggers UPDATE + handler re-dispatch', async () => {
    // Setup: message exists in DB with old text
    db.query = jest.fn().mockImplementation((sql) => {
      if (sql.includes('SELECT id, text, edited_at FROM messages')) {
        return Promise.resolve({
          rows: [{ id: 42, text: 'S: Berberina 0119', edited_at: null }],
        });
      }
      if (sql.includes('SELECT value FROM app_state')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Slack returns the message with NEW text + edited field
    const editedMsg = {
      ts: '1700000000.000000',
      user: 'U07FG34TMPF', // Simone
      text: 'S: Glutathione 0128',
      username: 'simone',
      edited: { user: 'U07FG34TMPF', ts: '1700000050.000000' },
    };
    slackClient.fetchMessages = jest.fn().mockResolvedValue([]);
    slackClient.fetchRecentMessages = jest.fn().mockResolvedValue([editedMsg]);

    await poller.poll();

    // UPDATE was called with previous_text + new text + edited_at
    const updateCalls = db.query.mock.calls.filter((c) =>
      c[0].includes('UPDATE messages SET previous_text')
    );
    expect(updateCalls.length).toBe(1);
    const params = updateCalls[0][1];
    expect(params[0]).toBe('S: Berberina 0119'); // previous_text
    expect(params[1]).toBe('S: Glutathione 0128'); // new text
    expect(params[2]).toBe('1700000050.000000'); // edited_at

    // Handler was re-dispatched (S: Glutathione → start, taskEngine.handleParsed called)
    expect(tasks.handleParsed).toHaveBeenCalled();
    const parsedArg = tasks.handleParsed.mock.calls[0][0];
    expect(parsedArg.type).toBe('start');
    expect(parsedArg.supplement).toBe('Glutathione');
  });

  test('unchanged message is NOT reprocessed (no UPDATE, no handler call)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (sql.includes('SELECT id, text, edited_at FROM messages')) {
        return Promise.resolve({
          rows: [{ id: 42, text: 'S: Berberine 0119', edited_at: '1700000050.000000' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const unchangedMsg = {
      ts: '1700000000.000000',
      user: 'U07FG34TMPF',
      text: 'S: Berberine 0119',
      username: 'simone',
      edited: { user: 'U07FG34TMPF', ts: '1700000050.000000' }, // same edited_at
    };
    slackClient.fetchMessages = jest.fn().mockResolvedValue([]);
    slackClient.fetchRecentMessages = jest.fn().mockResolvedValue([unchangedMsg]);

    await poller.poll();

    const updateCalls = db.query.mock.calls.filter((c) =>
      c[0].includes('UPDATE messages SET previous_text')
    );
    expect(updateCalls.length).toBe(0);
    expect(tasks.handleParsed).not.toHaveBeenCalled();
  });

  test('pollEdits skips messages without an `edited` field', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });

    const plainMsg = {
      ts: '1700000000.000000',
      user: 'U07FG34TMPF',
      text: 'S: Berberine 0119',
      username: 'simone',
      // no `edited` field
    };
    slackClient.fetchMessages = jest.fn().mockResolvedValue([]);
    slackClient.fetchRecentMessages = jest.fn().mockResolvedValue([plainMsg]);

    await poller.poll();

    // No SELECT against messages from the edits path (the fetchMessages new-message
    // path returned [] above). plainMsg has no `edited`, so pollEdits skips it.
    const selectCalls = db.query.mock.calls.filter((c) =>
      c[0].includes('SELECT id, text, edited_at FROM messages')
    );
    expect(selectCalls.length).toBe(0);
  });
});
