'use strict';
/* P&P — contagem de ordens a partir da PRIMEIRA ABERTURA (regra Bruno).
   • 1º a abrir order_printing informa a quantidade (obrigatório) → grava
     production_counts kind='orders' NO START (não depende mais do fim).
   • quem entra depois (mesmo slug já aberto) = joiner: quantidade opcional, não
     conta de novo.
   • no FIM da impressão de ordens NÃO pede mais "quantas empacotadas". */
const express = require('express');
const { createOpRouter } = require('../routes/op');
const opAuth = require('../lib/op-auth');

const resp = (rows) => ({ rows, rowCount: rows.length });
const TOKEN = 'page-token';

describe('P&P — ordens contam do 1º-abre', () => {
  let server, base, mem;
  function slugOf(actId) { const a = mem.acts.find((x) => x.id === actId); return a ? a.slug : null; }
  function bgOf(actId) { const a = mem.acts.find((x) => x.id === actId); return a ? !!a.is_background : false; }
  function makeDb(mem) {
    return { query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) return resp([]);
      if (/INSERT INTO v3\.operator_action_log/.test(s)) return resp([]);
      if (/FROM v3\.persons WHERE role = 'operator'/.test(s)) return resp(mem.persons.filter((p) => p.pin_hash));
      if (/INSERT INTO v3\.operator_sessions/.test(s)) { mem.sessions.push({ token: params[1], person_id: params[0] }); return resp([{ id: 1, person_id: params[0], session_token: params[1], created_at: new Date() }]); }
      if (/UPDATE v3\.persons SET last_page_login_at/.test(s)) return resp([]);
      if (/SELECT s\.person_id, p\.display_name, to_char/.test(s)) return resp([]);
      if (/FROM v3\.operator_sessions s JOIN v3\.persons p/.test(s)) {
        const x = mem.sessions.find((y) => y.token === params[0]); if (!x) return resp([]);
        const p = mem.persons.find((z) => z.id === x.person_id);
        return resp([{ session_id: 1, person_id: p.id, last_activity_at: new Date(), display_name: p.display_name, role: p.role, active: true, auto_logoff_seconds: null, count_exempt: false, is_sandbox: false }]);
      }
      if (/closed_reason = 'pause_expired_overnight'/.test(s)) return resp([]);
      if (/SET is_unfinished = TRUE/.test(s)) return resp([]);
      // first-open check (impressão de ordens)
      if (/SELECT 1 FROM v3\.events e JOIN v3\.activity_types at/.test(s)) {
        const slug = params[0];
        return resp(mem.events.some((e) => slugOf(e.activity) === slug && !e.ended_at && !e.deleted_at) ? [{ x: 1 }] : []);
      }
      if (/FROM v3\.activity_types WHERE slug = \$1/.test(s)) { const a = mem.acts.find((x) => x.slug === params[0]); return resp(a ? [a] : []); }
      if (/SELECT 1 FROM v3\.events WHERE person_id = \$1 AND ended_at IS NULL AND deleted_at IS NULL LIMIT 1/.test(s)) {
        return resp(mem.events.some((e) => e.person === params[0] && !e.ended_at) ? [{ x: 1 }] : []);
      }
      if (/SELECT GREATEST\(.*AS ref/.test(s)) return resp([{ ref: null, minutes: 0 }]);
      // overlap guard openFg
      if (/AS activity_name FROM v3\.events e JOIN v3\.activity_types at/.test(s) && /COALESCE\(at\.is_background, false\) = false/.test(s)) {
        const pid = params[0];
        return resp(mem.events.filter((e) => e.person === pid && !e.ended_at && !e.deleted_at && !e.is_unfinished && !bgOf(e.activity))
          .map((e) => ({ id: e.id, started_at: new Date(), slug: slugOf(e.activity), activity_name: slugOf(e.activity) })));
      }
      if (/UPDATE v3\.events SET ended_at = NOW\(\), closed_reason = '(lunch_started|closed_for_new_task)'/.test(s)) { const ids = params[0] || []; mem.events.forEach((e) => { if (ids.includes(e.id)) e.ended_at = new Date(); }); return resp([]); }
      if (/FROM v3\.product_batches pb LEFT JOIN v3\.products pr/.test(s)) return resp([]);
      // production_counts. START (insertOrdersCount): kind hardcoded 'orders'.
      // FINISH: kind = params[5] (clinic vira 'clinic'). Detecta pelo "'high', $6".
      if (/INSERT INTO v3\.production_counts/.test(s)) {
        const kind = /'high', \$6/.test(s) ? params[5] : 'orders';
        mem.counts.push({ orders: params[2], kind, source_event_id: params[4] }); return resp([]);
      }
      if (/INSERT INTO v3\.events/.test(s)) {
        const id = 500 + mem.events.length;
        mem.events.push({ id, person: params[0], activity: params[1], slug: slugOf(params[1]), ended_at: null, deleted_at: null, is_unfinished: false });
        return resp([{ id, person_id: params[0], activity_type_id: params[1], product_batch_id: params[2], started_at: new Date() }]);
      }
      // finish: loadOwnedOpenEvent
      if (/FROM v3\.events e LEFT JOIN v3\.activity_types at/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0]); if (!e) return resp([]);
        return resp([{ id: e.id, person_id: e.person, cowork_with: null, product_batch_id: null, ended_at: e.ended_at, deleted_at: null, is_long_running: false, cowork_group_id: null, slug: e.slug, requires_order_count: true, product_id: null, target_bottles: null }]);
      }
      if (/COUNT\(\*\)::int AS n FROM v3\.events WHERE cowork_group_id/.test(s)) return resp([{ n: 1 }]);
      if (/UPDATE v3\.events SET ended_at = NOW\(\), closed_reason = 'operator_page'/.test(s)) { const e = mem.events.find((x) => x.id === params[0]); if (e) e.ended_at = new Date(); return resp([]); }
      return resp([]);
    } };
  }
  beforeEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    const ph = opAuth.hashPin('1234');
    mem = {
      persons: [{ id: 4, display_name: 'Vitor', role: 'operator', pin_hash: ph.pin_hash, pin_salt: ph.pin_salt, is_sandbox: false }],
      sessions: [], events: [], counts: [],
      acts: [
        { id: 20, slug: 'order_printing', requires_product: false, is_background: false, requires_order_count: true },
        { id: 21, slug: 'clinic_shipment', requires_product: false, is_background: false, requires_order_count: true },
      ],
    };
    const app = express();
    app.use('/', createOpRouter({ db: makeDb(mem), slack: { postAs: () => {} }, operatorToken: TOKEN, adminChannelId: 'C_ADMIN' }));
    server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });
  async function login() { const r = await fetch(base + '/api/v3/op/auth/login', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1234' }) }); return (await r.json()).session_token; }
  async function start(tok, body) { const r = await fetch(base + '/api/v3/op/event/start', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'X-Session-Token': tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j }; }
  async function end(tok, id, body) { const r = await fetch(base + '/api/v3/op/event/' + id + '/end', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'X-Session-Token': tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j }; }

  test('1º abre SEM quantidade → 400 orders_printed_required', async () => {
    const tok = await login();
    expect((await start(tok, { activity_slug: 'order_printing' })).body.error).toBe('orders_printed_required');
  });
  test('1º abre COM quantidade → grava production_counts kind=orders no START', async () => {
    const tok = await login();
    const r = await start(tok, { activity_slug: 'order_printing', orders_printed: 206 });
    expect(r.body.ok).toBe(true);
    expect(mem.counts).toHaveLength(1);
    expect(mem.counts[0]).toMatchObject({ orders: 206, kind: 'orders' });
  });
  test('joiner (slug já aberto) NÃO precisa de quantidade e NÃO conta de novo', async () => {
    const tok = await login();
    await start(tok, { activity_slug: 'order_printing', orders_printed: 206 }); // 1º abre
    const r2 = await start(tok, { activity_slug: 'order_printing' }); // joiner, sem qty
    expect(r2.body.ok).toBe(true);
    expect(r2.body.error).toBeUndefined();
    expect(mem.counts).toHaveLength(1); // continua 1 — não dobrou
  });
  test('FIM da impressão de ordens NÃO pede mais quantas empacotadas', async () => {
    const tok = await login();
    const a = await start(tok, { activity_slug: 'order_printing', orders_printed: 206 });
    const r = await end(tok, a.body.event.id, {}); // sem orders_count, sem exceção
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(mem.counts).toHaveLength(1); // só a do START; o fim não escreve nada
  });
  test('Envio Clínica = igual impressão: quantidade OBRIGATÓRIA no START, métrica kind=clinic', async () => {
    const tok = await login();
    // sem quantidade no começo → 400 (obrigatório, igual impressão de ordens)
    const bad = await start(tok, { activity_slug: 'clinic_shipment' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('orders_printed_required');
    // com quantidade no começo → grava kind='clinic' NO START (não no fim)
    const a = await start(tok, { activity_slug: 'clinic_shipment', orders_printed: 5 });
    expect(a.body.ok).toBe(true);
    expect(mem.counts).toHaveLength(1);
    expect(mem.counts[0]).toMatchObject({ orders: 5, kind: 'clinic' });
  });
  test('Envio Clínica: FIM não pede nem conta de novo (já contou no START)', async () => {
    const tok = await login();
    const a = await start(tok, { activity_slug: 'clinic_shipment', orders_printed: 5 });
    const r = await end(tok, a.body.event.id, {}); // sem qty no fim
    expect(r.status).toBe(200);
    expect(mem.counts).toHaveLength(1); // só a do START
  });
});
