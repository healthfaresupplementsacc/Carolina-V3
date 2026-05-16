'use strict';
// BUG DASHBOARD — finished phases/ad-hoc/workflows must not vanish;
// they go to a "Concluído Hoje" section (closed TODAY in ET, resets at
// ET midnight via the server-side ended_at filter).
jest.mock('../db');
const db = require('../db');
const express = require('express');
const http = require('http');
const { generateDashboard } = require('../dashboard/template');

beforeEach(() => { jest.clearAllMocks(); });

function dash() {
  const sqls = [];
  db.query = jest.fn().mockImplementation((sql) => { sqls.push(String(sql)); return Promise.resolve({ rows: [] }); });
  return new Promise((resolve) => {
    const app = express();
    app.use('/api', require('../routes/api'));
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get({ hostname: '127.0.0.1', port, path: '/api/dashboard' }, (res) => {
        let c = ''; res.on('data', (d) => { c += d; });
        res.on('end', () => { server.close(); let b; try { b = JSON.parse(c); } catch { b = null; } resolve({ status: res.statusCode, body: b, sqls }); });
      }).on('error', () => { server.close(); resolve({ status: 0, body: null, sqls }); });
    });
  });
}

describe('BUG DASHBOARD — backend completedToday', () => {
  test('/api/dashboard returns a completedToday array', async () => {
    const r = await dash();
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.completedToday)).toBe(true);
  });

  test('queries closed-today phase/adhoc/workflow filtered by ended_at in ET', async () => {
    const r = await dash();
    const ph = r.sqls.find((s) => /FROM phase_instances pi/.test(s) && /pi\.ended_at IS NOT NULL/.test(s) && /pi\.status <> 'open'/.test(s));
    const ah = r.sqls.find((s) => /FROM ad_hoc_task_instances ati/.test(s) && /ati\.ended_at IS NOT NULL/.test(s) && /ati\.status <> 'open'/.test(s));
    const wf = r.sqls.find((s) => /FROM workflow_instances wi/.test(s) && /wi\.ended_at IS NOT NULL/.test(s) && /wi\.status <> 'active'/.test(s));
    expect(ph).toBeTruthy();
    expect(ah).toBeTruthy();
    expect(wf).toBeTruthy();
    expect(ph).toMatch(/\(pi\.ended_at AT TIME ZONE 'America\/New_York'\)::date =/); // ET, resets at ET midnight
    expect(wf).toMatch(/auto_cleanup_ghost.*NOT LIKE|NOT LIKE '%\[auto_cleanup_ghost\]%'/); // ghosts excluded
  });
});

describe('BUG DASHBOARD — frontend section + renderer', () => {
  const HTML = generateDashboard();
  test('"Concluído Hoje" section sits after EM ANDAMENTO, before legacy Produção', () => {
    const emAnd = HTML.indexOf('SECTION 2: EM ANDAMENTO');
    const compl = HTML.indexOf('id="completed-today-body"');
    const legacy = HTML.indexOf('SECTION 2b: PRODUCAO DO DIA');
    expect(emAnd).toBeGreaterThan(-1);
    expect(compl).toBeGreaterThan(emAnd);
    expect(legacy).toBeGreaterThan(compl);
    expect(HTML).toContain('✅ Concluído Hoje');
  });
  test('renderCompletedToday exists and is called by renderAll', () => {
    expect(HTML).toMatch(/function renderCompletedToday\(items\)/);
    expect(HTML).toMatch(/renderCompletedToday\(data\.completedToday \|\| \[\]\)/);
    // shows participants + duration + bottles + closed time
    expect(HTML).toMatch(/it\.participants/);
    expect(HTML).toMatch(/formatDuration\(it\.duration_seconds\)/);
    expect(HTML).toMatch(/garrafas/);
    expect(HTML).toMatch(/formatTime\(it\.ended_at\)/);
  });
});
