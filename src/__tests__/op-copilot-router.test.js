'use strict';
/**
 * /api/v3/op-freight/copilot (FASE A do copiloto de frete).
 *  1. auth = a MESMA dupla do /op: sem Bearer OPERATOR_PAGE_TOKEN → 401
 *     invalid_page_token; com page token mas sessão morta → 401 invalid_session
 *     (shapes idênticos ao op.js: o api() da Central já sabe tratar os dois)
 *  2. autenticado → 200 {data: copilotSummary(hoje NY)} com a forma inteira
 * Servidor real numa porta efêmera (mesmo padrão do prefs-router.test.js);
 * db fake responde a query da sessão e a do copilotSummary. Nada de rede externa.
 */
const express = require('express');
const { createOpCopilotRouter } = require('../v3/freight/op-copilot-router');

const PAGE_TOKEN = 'qa-page-token';
const GOOD_SESSION = 'sessao-viva';

function makeDb() {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      // op-auth getSession: sessão viva só pro token bom
      if (/FROM v3\.operator_sessions/.test(q)) {
        if (params[0] === GOOD_SESSION) {
          return { rows: [{ session_id: 9, person_id: 7, display_name: 'QA Operadora', role: 'operator', active: true }] };
        }
        return { rows: [] };
      }
      // copilotSummary (um dia NY)
      if (/AS cheaper_n/.test(q)) {
        return { rows: [{ labeled: 12, total_cost: '73.40', outliers: 3,
          cheaper_n: 2, cheaper_saving: '4.15', best_n: 1, unquoted_n: 0 }] };
      }
      return { rows: [] };
    },
  };
}

let server, base;

beforeAll(async () => {
  const app = express();
  app.use('/', createOpCopilotRouter({ db: makeDb(), operatorToken: PAGE_TOKEN }));
  server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

async function call(headers = {}) {
  const r = await fetch(base + '/api/v3/op-freight/copilot', { headers });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
}

describe('/api/v3/op-freight/copilot — auth (a dupla do /op)', () => {
  test('sem page token → 401 invalid_page_token (mesmo shape do op.js)', async () => {
    const r = await call({ 'X-Session-Token': GOOD_SESSION });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'invalid_page_token' });
  });

  test('page token errado → 401 invalid_page_token', async () => {
    const r = await call({ Authorization: 'Bearer errado', 'X-Session-Token': GOOD_SESSION });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'invalid_page_token' });
  });

  test('page token certo mas sessão morta → 401 invalid_session', async () => {
    const r = await call({ Authorization: 'Bearer ' + PAGE_TOKEN, 'X-Session-Token': 'morta' });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'invalid_session' });
  });

  test('page token certo e SEM session token → 401 invalid_session', async () => {
    const r = await call({ Authorization: 'Bearer ' + PAGE_TOKEN });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'invalid_session' });
  });

  test('sem operatorToken configurado NINGUÉM entra (mesma regra do gate do /op)', async () => {
    const app = express();
    app.use('/', createOpCopilotRouter({ db: makeDb(), operatorToken: '' }));
    const s = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/v3/op-freight/copilot`,
      { headers: { Authorization: 'Bearer ', 'X-Session-Token': GOOD_SESSION } });
    expect(r.status).toBe(401);
    await new Promise((res) => s.close(res));
  });
});

describe('/api/v3/op-freight/copilot — resposta', () => {
  test('autenticado → 200 {data} com a forma inteira do copilotSummary', async () => {
    const r = await call({ Authorization: 'Bearer ' + PAGE_TOKEN, 'X-Session-Token': GOOD_SESSION });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      labeled: 12,
      total_cost: 73.40,
      outliers: 3,
      with_cheaper: { n: 2, saving: 4.15 },
      best_already: { n: 1 },
      unquoted: { n: 0 },
    });
  });
});
