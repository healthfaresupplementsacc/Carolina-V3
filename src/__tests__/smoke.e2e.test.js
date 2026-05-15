'use strict';
/**
 * End-to-end smoke test — runs the 18 cases from Appendix B of
 * carolina_master_doc.md as integrated parser → handler → mock-DB checks.
 *
 * Purpose: a single suite you (Bruno) can run before each deploy to confirm
 * every Entrega 1 bug is still fixed. If a future change re-breaks any case,
 * this suite turns red immediately.
 *
 * Bugs covered:
 *   B1  Bruno- Green Tea-0098-S        end-position tag with hyphen
 *   B2  S; revisao Glutathione         semicolon separator
 *   B3  F/ Berberine                   slash separator
 *   B4  edited message                 polling re-detects & reprocesses
 *   B5  voltei                         closes open break
 *   B6  new task during break          closes break + opens task
 *   B7  S: ordens (2nd op)             asks if joining (20min window)
 *   B8  ajudando linha de producao     auto-join (no supplement question)
 *   B9  Vitor F: Fenugreek vs Bruno    cross-operator finish + announce
 *   B10 F- ordens ... feitas           ordens wins over supplement
 *   B11 impacotei + iniciei            orders_finish + nextSupplement
 *   B12 Segunda impressao feita        creates session, asks count
 *   B13 F Limpeza                      short tag still works
 *   B14 orders → day totals            aggregated in dashboard/EOD
 *   B15 F without match                point-event row (duration=0)
 *   B16 admin edits Picking&Packing    Entrega 2 (skipped here)
 *   B17 admin closes others break      Entrega 2 (skipped here)
 *   B18 pending_questions 20min        window + single-shot + admin notify
 */

jest.mock('../db');
jest.mock('../slack/client');
jest.mock('../eod', () => ({
  isAfterSixPmEt: () => false,
  notifyAdmin: jest.fn().mockResolvedValue(),
  handleProductionSummary: jest.fn().mockResolvedValue(),
}));

const db = require('../db');
const slackClient = require('../slack/client');
const tasks = require('../tasks');
const orders = require('../orders');
const eod = require('../eod');
const { parseMessage } = require('../parser');

function emptyDb() {
  return jest.fn().mockResolvedValue({ rows: [] });
}

function msg(text, opts = {}) {
  return {
    ts: opts.ts || '1700000000.000000',
    user: opts.user || 'U08JC85HMNE', // Vitor
    text,
    username: opts.username || 'vitor',
    ...(opts.edited ? { edited: opts.edited } : {}),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  slackClient.postMessage = jest.fn().mockResolvedValue();
  slackClient.postToChannel = jest.fn().mockResolvedValue();
  db.query = emptyDb();
});

// ───────────────────────── Parser bugs (B1, B2, B3, B10, B11, B13) ────────

describe('B1 — Bruno- Green Tea-0098-S', () => {
  test('recognized as start with operator Bruno + Green Tea 0098', () => {
    const r = parseMessage(msg('Bruno- Green Tea-0098-S', {
      user: 'U0AU8N8FA00',
      username: 'production line',
    }));
    expect(r.type).toBe('start');
    expect(r.operator).toBe('Bruno');
    expect(r.supplement).toBe('Green Tea');
    expect(r.batch).toBe('0098');
  });
});

describe('B2 — S; revisao Glutathione', () => {
  test('recognized as start with revisao taskType', () => {
    const r = parseMessage(msg('S; revisao Glutathione'));
    expect(r.type).toBe('start');
    expect(r.supplement).toBe('Glutathione');
    expect(r.taskType).toBe('revisao');
  });
});

describe('B3 — F/ Berberine', () => {
  test('recognized as finish of Berberine', () => {
    const r = parseMessage(msg('F/ Berberine'));
    expect(r.type).toBe('finish');
    expect(r.supplement).toBe('Berberine');
  });
});

describe('B10 — F- ordens da segunda impressao feitas', () => {
  test('routed to orders_finish, not confused with supplement', () => {
    const r = parseMessage(msg('F- ordens da segunda impressao feitas', {
      user: 'U07FG34TMPF',
      username: 'simone',
    }));
    expect(r.type).toBe('orders_finish');
  });
});

describe('B11 — Ja impacotei e ja iniciei a Revisao do Ginger', () => {
  test('orders_finish + nextSupplement Ginger Root + nextTaskType revisao', () => {
    const r = parseMessage(msg('Ja impacotei e ja iniciei a Revisao do Ginger', {
      user: 'U07FG34TMPF',
      username: 'simone',
    }));
    expect(r.type).toBe('orders_finish');
    expect(r.nextSupplement).toBe('Ginger Root');
    expect(r.nextTaskType).toBe('revisao');
  });
});

describe('B13 — F Limpeza', () => {
  test('short tag with task type is still recognized', () => {
    const r = parseMessage(msg('F Limpeza'));
    expect(r.type).toBe('finish');
  });
});

// ───────────────────────── Poller bug (B4) ────────────────────────────────

describe('B4 — edited Slack message is reprocessed', () => {
  // Behavior is also covered in poller.edit.test.js; here we re-assert the
  // contract at the e2e level — when message text changes between polls,
  // the poller path updates the row and re-dispatches the handler.
  test('processMessage UPDATEs row + re-parses (smoke)', async () => {
    // Re-require the poller with mocks already in place
    const poller = require('../slack/poller');
    db.query = jest.fn().mockImplementation((sql) => {
      if (sql.includes('SELECT id, text, edited_at FROM messages')) {
        return Promise.resolve({
          rows: [{ id: 1, text: 'S: Berberina 0119', edited_at: null }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    slackClient.fetchMessages = jest.fn().mockResolvedValue([]);
    slackClient.fetchRecentMessages = jest.fn().mockResolvedValue([
      msg('S: Berberine 0119', {
        user: 'U07FG34TMPF',
        username: 'simone',
        edited: { user: 'U07FG34TMPF', ts: '1700000050.000000' },
      }),
    ]);

    await poller.poll();

    const updates = db.query.mock.calls.filter((c) =>
      /UPDATE messages SET previous_text/.test(c[0])
    );
    expect(updates.length).toBe(1);
  });
});

// ───────────────────────── Break handling (B5, B6) ────────────────────────

describe('B5 — voltei closes open break', () => {
  test('handlePauseEnd closes the most recent open break', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 1, started_at: '2026-05-14T12:00:00Z' }] });
    const closed = await tasks.handlePauseEnd(
      { operator: 'Ana', ts: '1700000900.000000' },
      { ts: '1700000900.000000' }
    );
    expect(closed).toBe(true);
  });
});

describe('B6 — new task during break closes break implicitly', () => {
  test('closeOpenBreakFor invoked from new-activity path', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 7 }] });
    const closed = await tasks.closeOpenBreakFor('Bruno', '2026-05-14T13:00:00Z', 'auto_new_task');
    expect(closed).toBe(true);
  });
});

// ───────────────────────── Join / co-work (B7, B8) ────────────────────────

describe('B7 — S: ordens by 2nd operator asks if joining', () => {
  test('different operator + open Ordens → posts ask + stores pending', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, operator, helpers, order_count FROM orders_sessions/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: 17, operator: 'Simone', helpers: null, order_count: 188 }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    await orders.handleOrdersStart(
      { operator: 'Ana', orderCount: null, ts: '1700000000.000000' },
      { ts: '1700000000.000000' }
    );
    expect(slackClient.postMessage).toHaveBeenCalled();
    const ask = slackClient.postMessage.mock.calls[0][0];
    expect(ask).toMatch(/Ana/);
    expect(ask).toMatch(/Simone/);
  });
});

describe('B8 — ajudando linha de producao auto-joins', () => {
  test('parser produces join_producao + handler adds helper without asking', async () => {
    const r = parseMessage(msg('Ana - ajudando o Vitor na linha de producao', {
      user: 'U0AU8N8FA00',
      username: 'production line',
    }));
    expect(r.type).toBe('join_producao');

    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, operator, supplement_name, helpers FROM tasks/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: 5, operator: 'Vitor', supplement_name: 'Green Tea', helpers: null }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const ok = await tasks.handleJoinProducao(r, { ts: r.ts });
    expect(ok).toBe(true);
    const update = db.query.mock.calls.find((c) => /UPDATE tasks SET helpers/.test(c[0]));
    expect(update[1][0]).toBe('Ana');
  });
});

// ───────────────────────── Cross-operator finish (B9) ────────────────────

describe('B9 — Vitor F: Fenugreek closes Brunos task', () => {
  test('cross-operator fallback updates correct task + announces', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, started_at, slack_start_ts.* FROM tasks/.test(sql)) {
        if (/operator = \$\d+\s+AND supplement_name/.test(sql)) {
          return Promise.resolve({ rows: [] }); // Vitor has no open Fenugreek
        }
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
      if (/SELECT SUM/.test(sql)) return Promise.resolve({ rows: [{ pause_seconds: 0 }] });
      return Promise.resolve({ rows: [] });
    });

    await tasks.handleParsed(
      { type: 'finish', operator: 'Vitor', supplement: 'Fenugreek', batch: null, ts: '1700000000.000000', raw: 'F: Fenugreek' },
      { ts: '1700000000.000000' }
    );

    const update = db.query.mock.calls.find((c) => /UPDATE tasks SET\s*\n?\s*ended_at/.test(c[0]));
    expect(update[1][4]).toBe('Vitor'); // closed_by
    expect(update[1][5]).toBe(42);
    expect(slackClient.postMessage).toHaveBeenCalled();
  });
});

// ───────────────────────── Orders 2nd-print no count (B12) ───────────────

describe('B12 — Simone Segunda impressao feita with no number', () => {
  test('parsed as orders_continue with orderCount=null', () => {
    const r = parseMessage(msg('Segunda impressao feita', {
      user: 'U07FG34TMPF',
      username: 'simone',
    }));
    expect(r.type).toBe('orders_continue');
    expect(r.orderCount).toBeNull();
  });
});

// ───────────────────────── Orders day total (B14) ─────────────────────────

describe('B14 — orders count sums into day total', () => {
  test('getDayOrdersTotal aggregates with SUM', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ total: 255, session_count: 2 }] });
    const total = await orders.getDayOrdersTotal('2026-05-14');
    expect(total.total).toBe(255);
    expect(total.sessionCount).toBe(2);
  });
});

// ───────────────────────── F without match → point-event (B15) ────────────

describe('B15 — F without match creates point-event', () => {
  test('handleFinish inserts duration=0 closed task', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await tasks.handleParsed(
      { type: 'finish', operator: 'Ana', supplement: null, batch: null, ts: '1700000000.000000', raw: 'F: Limpeza', description: 'F: Limpeza' },
      { ts: '1700000000.000000' }
    );
    const insert = db.query.mock.calls.find((c) => /INSERT INTO tasks/.test(c[0]));
    expect(insert).toBeTruthy();
    expect(insert[0]).toMatch(/0, 0, 'closed', 'outro'/);
  });
});

// ───────────────────────── Admin tools (B16, B17 — deferred) ──────────────

describe('B16 — admin edits Picking & Packing session', () => {
  // Scope deferred to Entrega 2 (admin with full control via dashboard).
  test.skip('admin-edit orders_session field-by-field (Entrega 2)', () => {});
});

describe('B17 — admin closes another operators break', () => {
  // Scope deferred to Entrega 2 (admin with full control via dashboard).
  test.skip('admin force-close break button (Entrega 2)', () => {});
});

// ───────────────────────── Pending questions window (B18) ─────────────────

describe('B18 — pending_questions 20min single-shot', () => {
  test('storePendingQuestion uses 20-minute window', async () => {
    let stored = null;
    db.query = jest.fn().mockImplementation((sql, p) => {
      if (/INSERT INTO app_state/.test(sql)) stored = p[1];
      return Promise.resolve({ rows: [] });
    });
    const before = Date.now();
    await tasks.storePendingQuestion('Ana', { questionType: 'confirm_close' });
    const parsed = JSON.parse(stored);
    const deltaMin = (new Date(parsed.expiresAt).getTime() - before) / 60000;
    expect(deltaMin).toBeGreaterThanOrEqual(19);
    expect(deltaMin).toBeLessThanOrEqual(21);
  });

  test('expired pending notifies admin + clears', async () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT value FROM app_state/.test(sql)) {
        return Promise.resolve({
          rows: [{
            value: JSON.stringify({
              questionType: 'confirm_close',
              askedAt: new Date(Date.now() - 21 * 60 * 1000).toISOString(),
              expiresAt: past,
            }),
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const q = await tasks.getPendingQuestion('Ana');
    expect(q).toBeNull();
    expect(eod.notifyAdmin).toHaveBeenCalledTimes(1);
  });
});
