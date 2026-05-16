'use strict';
/**
 * Bug 4 — /api/dashboard must surface ISA-88 activities (created via
 * App Home) in openTasks, deduped against the legacy dual-write.
 */
jest.mock('../db');
jest.mock('../tasks', () => ({
  getOpenTasks: jest.fn().mockResolvedValue([]),
  getTodayTasks: jest.fn().mockResolvedValue([]),
  getSupplementHistory: jest.fn().mockResolvedValue([]),
}));
jest.mock('../orders', () => ({
  getTodayOrders: jest.fn().mockResolvedValue([]),
  getDayOrdersTotal: jest.fn().mockResolvedValue({ total: 0, sessionCount: 0 }),
}));
jest.mock('../formulation', () => ({ getTodayFormulations: jest.fn().mockResolvedValue([]) }));
jest.mock('../parser', () => ({
  parseMessage: jest.fn(), listSupplements: jest.fn(() => []),
}));

const db = require('../db');
const express = require('express');
const http = require('http');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes/api'));
  return app;
}
function get(url) {
  return new Promise((resolve) => {
    const server = buildApp().listen(0, () => {
      const port = server.address().port;
      http.get({ hostname: '127.0.0.1', port, path: url }, (res) => {
        let c = ''; res.on('data', (d) => { c += d; });
        res.on('end', () => { server.close(); let p; try { p = JSON.parse(c); } catch { p = c; } resolve({ status: res.statusCode, body: p }); });
      }).on('error', () => { server.close(); resolve({ status: 0 }); });
    });
  });
}

beforeEach(() => { jest.clearAllMocks(); });

function baseDb(extra) {
  db.query = jest.fn().mockImplementation((sql, params) => {
    if (/FROM phase_instances pi\s+JOIN workflow_instances wi/.test(sql)) {
      return Promise.resolve({ rows: extra.phases || [] });
    }
    if (/FROM ad_hoc_task_instances ati/.test(sql) && /status = 'open'/.test(sql)) {
      return Promise.resolve({ rows: extra.adhoc || [] });
    }
    if (/app_state WHERE key IN \('silent_mode'/.test(sql)) {
      return Promise.resolve({ rows: [
        { key: 'silent_text', value: 'true' }, { key: 'silent_reactions', value: 'false' },
      ]});
    }
    // yesterday/week totals, prod summary, pauses, timeline, etc.
    return Promise.resolve({ rows: [] });
  });
}

describe('Bug 4 — dashboard union with workflow model', () => {
  test('open phase_instance (App Home, no legacy task) appears in openTasks', async () => {
    baseDb({ phases: [{
      id: 77, phase_name: 'Encapsulação', batch_number: '0098',
      started_at: '2026-05-15T13:00:00Z', product_name: 'Green Tea',
      operator_name: 'Bruno',
    }]});
    const r = await get('/api/dashboard');
    expect(r.status).toBe(200);
    const found = r.body.openTasks.find((t) => t.id === 'ph-77');
    expect(found).toBeTruthy();
    expect(found.supplement_name).toBe('Green Tea');
    expect(found.operator).toBe('Bruno');
    expect(found.task_type).toBe('Encapsulação');
    expect(found._source).toBe('workflow_phase');
  });

  test('open ad_hoc_task_instance appears in openTasks', async () => {
    baseDb({ adhoc: [{
      id: 5, task_name: 'Limpeza', started_at: '2026-05-15T14:00:00Z', operator_name: 'Ana',
    }]});
    const r = await get('/api/dashboard');
    const found = r.body.openTasks.find((t) => t.id === 'ah-5');
    expect(found).toBeTruthy();
    expect(found.task_type).toBe('Limpeza');
    expect(found._source).toBe('workflow_adhoc');
  });

  test('dedup SQL excludes rows with a matching legacy task + migration rows', async () => {
    baseDb({});
    await get('/api/dashboard');
    const wfQ = db.query.mock.calls.map((c) => c[0]).find((s) => /FROM phase_instances pi\s+JOIN workflow_instances wi/.test(s));
    expect(wfQ).toMatch(/pi\.legacy_id IS NULL/);
    expect(wfQ).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM tasks t/);
  });

  test('U3 — workflow cards get time-based urgency colour (no urgency_tier)', () => {
    const tpl = require('../dashboard/template');
    const html = tpl.generateDashboard();
    // getUrgencyClass derives colour from elapsed when tier is absent
    expect(html).toMatch(/U3: workflow phase \/ ad-hoc items have no urgency_tier/);
    expect(html).toMatch(/if \(hrs >= 4\) return 'red'/);
    expect(html).toMatch(/if \(hrs >= 2\) return 'amber'/);
    // the timer div is rendered for every card (string-id safe)
    expect(html).toMatch(/class="task-timer" id="timer-\$\{escHtml\(String\(task\.id\)\)\}"/);
  });

  test('U1 — operator strip renders independently of renderAll', () => {
    const tpl = require('../dashboard/template');
    const html = tpl.generateDashboard();
    // container exists at top of main
    expect(html).toMatch(/<div id="operator-strip"/);
    // strip is invoked BEFORE renderAll and renderAll is wrapped so its
    // failure can't suppress the strip
    const sIdx = html.indexOf('renderOperatorStrip();');
    const aIdx = html.indexOf('renderAll(data);');
    expect(sIdx).toBeGreaterThan(0);
    expect(aIdx).toBeGreaterThan(sIdx);
    expect(html).toMatch(/renderAll error \(strip already rendered\)/);
    // fallback strip attempt on /api/dashboard failure
    expect(html).toMatch(/Last-resort: still attempt the strip/);
  });

  test('Bug A frontend — renderOpenTasks guards workflow items (no invalid JS)', () => {
    const tpl = require('../dashboard/template');
    const html = tpl.generateDashboard();
    // The renderOpenTasks function must branch on _source so string ids
    // ('ph-418') never reach closeTask(...)/deleteTask(...)/openEdit(...)
    expect(html).toMatch(/const isWf = !!task\._source/);
    // task-admin buttons gated behind (adminUnlocked && !isWf)
    expect(html).toMatch(/adminUnlocked && !isWf/);
    // workflow items get a "Gerenciar" link to /admin/workflows instead
    expect(html).toMatch(/adminUnlocked && isWf/);
    expect(html).toMatch(/href="\/admin\/workflows"/);
    // ids are stringified+escaped in the card/timer element ids
    expect(html).toMatch(/id="task-\$\{escHtml\(String\(task\.id\)\)\}"/);
  });

  test('workflow union failure does not break dashboard (fail closed)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM phase_instances pi\s+JOIN workflow_instances wi/.test(sql)) {
        return Promise.reject(new Error('boom'));
      }
      if (/app_state WHERE key IN/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const r = await get('/api/dashboard');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.openTasks)).toBe(true);
  });
});
