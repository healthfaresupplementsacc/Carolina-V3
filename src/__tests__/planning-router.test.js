'use strict';
/**
 * /api/v3/planning/* (Bruno 09-04, direção corrigida) — router da página
 * Planejamento (funil do EMS + plano por dia + anotações).
 *  1. auth = família do warehouse: sem PIN → 401; PIN só view_stock lê mas
 *     NÃO escreve (403 manage_stock em PUT/POST/DELETE).
 *  2. GET /board → {data:{columns...}} (o modelo é injetado).
 *  3. plano: GET vazio, PUT com a lista ordenada regrava posições (reorder),
 *     PUT inválido → 400, POST /plan/item adiciona no fim, DELETE remove
 *     (e NUNCA apaga linha-flag do quadro: plan_date IS NOT NULL no WHERE).
 *  4. notas: GET vazio → body '', PUT upsert, date ausente → 400.
 *  5. POST /board/boxed grava a linha-flag (plan_date NULL) com upsert.
 * Servidor real numa porta efêmera; db fake responde app_logins (auth) +
 * as tabelas do plano. Nada de rede externa.
 */
const express = require('express');
const { createPlanningRouter } = require('../v3/planning/router');

const ADMIN_PIN = '510510';   // fallback de emergência do data/auth (functions ['*'])
const VIEWER_PIN = 'planning-viewer-pin';

const BOARD = {
  columns: [
    { id: 'formulating', title: 'Formulando', count: 1, cards: [{ batch_number: 'B1', product: 'Ash', column: 'formulating' }] },
    { id: 'encapsulating', title: 'Encapsulando', count: 0, cards: [] },
    { id: 'waiting', title: 'Esperando revisão', count: 0, cards: [] },
    { id: 'revising', title: 'Em revisão', count: 0, cards: [] },
    { id: 'ready', title: 'Pronto pra produção', count: 0, cards: [] },
    { id: 'produced', title: 'Produzido', count: 0, cards: [] },
    { id: 'boxed', title: 'Encaixotado', count: 0, cards: [] },
  ],
  generated_at: '2026-09-04T12:00:00Z', ems_ok: true,
};

function makeDb(state) {
  let nextId = 100;
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      state.queries.push({ q, params });
      if (/FROM v3\.app_logins/.test(q)) {
        if (params[0] === VIEWER_PIN) {
          return { rows: [{ id: 5, name: 'QA Viewer', role: 'manager', rank: 50, functions: ['view_stock'] }] };
        }
        return { rows: [] };
      }
      if (/DELETE FROM v3\.production_plan_items WHERE plan_date = \$1/.test(q)) {
        state.items = state.items.filter((i) => i.plan_date !== params[0]);
        return { rows: [] };
      }
      if (/DELETE FROM v3\.production_plan_items WHERE id = \$1 AND plan_date IS NOT NULL/.test(q)) {
        const hit = state.items.find((i) => i.id === params[0] && i.plan_date != null);
        if (!hit) return { rows: [] };
        state.items = state.items.filter((i) => i !== hit);
        return { rows: [{ id: hit.id }] };
      }
      if (/INSERT INTO v3\.production_plan_items \(plan_date, batch_number, manual_boxed/.test(q)) {
        state.flags.set(params[0], { manual_boxed: params[1], by: params[2] });
        return { rows: [{ batch_number: params[0], manual_boxed: params[1] }] };
      }
      if (/INSERT INTO v3\.production_plan_items/.test(q) && /COALESCE\(\(SELECT MAX\(position\)/.test(q)) {
        const pos = state.items.filter((i) => i.plan_date === params[0]).length;
        const row = { id: nextId++, plan_date: params[0], position: pos, batch_number: params[1],
          product_id: params[2], custom_title: params[3], note: params[4], done: false };
        state.items.push(row);
        return { rows: [row] };
      }
      if (/INSERT INTO v3\.production_plan_items/.test(q)) {
        const row = { id: nextId++, plan_date: params[0], position: params[1], batch_number: params[2],
          product_id: params[3], custom_title: params[4], note: params[5], done: params[6] };
        state.items.push(row);
        return { rows: [row] };
      }
      if (/SELECT id, plan_date, position/.test(q)) {
        const rows = state.items.filter((i) => i.plan_date === params[0])
          .sort((a, b) => a.position - b.position || a.id - b.id);
        return { rows };
      }
      if (/FROM v3\.planning_notes WHERE plan_date/.test(q)) {
        const n = state.notes.get(params[0]);
        return { rows: n ? [{ plan_date: params[0], body: n, updated_at: '2026-09-04T12:00:00Z' }] : [] };
      }
      if (/INSERT INTO v3\.planning_notes/.test(q)) {
        state.notes.set(params[0], params[1]);
        return { rows: [{ plan_date: params[0], body: params[1], updated_at: '2026-09-04T12:00:00Z' }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

let server, base, state;
const url = (p) => base + '/api/v3/planning' + p;
const hit = (method, p, pin, body) => fetch(url(p), {
  method,
  headers: { ...(pin ? { 'x-admin-pin': pin } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

beforeAll(async () => {
  state = { queries: [], items: [], notes: new Map(), flags: new Map() };
  const app = express();
  const board = { board: async () => BOARD };
  app.use('/', createPlanningRouter({ db: makeDb(state), board }));
  server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('auth (família do warehouse)', () => {
  test('sem PIN → 401 em tudo', async () => {
    for (const [m, p] of [['GET', '/board'], ['GET', '/plan?date=2026-09-05'], ['GET', '/notes?date=2026-09-05']]) {
      const r = await hit(m, p, null);
      expect(r.status).toBe(401);
    }
  });
  test('view_stock LÊ o board mas NÃO escreve (403)', async () => {
    expect((await hit('GET', '/board', VIEWER_PIN)).status).toBe(200);
    expect((await hit('PUT', '/plan?date=2026-09-05', VIEWER_PIN, { items: [] })).status).toBe(403);
    expect((await hit('POST', '/plan/item', VIEWER_PIN, { plan_date: '2026-09-05', custom_title: 'x' })).status).toBe(403);
    expect((await hit('DELETE', '/plan/item/1', VIEWER_PIN)).status).toBe(403);
    expect((await hit('PUT', '/notes?date=2026-09-05', VIEWER_PIN, { body: 'x' })).status).toBe(403);
    expect((await hit('POST', '/board/boxed', VIEWER_PIN, { batch_number: 'B1', manual_boxed: true })).status).toBe(403);
  });
});

describe('GET /board', () => {
  test('devolve as 7 colunas do modelo injetado', async () => {
    const r = await hit('GET', '/board', ADMIN_PIN);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.data.columns.length).toBe(7);
    expect(j.data.columns[0].cards[0].batch_number).toBe('B1');
    expect(j.data.ems_ok).toBe(true);
  });
});

describe('plano por dia (CRUD + reorder)', () => {
  const D = '2026-09-05';
  test('GET vazio antes de qualquer escrita', async () => {
    const j = await (await hit('GET', `/plan?date=${D}`, ADMIN_PIN)).json();
    expect(j.data).toEqual({ date: D, items: [] });
  });
  test('date inválida → 400', async () => {
    expect((await hit('GET', '/plan?date=amanha', ADMIN_PIN)).status).toBe(400);
    expect((await hit('PUT', '/plan', ADMIN_PIN, { items: [] })).status).toBe(400);
  });
  test('PUT grava a lista ordenada (position = índice)', async () => {
    const r = await hit('PUT', `/plan?date=${D}`, ADMIN_PIN, { items: [
      { batch_number: 'B1' },
      { custom_title: 'Limpar a encapsuladora' },
      { batch_number: 'B2', note: 'prioridade' },
    ] });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.data.items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(j.data.items[1].custom_title).toBe('Limpar a encapsuladora');
  });
  test('PUT de novo com outra ordem = reorder persistido', async () => {
    const cur = (await (await hit('GET', `/plan?date=${D}`, ADMIN_PIN)).json()).data.items;
    const reordered = [cur[2], cur[0], cur[1]].map((i) => ({
      batch_number: i.batch_number, custom_title: i.custom_title, note: i.note, done: i.done }));
    await hit('PUT', `/plan?date=${D}`, ADMIN_PIN, { items: reordered });
    const after = (await (await hit('GET', `/plan?date=${D}`, ADMIN_PIN)).json()).data.items;
    expect(after.map((i) => i.batch_number || i.custom_title))
      .toEqual(['B2', 'B1', 'Limpar a encapsuladora']);
  });
  test('PUT com item sem lote e sem título → 400', async () => {
    expect((await hit('PUT', `/plan?date=${D}`, ADMIN_PIN, { items: [{ note: 'só nota' }] })).status).toBe(400);
  });
  test('POST /plan/item adiciona no fim; DELETE remove', async () => {
    const j = await (await hit('POST', '/plan/item', ADMIN_PIN, { plan_date: D, custom_title: 'Chegou cápsula' })).json();
    expect(j.data.position).toBe(3);
    const del = await hit('DELETE', `/plan/item/${j.data.id}`, ADMIN_PIN);
    expect(del.status).toBe(200);
    expect((await hit('DELETE', `/plan/item/${j.data.id}`, ADMIN_PIN)).status).toBe(404);
  });
});

describe('anotações por dia', () => {
  const D = '2026-09-06';
  test('GET sem nota → body vazio, nunca 404', async () => {
    const j = await (await hit('GET', `/notes?date=${D}`, ADMIN_PIN)).json();
    expect(j.data.body).toBe('');
    expect(j.data.updated_at).toBe(null);
  });
  test('PUT upsert + GET devolve o que gravou', async () => {
    const put = await (await hit('PUT', `/notes?date=${D}`, ADMIN_PIN, { body: 'Amanhã: revisar Charcoal primeiro' })).json();
    expect(put.data.body).toBe('Amanhã: revisar Charcoal primeiro');
    const j = await (await hit('GET', `/notes?date=${D}`, ADMIN_PIN)).json();
    expect(j.data.body).toBe('Amanhã: revisar Charcoal primeiro');
  });
  test('sem date → 400', async () => {
    expect((await hit('PUT', '/notes', ADMIN_PIN, { body: 'x' })).status).toBe(400);
  });
});

describe('POST /board/boxed (flag manual de Encaixotado)', () => {
  test('grava a linha-flag e devolve o estado', async () => {
    const j = await (await hit('POST', '/board/boxed', ADMIN_PIN, { batch_number: 'B-77', manual_boxed: true })).json();
    expect(j.data).toEqual({ batch_number: 'B-77', manual_boxed: true });
    expect(state.flags.get('B-77').manual_boxed).toBe(true);
  });
  test('desmarca com manual_boxed false; sem batch_number → 400', async () => {
    await hit('POST', '/board/boxed', ADMIN_PIN, { batch_number: 'B-77', manual_boxed: false });
    expect(state.flags.get('B-77').manual_boxed).toBe(false);
    expect((await hit('POST', '/board/boxed', ADMIN_PIN, {})).status).toBe(400);
  });
});
