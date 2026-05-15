'use strict';
/**
 * B7: when a 2nd person sends 'S: ordens' while another's session is open,
 * ask if they're joining (20min window) instead of silently auto-adding.
 */

jest.mock('../db');
jest.mock('../slack/client');

const db = require('../db');
const slackClient = require('../slack/client');
const orders = require('../orders');
const tasks = require('../tasks');

beforeEach(() => {
  jest.clearAllMocks();
  slackClient.postMessage = jest.fn().mockResolvedValue();
  slackClient.postToChannel = jest.fn().mockResolvedValue();
});

describe('B7 — ask before adding joiner to Ordens', () => {
  test('different operator → posts ask question + stores pending', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, operator, helpers, order_count FROM orders_sessions/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: 17, operator: 'Simone', helpers: null, order_count: 188 }],
        });
      }
      // INSERT into app_state (pending question)
      return Promise.resolve({ rows: [] });
    });

    await orders.handleOrdersStart(
      { operator: 'Ana', orderCount: null, ts: '1700000000.000000' },
      { ts: '1700000000.000000' }
    );

    // Verify the ask was posted
    expect(slackClient.postMessage).toHaveBeenCalled();
    const msg = slackClient.postMessage.mock.calls[0][0];
    expect(msg).toMatch(/Ana/);
    expect(msg).toMatch(/Simone/);

    // Verify pending question was stored
    const pendingWrite = db.query.mock.calls.find((c) =>
      /INSERT INTO app_state .* VALUES/.test(c[0]) && c[1]?.[0]?.startsWith('pending_q_')
    );
    expect(pendingWrite).toBeTruthy();
    expect(pendingWrite[1][0]).toBe('pending_q_Ana');
    const stored = JSON.parse(pendingWrite[1][1]);
    expect(stored.questionType).toBe('confirm_join_orders');
    expect(stored.ordersSessionId).toBe(17);
    expect(stored.ordersOwner).toBe('Simone');
  });

  test('same operator opening 2nd batch → falls through to new session (no question)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, operator, helpers, order_count FROM orders_sessions/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: 17, operator: 'Simone', helpers: null, order_count: 188 }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    await orders.handleOrdersStart(
      { operator: 'Simone', orderCount: 67, ts: '1700000000.000000' },
      { ts: '1700000000.000000' }
    );

    // No ask should be posted
    expect(slackClient.postMessage).not.toHaveBeenCalled();
    // INSERT into orders_sessions WAS called (new session for the 2nd batch)
    const insertCall = db.query.mock.calls.find((c) =>
      /INSERT INTO orders_sessions/.test(c[0])
    );
    expect(insertCall).toBeTruthy();
  });

  test('bypassJoin flag → creates session even when other is open', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, operator, helpers, order_count FROM orders_sessions/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: 17, operator: 'Simone', helpers: null, order_count: 188 }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    await orders.handleOrdersStart(
      { operator: 'Ana', orderCount: 50, ts: '1700000000.000000', _bypassJoin: true },
      { ts: '1700000000.000000' }
    );

    expect(slackClient.postMessage).not.toHaveBeenCalled();
    const insertCall = db.query.mock.calls.find((c) =>
      /INSERT INTO orders_sessions/.test(c[0])
    );
    expect(insertCall).toBeTruthy();
  });
});

describe('B7 — confirm_join_orders pending response', () => {
  test('"sim" → adds operator to helpers list', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT value FROM app_state WHERE key/.test(sql)) {
        return Promise.resolve({
          rows: [{
            value: JSON.stringify({
              questionType: 'confirm_join_orders',
              ordersSessionId: 17,
              ordersOwner: 'Simone',
              pendingStart: { operator: 'Ana', orderCount: null, ts: '1700000000.000000' },
              askedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
            }),
          }],
        });
      }
      if (/SELECT helpers FROM orders_sessions/.test(sql)) {
        return Promise.resolve({ rows: [{ helpers: null }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const handled = await tasks.handlePendingResponse('Ana', {
      ts: '1700000900.000000',
      text: 'sim',
    });
    expect(handled).toBe(true);

    const updateCall = db.query.mock.calls.find((c) =>
      /UPDATE orders_sessions SET helpers/.test(c[0])
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall[1][0]).toBe('Ana');
    expect(updateCall[1][1]).toBe(17);
  });

  test('"não" → opens a separate session via bypass', async () => {
    let handleOrdersStartArgs = null;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT value FROM app_state WHERE key/.test(sql)) {
        return Promise.resolve({
          rows: [{
            value: JSON.stringify({
              questionType: 'confirm_join_orders',
              ordersSessionId: 17,
              ordersOwner: 'Simone',
              pendingStart: { operator: 'Ana', orderCount: 50, ts: '1700000000.000000' },
              askedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
            }),
          }],
        });
      }
      // For the recursive handleOrdersStart with bypass — return a row so it
      // creates a new session.
      if (/SELECT id, operator, helpers, order_count FROM orders_sessions/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: 17, operator: 'Simone', helpers: null, order_count: 188 }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const handled = await tasks.handlePendingResponse('Ana', {
      ts: '1700000900.000000',
      text: 'nao',
    });
    expect(handled).toBe(true);

    // A new INSERT into orders_sessions happened (bypass path)
    const insertCall = db.query.mock.calls.find((c) =>
      /INSERT INTO orders_sessions/.test(c[0])
    );
    expect(insertCall).toBeTruthy();
  });
});
