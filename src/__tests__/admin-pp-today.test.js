'use strict';
/* FASE 6 (P6.3) — card "P&P do dia": ordens counts_as_pp (clínica fora), tempo
   descontando pausa, seg/ordem, breakdown, corte 1pm. */
const express = require('express');
const { createAdminRouter } = require('../routes/admin');
const resp = (rows) => ({ rows, rowCount: rows.length });
const PW = 'emergency-pw';

describe('FASE 6 — P&P do dia', () => {
  let server, base, token, nyMin;
  function makeDb() {
    return { query: async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/COUNT\(\*\)::int n FROM v3\.admin_users WHERE is_active = true/.test(s)) return resp([{ n: 0 }]);
      if (/FROM v3\.admin_sessions s JOIN v3\.admin_users u/.test(s)) return resp([]);
      if (/AS orders, COUNT\(DISTINCT e\.id\)::int AS tasks/.test(s)) return resp([{ orders: 48, tasks: 2 }]);
      if (/AS marketplace, SUM\(pc\.bottles\)::int AS orders/.test(s)) return resp([{ marketplace: 'Amazon', orders: 30 }, { marketplace: '—', orders: 18 }]);
      if (/p\.display_name AS operator, SUM\(pc\.bottles\)::int AS orders/.test(s)) return resp([{ operator: 'Vitor', orders: 48 }]);
      if (/COALESCE\(SUM\(.*\),0\)::int AS work_sec/.test(s)) return resp([{ work_sec: 3600 }]);
      if (/COUNT\(\*\)::int AS n FROM v3\.events e/.test(s)) return resp([{ n: 1 }]); // 1 P&P aberta
      if (/AS ny_min/.test(s)) return resp([{ ny_min: nyMin }]);
      return resp([]);
    } };
  }
  async function boot() {
    if (server) await new Promise((r) => server.close(r));
    const app = express();
    app.use('/', createAdminRouter({ db: makeDb(), slack: { postAs: () => {} }, adminPassword: PW }));
    server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    base = `http://127.0.0.1:${server.address().port}`;
    token = (await (await fetch(base + '/api/adminpanel/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) })).json()).token;
  }
  afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });
  async function get() { const r = await fetch(base + '/api/adminpanel/metrics/pp-today', { headers: { Authorization: 'Bearer ' + token } }); return { status: r.status, body: await r.json() }; }

  test('ordens + seg/ordem + breakdown (clínica fora via counts_as_pp no SQL)', async () => {
    nyMin = 600; await boot(); // 10:00 → verde
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.total_orders).toBe(48);
    expect(r.body.sec_per_order).toBe(75); // 3600/48
    expect(r.body.by_marketplace).toHaveLength(2);
    expect(r.body.by_operator[0]).toMatchObject({ operator: 'Vitor', orders: 48 });
    expect(r.body.cutoff_color).toBe('green');
  });
  test('corte 1pm: depois das 13h com tarefa aberta → vermelho', async () => {
    nyMin = 13 * 60 + 20; await boot(); // 13:20 + 1 aberta
    expect((await get()).body.cutoff_color).toBe('red');
  });
  test('corte 1pm: 12:40 → amarelo', async () => {
    nyMin = 12 * 60 + 40; await boot();
    expect((await get()).body.cutoff_color).toBe('yellow');
  });
});
