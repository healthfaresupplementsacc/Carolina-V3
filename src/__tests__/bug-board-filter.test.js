'use strict';
// BUG BOARD-FILTER — the dashboard operator board showed owners/managers
// (Henrique, Thassio) even when they didn't work the line today. The
// board query now keeps role='operator' always (if active) but only
// includes owner/manager when they have an oal row TODAY (ET).
jest.mock('../db');
const db = require('../db');
const express = require('express');
const http = require('http');

beforeEach(() => { jest.clearAllMocks(); });

function dash(path) {
  const sqls = [];
  db.query = jest.fn((sql, p) => {
    sqls.push(String(sql));
    if (/FROM operators o\s+WHERE o\.active = true/.test(sql)) {
      // the DB applies the filter; emulate it returning only the eligible
      return Promise.resolve({ rows: [{ name: 'Simone' }] });
    }
    return Promise.resolve({ rows: [] });
  });
  return new Promise((resolve) => {
    const app = express();
    app.use('/api', require('../routes/api'));
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get({ hostname: '127.0.0.1', port, path: path || '/api/dashboard' }, (res) => {
        let c = ''; res.on('data', (d) => { c += d; });
        res.on('end', () => { server.close(); let b; try { b = JSON.parse(c); } catch { b = null; } resolve({ status: res.statusCode, body: b, sqls }); });
      }).on('error', () => { server.close(); resolve({ status: 0, body: null, sqls }); });
    });
  });
}

describe('BUG BOARD-FILTER — operator board query', () => {
  test('board query encodes the role + activity-today rule', async () => {
    const r = await dash();
    expect(r.status).toBe(200);
    const q = r.sqls.find((s) => /FROM operators o\s+WHERE o\.active = true/.test(s));
    expect(q).toBeTruthy();
    // operators always (when active)
    expect(q).toMatch(/COALESCE\(o\.role, 'operator'\) = 'operator'/);
    // owners/managers only with an oal row today
    expect(q).toMatch(/COALESCE\(o\.role, 'operator'\) IN \('owner', 'manager'\)/);
    expect(q).toMatch(/EXISTS \(\s*SELECT 1 FROM operator_activity_log oal\s*WHERE oal\.operator_id = o\.id/);
    // "today" resolved in ET
    expect(q).toMatch(/\(oal\.started_at AT TIME ZONE 'America\/New_York'\)::date =/);
    expect(q).toMatch(/\(NOW\(\) AT TIME ZONE 'America\/New_York'\)::date/);
    // inactive operators are excluded at the SQL level
    expect(q).toMatch(/o\.active = true/);
  });

  test('board is built only from the rows that query returns', async () => {
    const r = await dash();
    expect(Array.isArray(r.body.operators)).toBe(true);
    expect(r.body.operators.map((o) => o.name)).toEqual(['Simone']);
  });

  test('historical date pins the activity check to that date (still ET)', async () => {
    const r = await dash('/api/dashboard?date=2026-05-10');
    const q = r.sqls.find((s) => /FROM operators o\s+WHERE o\.active = true/.test(s));
    expect(q).toMatch(/= '2026-05-10'::date/);
  });
});
