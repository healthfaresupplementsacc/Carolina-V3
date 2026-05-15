'use strict';
/**
 * B18: Pending questions use a 20-minute window (was 2h), and on expiry
 * the admin is notified once and the question is cleared.
 */

jest.mock('../db');
jest.mock('../slack/client');
jest.mock('../eod', () => ({
  isAfterSixPmEt: () => false,
  notifyAdmin: jest.fn().mockResolvedValue(),
}));

const db = require('../db');
const eod = require('../eod');
const tasks = require('../tasks');

beforeEach(() => {
  jest.clearAllMocks();
  eod.notifyAdmin.mockClear();
});

describe('B18 — pending_questions 20min single-shot', () => {
  test('storePendingQuestion writes expiresAt ~20min from now (not 2h)', async () => {
    let storedValue = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/INSERT INTO app_state/.test(sql)) storedValue = params[1];
      return Promise.resolve({ rows: [] });
    });

    const before = Date.now();
    await tasks.storePendingQuestion('Ana', { questionType: 'confirm_close', closingTaskId: 1 });

    expect(storedValue).toBeTruthy();
    const parsed = JSON.parse(storedValue);
    const expiresMs = new Date(parsed.expiresAt).getTime();
    const deltaMin = (expiresMs - before) / 60000;
    expect(deltaMin).toBeGreaterThanOrEqual(19);
    expect(deltaMin).toBeLessThanOrEqual(21);
  });

  test('getPendingQuestion returns the question while inside the window', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.query = jest.fn().mockResolvedValue({
      rows: [{
        value: JSON.stringify({
          questionType: 'confirm_close',
          closingTaskId: 5,
          askedAt: new Date().toISOString(),
          expiresAt: future,
        }),
      }],
    });

    const q = await tasks.getPendingQuestion('Ana');
    expect(q).toBeTruthy();
    expect(q.questionType).toBe('confirm_close');
    expect(eod.notifyAdmin).not.toHaveBeenCalled();
  });

  test('expired pending → returns null, notifies admin, deletes record', async () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString(); // 1min ago
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT value FROM app_state/.test(sql)) {
        return Promise.resolve({
          rows: [{
            value: JSON.stringify({
              questionType: 'confirm_close',
              closingTaskId: 5,
              askedAt: new Date(Date.now() - 21 * 60 * 1000).toISOString(),
              expiresAt: past,
            }),
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const q = await tasks.getPendingQuestion('Simone');
    expect(q).toBeNull();
    expect(eod.notifyAdmin).toHaveBeenCalledTimes(1);
    const msg = eod.notifyAdmin.mock.calls[0][0];
    expect(msg).toMatch(/Simone/);
    expect(msg).toMatch(/confirm_close/);

    // DELETE call against app_state
    const del = db.query.mock.calls.find((c) => /DELETE FROM app_state/.test(c[0]));
    expect(del).toBeTruthy();
  });

  test('no pending → returns null, no admin notification', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const q = await tasks.getPendingQuestion('Ana');
    expect(q).toBeNull();
    expect(eod.notifyAdmin).not.toHaveBeenCalled();
  });
});
