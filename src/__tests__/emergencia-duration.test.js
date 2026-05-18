'use strict';
// EMERGÊNCIA L-03/L-09 — operator board duration must include P&P
// (orders_sessions). Simone did 502+32 orders (~51min) and the card
// showed "0min" because getOperatorStats only summed legacy `tasks`.
// BEHAVIOURAL: drives the real /api/dashboard and asserts the number.
jest.mock('../db');
const db = require('../db');
const express = require('express');
const http = require('http');

beforeEach(() => { jest.clearAllMocks(); });

function dash(taskSecs) {
  db.query = jest.fn((sql) => {
    const s = String(sql);
    if (/FROM operators o\s+WHERE o\.active = true/.test(s)) {
      return Promise.resolve({ rows: [{ name: 'Simone' }] });
    }
    // legacy tasks duration sum
    if (/SELECT COALESCE\(SUM\(active_duration_seconds\), 0\) as secs FROM tasks/.test(s)) {
      return Promise.resolve({ rows: [{ secs: taskSecs }] });
    }
    if (/COUNT\(\*\) as cnt FROM tasks/.test(s)) return Promise.resolve({ rows: [{ cnt: taskSecs ? 1 : 0 }] });
    if (/FROM production_counts/.test(s)) return Promise.resolve({ rows: [{ total: 0 }] });
    // the new orders_sessions sum: 2 sessions, 38m+13m = 3060s
    if (/FROM orders_sessions\s+WHERE operator = \$1/.test(s)) {
      return Promise.resolve({ rows: [{ cnt: 2, secs: 3060 }] });
    }
    return Promise.resolve({ rows: [] });
  });
  return new Promise((resolve) => {
    const app = express();
    app.use('/api', require('../routes/api'));
    const srv = app.listen(0, () => {
      const port = srv.address().port;
      http.get({ hostname: '127.0.0.1', port, path: '/api/dashboard' }, (res) => {
        let c = ''; res.on('data', (d) => { c += d; });
        res.on('end', () => { srv.close(); let b; try { b = JSON.parse(c); } catch { b = null; } resolve(b); });
      }).on('error', () => { srv.close(); resolve(null); });
    });
  });
}

describe('EMERGÊNCIA — operator duration counts P&P', () => {
  test('Simone with only P&P (0 tasks) → ~51min, not 0min', async () => {
    const body = await dash(0);
    const simone = body.operators.find((o) => o.name === 'Simone');
    expect(simone).toBeTruthy();
    expect(simone.active_seconds_today).toBe(3060); // 51 min
    expect(simone.tasks_today).toBe(2);             // 2 P&P sessions counted
  });

  test('tasks + P&P are summed (no regression for line work)', async () => {
    const body = await dash(600); // 10 min of legacy task work
    const simone = body.operators.find((o) => o.name === 'Simone');
    expect(simone.active_seconds_today).toBe(600 + 3060); // task + P&P
    expect(simone.tasks_today).toBe(1 + 2);
  });
});
