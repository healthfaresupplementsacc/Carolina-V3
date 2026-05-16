'use strict';
// BUG DUP BREAK — "Vitor · iniciado 14:29" listed twice. Two open
// `pauses` rows for the same operator. Fix: render one row per operator
// (DISTINCT ON), and enforce one open break per operator at the DB
// level (dedup + partial unique index), idempotent.
const fs = require('fs');
const path = require('path');

const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db', 'index.js'), 'utf8');

describe('BUG DUP BREAK — activeBreaks renders one row per operator', () => {
  test('query uses DISTINCT ON the operator (no duplicate rows)', () => {
    // the open-breaks query from /api/dashboard
    const q = apiSrc.slice(apiSrc.indexOf('FROM pauses p\n        LEFT JOIN tasks t') - 400,
                            apiSrc.indexOf('FROM pauses p\n        LEFT JOIN tasks t') + 200);
    expect(q).toMatch(/SELECT DISTINCT ON \(COALESCE\(p\.operator, t\.operator\)\)/);
    expect(q).toMatch(/ORDER BY COALESCE\(p\.operator, t\.operator\), p\.started_at ASC/);
    // the old un-deduped form is gone
    expect(apiSrc).not.toMatch(/SELECT p\.id, p\.task_id, p\.started_at,\n\s+COALESCE\(p\.operator, t\.operator\) AS operator,\n\s+t\.supplement_name\n\s+FROM pauses p\n\s+LEFT JOIN tasks t ON t\.id = p\.task_id\n\s+WHERE p\.ended_at IS NULL\n\s+ORDER BY p\.started_at ASC/);
  });
});

describe('BUG DUP BREAK — DB enforces one open break per operator', () => {
  test('migrate dedups existing open duplicates (keep earliest)', () => {
    expect(dbSrc).toMatch(/UPDATE pauses SET ended_at = started_at, ended_reason = 'auto_dedup'/);
    expect(dbSrc).toMatch(/ROW_NUMBER\(\) OVER \(\s*PARTITION BY operator ORDER BY started_at ASC, id ASC\)/);
    expect(dbSrc).toMatch(/WHERE d\.rn > 1/);
  });
  test('migrate creates the partial unique index (idempotent)', () => {
    expect(dbSrc).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_pause_per_operator\s+ON pauses \(operator\) WHERE ended_at IS NULL AND operator IS NOT NULL/);
    // dedup must precede index creation (else CREATE fails on dups)
    const dedupAt = dbSrc.indexOf("ended_reason = 'auto_dedup'");
    const idxAt = dbSrc.indexOf('uniq_open_pause_per_operator');
    expect(dedupAt).toBeGreaterThan(-1);
    expect(idxAt).toBeGreaterThan(dedupAt);
  });
});

describe('BUG DUP BREAK — query-shape behavioural lock via the api router', () => {
  jest.resetModules();
  jest.doMock('../db');
  const db = require('../db');
  const express = require('express');
  const http = require('http');

  test('the open-breaks query is the DISTINCT ON variant at runtime', async () => {
    const sqls = [];
    db.query = jest.fn().mockImplementation((sql) => {
      sqls.push(String(sql));
      return Promise.resolve({ rows: [] });
    });
    const app = express();
    app.use('/api', require('../routes/api'));
    await new Promise((resolve) => {
      const server = app.listen(0, () => {
        const port = server.address().port;
        http.get({ hostname: '127.0.0.1', port, path: '/api/dashboard' }, (res) => {
          res.on('data', () => {}); res.on('end', () => { server.close(); resolve(); });
        }).on('error', () => { server.close(); resolve(); });
      });
    });
    const open = sqls.find((s) => /FROM pauses p/.test(s) && /LEFT JOIN tasks t/.test(s) && /p\.ended_at IS NULL/.test(s));
    expect(open).toBeTruthy();
    expect(open).toMatch(/DISTINCT ON \(COALESCE\(p\.operator, t\.operator\)\)/);
  });
});
