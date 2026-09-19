'use strict';
/**
 * JORNADA DO LOTE — GET /api/v3/journey/batch/:id (Bruno 09-10).
 *  1. PIN válido entra; sem PIN → 401.
 *  2. Devolve o lote, os registros em ordem (todos os dias) e as garrafas contadas.
 *  3. Lote inexistente → 404; id ruim → 400.
 * Express real em socket efêmero; banco falso. PINs FICTÍCIOS.
 */
const express = require('express');
const { createJourneyRouter, summarizeJobs } = require('../v3/journey/router');

const ROWS = {
  batch: [{ id: 243, batch_number: 'BR-2026-0381', status: 'open', started_at: '2026-09-08T13:15:00Z', finished_at: null, target_bottles: 600, units_per_bottle: 60, product_id: 9, product: 'RHOD-1000', canonical_name: 'Rhodiola' }],
  events: [
    { id: 1, person_id: 4, person: 'Vitor', slug: 'separating', activity: 'Separando ingredientes', is_background: true, flow: null, started_at: '2026-09-08T13:15:00Z', ended_at: '2026-09-08T14:14:00Z', quantity: null, quantity_unit: null, total_paused_seconds: 0 },
    { id: 2, person_id: 9, person: 'Caroline Braga', slug: 'production_line', activity: 'Linha de Produção', is_background: false, flow: 'production', started_at: '2026-09-09T16:01:00Z', ended_at: '2026-09-09T17:24:00Z', quantity: null, quantity_unit: null, total_paused_seconds: 0 },
  ],
  jobs: [
    { id: 1, document: 'devils.pdf', sheets: 500, machine_labels: 500, print_seconds: 300, product: "Devil's Claw", batch: 'B-1', completed_at: '2026-09-12T15:10:00Z', status: 'done' },
    { id: 2, document: 'rhod.pdf', sheets: 130, machine_labels: 120, print_seconds: 60, product: 'Rhodiola', batch: null, completed_at: '2026-09-12T15:30:00Z', status: 'done', error: null },
    { id: 3, document: 'x.pdf', sheets: null, machine_labels: null, print_seconds: null, product: null, batch: null, completed_at: '2026-09-12T15:40:00Z', status: 'error', error: 'sem papel' },
  ],
  counts: [{ id: 7, bottles: 580, reported_at: '2026-09-09T19:30:00Z', kind: 'production', unit: 'bottle', person: 'Larissa Barbosa' }],
};
const db = {
  async query(sql, params) {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/FROM v3\.app_logins l JOIN v3\.app_roles/.test(q)) return { rows: params[0] === '111111' ? [{ id: 1, name: 'Admin', role: 'admin', rank: 100, functions: ['*'], granted: [], revoked: [] }] : [] };
    if (/FROM v3\.product_batches pb/.test(q)) return { rows: params[0] === 243 ? ROWS.batch : [] };
    if (/closed_reason FROM v3\.events e/.test(q)) return { rows: params[0] === 4464 ? [{ id: 4464, person: 'Vitor', started_at: '2026-09-12T14:57:00Z', ended_at: null, quantity: 620, quantity_unit: 'label' }] : [] };
    if (/FROM v3\.events e/.test(q)) return { rows: ROWS.events };
    if (/FROM v3\.production_counts c/.test(q)) return { rows: ROWS.counts };
    if (/FROM v3\.print_jobs pj/.test(q)) return { rows: ROWS.jobs };
    return { rows: [] };
  },
};
let server, base;
beforeAll(async () => { const app = express(); app.use('/', createJourneyRouter({ db })); server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); base = 'http://127.0.0.1:' + server.address().port; });
afterAll(async () => { await new Promise((r) => server.close(r)); });
const get = async (p, pin) => { const r = await fetch(base + p, { headers: pin ? { 'x-admin-pin': pin } : {} }); return { status: r.status, body: await r.json().catch(() => null) }; };

test('sem PIN → 401', async () => { expect((await get('/api/v3/journey/batch/243')).status).toBe(401); });
test('lote com registros de vários dias + garrafas contadas', async () => {
  const r = await get('/api/v3/journey/batch/243', '111111');
  expect(r.status).toBe(200);
  expect(r.body.data.batch).toMatchObject({ id: 243, batch_number: 'BR-2026-0381', product: 'RHOD-1000' });
  expect(r.body.data.events.map((e) => e.slug)).toEqual(['separating', 'production_line']);
  expect(r.body.data.bottles).toBe(580);
  expect(r.body.data.counts[0].person).toBe('Larissa Barbosa');
});
test('lote inexistente → 404; id ruim → 400', async () => {
  expect((await get('/api/v3/journey/batch/999', '111111')).status).toBe(404);
  expect((await get('/api/v3/journey/batch/abc', '111111')).status).toBe(400);
});

test('registro de Impressão de Labels: cada impressão + resumo (máquina vence spooler, labels/min, por produto)', async () => {
  const r = await get('/api/v3/journey/label-event/4464', '111111');
  expect(r.status).toBe(200);
  expect(r.body.data.event.person).toBe('Vitor');
  expect(r.body.data.jobs).toHaveLength(3);
  expect(r.body.data.summary).toMatchObject({ jobs: 3, labels: 620, print_seconds: 360, labels_per_min: 103, errors: 1 });
  expect(r.body.data.summary.by_product.map((p) => p.product)).toEqual(["Devil's Claw", 'Rhodiola', 'x.pdf']);
  expect((await get('/api/v3/journey/label-event/1', '111111')).status).toBe(404);
});
test('summarizeJobs: arquivos na mesma janela física contam o tempo uma vez só', () => {
  const r = summarizeJobs([
    { id: 1, sheets: 1, print_seconds: 31, phys_started_at: 'a', phys_ended_at: 'b' },
    { id: 2, sheets: 1, print_seconds: 31, phys_started_at: 'a', phys_ended_at: 'b' },
    { id: 3, sheets: 6, print_seconds: 31, phys_started_at: 'a', phys_ended_at: 'b' },
    { id: 4, sheets: 10, print_seconds: 30, phys_started_at: 'c', phys_ended_at: 'd' }]);
  expect(r).toMatchObject({ labels: 18, print_seconds: 61, labels_per_min: 18 });
});
test('summarizeJobs vazio', () => { expect(summarizeJobs([])).toMatchObject({ jobs: 0, labels: 0, labels_per_min: null }); });
