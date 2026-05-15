'use strict';
jest.mock('../db');
const db = require('../db');
const express = require('express');
const http = require('http');

function buildApp(router) {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes/workflow'));
  app.use('/', require('../dashboard/router'));
  return app;
}
function request(method, url) {
  return new Promise((resolve) => {
    const server = buildApp().listen(0, () => {
      const port = server.address().port;
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method }, (res) => {
        let c = ''; res.on('data', (d) => { c += d; });
        res.on('end', () => { server.close(); let p; try { p = JSON.parse(c); } catch { p = c; } resolve({ status: res.statusCode, body: p }); });
      });
      req.on('error', () => { server.close(); resolve({ status: 0 }); });
      req.end();
    });
  });
}
beforeEach(() => { jest.clearAllMocks(); });

describe('GET /api/operator-panel', () => {
  test('returns one entry per active operator with current + today stats', async () => {
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/FROM operators WHERE active = TRUE/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, name: 'Ana' }] });
      }
      if (/FROM operator_activity_log oal[\s\S]+ended_at IS NULL/.test(sql)) {
        return Promise.resolve({ rows: [{
          activity_type: 'phase', started_at: '2026-05-15T10:00:00Z',
          phase_name: 'Linha de Produção', product_name: 'Green Tea', task_name: null,
        }]});
      }
      if (/COALESCE\(SUM\(CASE WHEN activity_type IN/.test(sql)) {
        return Promise.resolve({ rows: [{ worked_secs: 7200, break_secs: 1800, phases_done: 3 }] });
      }
      if (/SUM\(pi.final_bottle_count\)/.test(sql)) {
        return Promise.resolve({ rows: [{ n: 480 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('GET', '/api/operator-panel');
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(1);
    expect(r.body[0].name).toBe('Ana');
    expect(r.body[0].status).toBe('phase');
    expect(r.body[0].current.label).toMatch(/Linha de Produção · Green Tea/);
    expect(r.body[0].today.bottles).toBe(480);
    expect(r.body[0].today.phases_done).toBe(3);
  });

  test('idle operator → status idle, current null', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM operators WHERE active = TRUE/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 2, name: 'Bruno' }] });
      }
      if (/ended_at IS NULL/.test(sql) && /operator_activity_log oal/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/COALESCE\(SUM/.test(sql)) return Promise.resolve({ rows: [{ worked_secs: 0, break_secs: 0, phases_done: 0 }] });
      if (/final_bottle_count/.test(sql)) return Promise.resolve({ rows: [{ n: 0 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await request('GET', '/api/operator-panel');
    expect(r.body[0].status).toBe('idle');
    expect(r.body[0].current).toBeNull();
  });
});

describe('GET /operator/:id page', () => {
  test('renders timeline + week stats HTML', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, name, role FROM operators WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, name: 'Ana', role: 'produção' }] });
      }
      if (/FROM operator_activity_log oal[\s\S]+ORDER BY oal.started_at ASC/.test(sql)) {
        return Promise.resolve({ rows: [{
          activity_type: 'phase', started_at: '2026-05-15T10:00:00Z',
          ended_at: '2026-05-15T11:00:00Z', duration_seconds: 3600,
          role: 'starter', phase_name: 'Encapsulação', product_name: 'Berberine',
          batch_number: '0119', task_name: null,
        }]});
      }
      if (/date_trunc\('week'/.test(sql) && /AS worked/.test(sql)) {
        return Promise.resolve({ rows: [{ worked: 14400, brk: 3600, phases: 5 }] });
      }
      if (/GROUP BY pi.phase_name/.test(sql)) {
        return Promise.resolve({ rows: [{ phase_name: 'Encapsulação', n: 3, avg_min: 55 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('GET', '/operator/1');
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/Ana/);
    expect(r.body).toMatch(/Encapsulação · Berberine #0119/);
    expect(r.body).toMatch(/fases conclu[íi]das/);
    expect(r.body).toMatch(/M[ée]dias por fase/);
  });

  test('404 for unknown operator', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await request('GET', '/operator/999');
    expect(r.status).toBe(404);
  });

  test('400 for non-numeric id', async () => {
    const r = await request('GET', '/operator/abc');
    expect(r.status).toBe(400);
  });
});
