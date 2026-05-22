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
const epByPath = (p) => ENDPOINTS.find((e) => e.path === p);

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
    const goalService = { record: jest.fn(async (p) => ({ id: 1, ...p })) };
    const ep = ENDPOINTS.find((e) => e.path === '/api/v3/data/goals' && e.method === 'post');
    const out = await ep.handler(
      { body: { product_id: 56, batch_number: '0135', expected_quantity: 750, production_date: '2026-05-19' }, query: {}, params: {} },
      {}, goalService);
    expect(goalService.record).toHaveBeenCalled();
    expect(goalService.record.mock.calls[0][0]).toMatchObject({
      product_id: 56, expected_quantity: 750, source: 'dashboard', actor_type: 'admin',
    });
    expect(out.data.id).toBe(1);
  });

  test('18 endpoints registrados, todos sob /api/v3/data/ (1 POST)', () => {
    expect(ENDPOINTS).toHaveLength(18);
    expect(ENDPOINTS.every((e) => e.path.startsWith('/api/v3/data/'))).toBe(true);
    expect(ENDPOINTS.filter((e) => e.method === 'post')).toHaveLength(1);
  });
});

describe('V3 data API — createDataRouter', () => {
  test('monta um router Express sem lançar', () => {
    const fakeDb = { query: jest.fn(async () => ({ rows: [] })) };
    const router = createDataRouter({ db: fakeDb });
    expect(typeof router).toBe('function'); // express.Router é uma função
  });
});
