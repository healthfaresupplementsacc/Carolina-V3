'use strict';
/**
 * Bug 5 — /admin/workflows + /admin/ad-hoc-tasks pages render and wire
 * to the existing CRUD endpoints.
 */
jest.mock('../db');
const db = require('../db');
const express = require('express');
const http = require('http');

function buildApp() {
  const app = express();
  app.use('/', require('../dashboard/router'));
  return app;
}
function get(url) {
  return new Promise((resolve) => {
    const server = buildApp().listen(0, () => {
      const port = server.address().port;
      http.get({ hostname: '127.0.0.1', port, path: url }, (res) => {
        let c = ''; res.on('data', (d) => { c += d; });
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: c }); });
      }).on('error', () => { server.close(); resolve({ status: 0 }); });
    });
  });
}
beforeEach(() => { jest.clearAllMocks(); db.query = jest.fn().mockResolvedValue({ rows: [] }); });

describe('Bug 5 — /admin/workflows', () => {
  test('renders with PIN gate + workflow CRUD wiring', async () => {
    const r = await get('/admin/workflows');
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/Admin PIN/);
    expect(r.body).toMatch(/Workflows & Fases/);
    // wires to the real endpoints
    expect(r.body).toMatch(/\/api\/workflow-templates\?include_inactive=1/);
    expect(r.body).toMatch(/\/api\/admin\/phase-templates/);
    expect(r.body).toMatch(/\/api\/admin\/workflow-templates/);
    // phase editable fields present
    expect(r.body).toMatch(/is_required/);
    expect(r.body).toMatch(/can_run_parallel/);
    expect(r.body).toMatch(/soft_prereq/);
    expect(r.body).toMatch(/sequence_order/);
    // create + reorder + delete + add affordances
    expect(r.body).toMatch(/Novo workflow/);
    expect(r.body).toMatch(/\+ Fase/);
    expect(r.body).toMatch(/Desativar workflow/);
  });
});

describe('Bug 5 — /admin/ad-hoc-tasks', () => {
  test('renders with PIN gate + ad-hoc CRUD/approve wiring', async () => {
    const r = await get('/admin/ad-hoc-tasks');
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/Admin PIN/);
    expect(r.body).toMatch(/Tarefas avulsas/);
    expect(r.body).toMatch(/\/api\/ad-hoc-tasks\?include_inactive=1/);
    expect(r.body).toMatch(/\/api\/admin\/ad-hoc-tasks/);
    expect(r.body).toMatch(/Aprovar/);          // approve pending
    expect(r.body).toMatch(/admin_approved:\s*true/);
    expect(r.body).toMatch(/Nova tarefa avulsa/); // create
    expect(r.body).toMatch(/pendente/);          // pending badge
  });

  test('cross-links between the two admin pages', async () => {
    const wf = await get('/admin/workflows');
    const ah = await get('/admin/ad-hoc-tasks');
    expect(wf.body).toMatch(/\/admin\/ad-hoc-tasks/);
    expect(ah.body).toMatch(/\/admin\/workflows/);
  });
});
