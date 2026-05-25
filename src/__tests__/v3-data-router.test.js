'use strict';
// HEALTHFARE V3 — Bloco 0 / Etapa 2 — testes do router da API de dados + auth.
const { makeAuthMiddleware } = require('../v3/data/auth');
const { createDataRouter, envelope, ENDPOINTS, API_VERSION } = require('../v3/data/router');

function fakeRes() {
  const r = { _status: 200, _json: null };
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}
const epByPath = (p) => ENDPOINTS.find((e) => e.path === p && (e.method || 'get') === 'get');
const epBy = (p, m) => ENDPOINTS.find((e) => e.path === p && (e.method || 'get') === m);

describe('V3 data API — auth na borda', () => {
  test('PIN correto na query → next()', () => {
    const mw = makeAuthMiddleware({ pin: '510510' });
    let nexted = false;
    mw({ query: { pin: '510510' }, headers: {} }, fakeRes(), () => { nexted = true; });
    expect(nexted).toBe(true);
  });

  test('PIN no header x-admin-pin → next()', () => {
    const mw = makeAuthMiddleware({ pin: '510510' });
    let nexted = false;
    mw({ query: {}, headers: { 'x-admin-pin': '510510' } }, fakeRes(), () => { nexted = true; });
    expect(nexted).toBe(true);
  });

  test('sem PIN → 401 JSON {error:{code:unauthorized}}, sem next()', () => {
    const mw = makeAuthMiddleware({ pin: '510510' });
    let nexted = false;
    const res = fakeRes();
    mw({ query: {}, headers: {} }, res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res._status).toBe(401);
    expect(res._json.error.code).toBe('unauthorized');
  });

  test('PIN errado → 401', () => {
    const mw = makeAuthMiddleware({ pin: '510510' });
    const res = fakeRes();
    let nexted = false;
    mw({ query: { pin: '000' }, headers: {} }, res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res._status).toBe(401);
  });
});

describe('V3 data API — envelope', () => {
  test('meta tem version/tz/generated_at + data; metaExtra mescla', () => {
    const e = envelope({ x: 1 }, { date: '2026-05-21' });
    expect(e.meta.version).toBe(API_VERSION);
    expect(e.meta.tz).toBe('America/New_York');
    expect(e.meta.date).toBe('2026-05-21');
    expect(e.meta.generated_at).toMatch(/-0[45]:00$/); // gerado em NY
    expect(e.data).toEqual({ x: 1 });
  });
});

describe('V3 data API — endpoints chamam o repo certo', () => {
  test('/timeline → timeline.eventsByDay(date), meta.date', async () => {
    const repos = { timeline: { eventsByDay: jest.fn(async (d) => ({ date: d || '2026-05-21', people: [] })) } };
    const out = await epByPath('/api/v3/data/timeline').handler({ query: { date: '2026-05-19' }, params: {} }, repos);
    expect(repos.timeline.eventsByDay).toHaveBeenCalledWith('2026-05-19');
    expect(out.meta.date).toBe('2026-05-19');
    expect(out.data.people).toEqual([]);
  });

  test('/batches → batches.activeBatches()', async () => {
    const repos = { batches: { activeBatches: jest.fn(async () => ({ active: [{ batch_id: 7 }] })) } };
    const out = await epByPath('/api/v3/data/batches').handler({ query: {}, params: {} }, repos);
    expect(repos.batches.activeBatches).toHaveBeenCalled();
    expect(out.data.active[0].batch_id).toBe(7);
  });

  test('/person/:id/history → history.personHistory(id, {from,to})', async () => {
    const repos = { history: { personHistory: jest.fn(async () => ({ person_id: 4, days: [] })) } };
    await epByPath('/api/v3/data/person/:id/history').handler(
      { params: { id: '4' }, query: { from: '2026-05-01', to: '2026-05-21' } }, repos);
    expect(repos.history.personHistory).toHaveBeenCalledWith(4, { from: '2026-05-01', to: '2026-05-21' });
  });

  test('/messages → messages.messagesByDay(date,{limit})', async () => {
    const repos = { messages: { messagesByDay: jest.fn(async (d) => ({ date: d || '2026-05-21', messages: [] })) } };
    await epByPath('/api/v3/data/messages').handler({ query: { date: '2026-05-21', limit: '20' }, params: {} }, repos);
    expect(repos.messages.messagesByDay).toHaveBeenCalledWith('2026-05-21', { limit: '20' });
  });

  test('/flows → catalog.flows()', async () => {
    const repos = { catalog: { flows: jest.fn(async () => ({ flows: [{ slug: 'pnp', mode: 'block' }] })) } };
    const out = await epByPath('/api/v3/data/flows').handler({ query: {}, params: {} }, repos);
    expect(repos.catalog.flows).toHaveBeenCalled();
    expect(out.data.flows[0].mode).toBe('block');
  });

  test('GET /goals → goals.goalsByDay(date)', async () => {
    const repos = { goals: { goalsByDay: jest.fn(async (d) => ({ date: d, goals: [] })) } };
    const ep = ENDPOINTS.find((e) => e.path === '/api/v3/data/goals' && (e.method || 'get') === 'get');
    const out = await ep.handler({ query: { date: '2026-05-19' }, params: {} }, repos);
    expect(repos.goals.goalsByDay).toHaveBeenCalledWith('2026-05-19');
    expect(out.meta.date).toBe('2026-05-19');
  });

  test('POST /goals → goalService.record (input manual de meta)', async () => {
    const services = { goal: { record: jest.fn(async (p) => ({ id: 1, ...p })) } };
    const ep = epBy('/api/v3/data/goals', 'post');
    const out = await ep.handler(
      { body: { product_id: 56, batch_number: '0135', expected_quantity: 750, production_date: '2026-05-19' }, query: {}, params: {} },
      {}, services);
    expect(services.goal.record).toHaveBeenCalled();
    expect(services.goal.record.mock.calls[0][0]).toMatchObject({
      product_id: 56, expected_quantity: 750, source: 'dashboard', actor_type: 'admin',
    });
    expect(out.data.id).toBe(1);
  });

  test('46 endpoints registrados, todos sob /api/v3/data/', () => {
    expect(ENDPOINTS).toHaveLength(46);
    expect(ENDPOINTS.every((e) => e.path.startsWith('/api/v3/data/'))).toBe(true);
    expect(ENDPOINTS.filter((e) => (e.method || 'get') === 'get')).toHaveLength(24);
    expect(ENDPOINTS.filter((e) => e.method === 'post')).toHaveLength(10);
    expect(ENDPOINTS.filter((e) => e.method === 'patch')).toHaveLength(7);
    expect(ENDPOINTS.filter((e) => e.method === 'delete')).toHaveLength(5);
  });
});

describe('V3 data API — endpoints de escrita (Bloco 3)', () => {
  test('PATCH /goals/:id → goal.correct(id, changes, by, note)', async () => {
    const services = { goal: { correct: jest.fn(async () => ({ id: 5, expected_quantity: 900 })) } };
    const ep = epBy('/api/v3/data/goals/:id', 'patch');
    await ep.handler({ params: { id: '5' }, query: {},
      body: { changes: { expected_quantity: 900 }, by_person_id: 1, note: 'ajuste' } }, {}, services);
    expect(services.goal.correct).toHaveBeenCalledWith(5, { expected_quantity: 900 }, 1, 'ajuste');
  });

  test('POST /events → event.upsert com actor_type=admin e source_message_ts=null (B.6)', async () => {
    const services = { event: { upsert: jest.fn(async () => ({ id: 200 })) } };
    const ep = epBy('/api/v3/data/events', 'post');
    expect(ep).toBeDefined();
    await ep.handler({ params: {}, query: {}, body: {
      person_id: 4, activity_type_id: 5, started_at: '2026-05-24T12:00:00-04:00',
      ended_at: '2026-05-24T13:00:00-04:00', description: 'criado via dashboard',
    } }, {}, services);
    expect(services.event.upsert).toHaveBeenCalledTimes(1);
    const arg = services.event.upsert.mock.calls[0][0];
    expect(arg.person_id).toBe(4);
    expect(arg.activity_type_id).toBe(5);
    expect(arg.actor_type).toBe('admin');
    expect(arg.source_message_ts).toBeNull();
    expect(arg.ended_at).toBe('2026-05-24T13:00:00-04:00');
  });

  test('POST /events — campos obrigatórios: 400 sem person_id ou started_at', async () => {
    const services = { event: { upsert: jest.fn() } };
    const ep = epBy('/api/v3/data/events', 'post');
    await expect(ep.handler({ params: {}, query: {}, body: { started_at: 'x' } }, {}, services))
      .rejects.toThrow(/person_id/);
    await expect(ep.handler({ params: {}, query: {}, body: { person_id: 1 } }, {}, services))
      .rejects.toThrow(/started_at/);
    expect(services.event.upsert).not.toHaveBeenCalled();
  });

  test('DELETE /events/:id → event.softDelete', async () => {
    const services = { event: { softDelete: jest.fn(async () => ({ id: 7, deleted_at: 'x' })) } };
    const ep = epBy('/api/v3/data/events/:id', 'delete');
    await ep.handler({ params: { id: '7' }, query: {}, body: { by_person_id: 1, reason: 'erro' } }, {}, services);
    expect(services.event.softDelete).toHaveBeenCalledWith(7, 1, 'erro');
  });

  test('POST /counts/:id/confirm — decision additional limpa o flag', async () => {
    const services = { count: {
      softDelete: jest.fn(), confirmNotDuplicate: jest.fn(async () => ({ id: 9 })),
    } };
    const ep = epBy('/api/v3/data/counts/:id/confirm', 'post');
    await ep.handler({ params: { id: '9' }, query: {}, body: { decision: 'additional', by_person_id: 1 } }, {}, services);
    expect(services.count.confirmNotDuplicate).toHaveBeenCalledWith(9, 1);
    expect(services.count.softDelete).not.toHaveBeenCalled();
  });

  test('POST /counts/:id/confirm — decision duplicate faz softDelete', async () => {
    const services = { count: {
      softDelete: jest.fn(async () => ({ id: 9 })), confirmNotDuplicate: jest.fn(),
    } };
    const ep = epBy('/api/v3/data/counts/:id/confirm', 'post');
    await ep.handler({ params: { id: '9' }, query: {}, body: { decision: 'duplicate', by_person_id: 1 } }, {}, services);
    expect(services.count.softDelete).toHaveBeenCalled();
    expect(services.count.confirmNotDuplicate).not.toHaveBeenCalled();
  });

  test('PATCH /deadlines/:id → deadline.update', async () => {
    const services = { deadline: { update: jest.fn(async () => ({ id: 1, time_of_day: '14:00' })) } };
    const ep = epBy('/api/v3/data/deadlines/:id', 'patch');
    await ep.handler({ params: { id: '1' }, query: {}, body: { changes: { time_of_day: '14:00' } } }, {}, services);
    expect(services.deadline.update).toHaveBeenCalledWith(1, { time_of_day: '14:00' }, undefined);
  });
});

describe('V3 data API — createDataRouter', () => {
  test('monta um router Express sem lançar', () => {
    const fakeDb = { query: jest.fn(async () => ({ rows: [] })) };
    const router = createDataRouter({ db: fakeDb });
    expect(typeof router).toBe('function'); // express.Router é uma função
  });
});

describe('V3 data API — snapshot (auth por token)', () => {
  const { buildSnapshot } = require('../v3/data/router');
  function fakeRepos(date = '2026-05-25') {
    return {
      timeline:  { eventsByDay: jest.fn(async () => ({ date, people: [
        { person_id: 4, display_name: 'Vitor', events: [
          { event_id: 1, activity: { display_name: 'Linha' }, flow: 'production',
            started_at: '2026-05-25T13:00:00-04:00', ended_at: null, source_message_ts: 't1' },
        ] }] })) },
      flowViews: {
        productionByDay: jest.fn(async () => ({ lotes: [
          { batch_id: 5, batch_number: 'BR-1', product: { canonical_name: 'X' }, invalid_event_count: 0 },
        ] })),
        pnpByDay: jest.fn(async () => ({ total_seconds: 100, orders: 50, seconds_per_order: 2,
          sub_steps: [], quantities: [], people: [], invalid_event_count: 0 })),
        supportByDay: jest.fn(async () => ({ occurrences: [{ is_downtime: true }] })),
      },
      goals: { goalsByDay: jest.fn(async () => ({ goals: [{ duplicatas_suspeitas: [{}, {}] }] })) },
      counts: { countsByDay: jest.fn(async () => ({ counts: [], totals_by_product: {} })) },
      deadlines: { list: jest.fn(async () => ({ deadlines: [] })) },
      metrics: { metricsByDay: jest.fn(async () => ({ total_processed: 10, errors: 0, cost_estimate_usd: 0.1, by_confidence: {} })) },
      health: { workerHealth: jest.fn(async () => ({ alive: true })) },
      messages: { uncertainCases: jest.fn(async () => ({ cases: [] })) },
    };
  }

  test('buildSnapshot agrega timeline + cards + open + uncertain', async () => {
    const r = fakeRepos();
    const out = await buildSnapshot('2026-05-25', r);
    expect(out.date).toBe('2026-05-25');
    expect(out.open_events).toHaveLength(1);
    expect(out.open_events[0]).toMatchObject({ event_id: 1, person: 'Vitor' });
    expect(out.cards.atencao).toMatchObject({
      duplicatas_count: 2,       // 2 dups
      downtime_events: 1,        // 1 ocurrence is_downtime
      open_events_count: 1,
    });
    expect(out.batch_by_id[5]).toMatchObject({ batch_number: 'BR-1' });
    expect(out.worker_health).toEqual({ alive: true });
  });

  test('snapshot route: 503 sem token configurado, 401 com token errado, 200 com token certo', async () => {
    const express = require('express');
    const oldEnv = process.env.V3_SNAPSHOT_TOKEN;

    function callRoute(routerInstance, queryToken) {
      return new Promise((resolve) => {
        const req = { method: 'GET', url: `/api/v3/data/snapshot?token=${queryToken || ''}&date=2026-05-25`,
          query: { token: queryToken, date: '2026-05-25' }, headers: {}, params: {} };
        const res = { _status: 200, _body: null,
          status(c) { this._status = c; return this; },
          json(b)   { this._body = b; resolve({ status: this._status, body: b }); } };
        // simulate router dispatch: find matching handler manually since we don't have HTTP
        // simpler: call buildSnapshot logic by invoking the inner handler we stored.
        routerInstance.handle(req, res, () => resolve({ status: 404, body: null }));
      });
    }

    delete process.env.V3_SNAPSHOT_TOKEN;
    const r503 = createDataRouter({ repos: fakeRepos(), services: {}, db: { query: async () => ({ rows: [] }) } });
    const out503 = await callRoute(r503, 'anything');
    expect(out503.status).toBe(503);

    const r401 = createDataRouter({ repos: fakeRepos(), services: {}, db: { query: async () => ({ rows: [] }) }, snapshotToken: 'GOOD' });
    expect((await callRoute(r401, 'BAD')).status).toBe(401);
    const ok = await callRoute(r401, 'GOOD');
    expect(ok.status).toBe(200);
    expect(ok.body.meta.snapshot).toBe(true);
    expect(ok.body.data.date).toBe('2026-05-25');

    if (oldEnv != null) process.env.V3_SNAPSHOT_TOKEN = oldEnv;
  });
});
