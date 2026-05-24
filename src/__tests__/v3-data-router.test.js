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

  test('38 endpoints registrados, todos sob /api/v3/data/', () => {
    expect(ENDPOINTS).toHaveLength(38);
    expect(ENDPOINTS.every((e) => e.path.startsWith('/api/v3/data/'))).toBe(true);
    expect(ENDPOINTS.filter((e) => (e.method || 'get') === 'get')).toHaveLength(21);
    expect(ENDPOINTS.filter((e) => e.method === 'post')).toHaveLength(7);
    expect(ENDPOINTS.filter((e) => e.method === 'patch')).toHaveLength(6);
    expect(ENDPOINTS.filter((e) => e.method === 'delete')).toHaveLength(4);
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
