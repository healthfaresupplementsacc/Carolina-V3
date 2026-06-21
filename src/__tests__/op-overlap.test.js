'use strict';
/* FASE OVERLAP + ALMOÇO (regra Bruno) — exclusividade de tasks de foreground.
   • almoço PARA (fecha) o trabalho de foreground; máquina/background segue.
   • durante o almoço, não pode começar foreground (precisa encerrar o almoço).
   • duas foreground (slug diferente) ao mesmo tempo → confirma (close | both).
   • background (encapsulação etc.) nunca conflita.
   Mesmo padrão do gap: ok:true + flag, nunca 4xx. */
const express = require('express');
const { createOpRouter } = require('../routes/op');
const opAuth = require('../lib/op-auth');

const resp = (rows) => ({ rows, rowCount: rows.length });
const TOKEN = 'page-token';

describe('FASE OVERLAP + ALMOÇO — exclusividade de foreground', () => {
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
      if (/FROM v3\.activity_types WHERE slug = \$1/.test(s)) { const a = mem.acts.find((x) => x.slug === params[0]); return resp(a ? [a] : []); }
      // detectGap: tem task aberta?
      if (/SELECT 1 FROM v3\.events WHERE person_id = \$1 AND ended_at IS NULL AND deleted_at IS NULL LIMIT 1/.test(s)) {
        return resp(mem.events.some((e) => e.person === params[0] && !e.ended_at) ? [{ x: 1 }] : []);
      }
      if (/SELECT GREATEST\(.*AS ref/.test(s)) return resp([{ ref: null, minutes: 0 }]); // sem gap
      // ── openFg (a NOVA query do guard de exclusividade) ──
      if (/AS activity_name FROM v3\.events e JOIN v3\.activity_types at/.test(s) && /COALESCE\(at\.is_background, false\) = false/.test(s)) {
        const pid = params[0];
        const rows = mem.events.filter((e) => e.person === pid && !e.ended_at && !e.deleted_at && !e.is_unfinished && !bgOf(e.activity))
          .map((e) => ({ id: e.id, started_at: e.started_at || new Date(), slug: slugOf(e.activity), activity_name: slugOf(e.activity) }));
        return resp(rows);
      }
      // fechar tasks (lunch_started / closed_for_new_task) — ANY(int[])
      if (/UPDATE v3\.events SET ended_at = NOW\(\), closed_reason = '(lunch_started|closed_for_new_task)'/.test(s)) {
        const ids = params[0] || []; mem.events.forEach((e) => { if (ids.includes(e.id)) e.ended_at = new Date(); }); return resp([]);
      }
      // encerrar almoço pra trabalhar — id único
      if (/closed_reason = 'lunch_ended_to_work'/.test(s)) {
        const id = params[0]; const e = mem.events.find((x) => x.id === id); if (e) e.ended_at = new Date(); return resp([]);
      }
      if (/FROM v3\.product_batches pb LEFT JOIN v3\.products pr/.test(s)) return resp([]);
      // INSERT event (solo)
      if (/INSERT INTO v3\.events/.test(s)) {
        const id = 500 + mem.events.length;
        mem.events.push({ id, person: params[0], activity: params[1], slug: slugOf(params[1]), started_at: new Date(), ended_at: null, deleted_at: null, is_unfinished: false });
        return resp([{ id, person_id: params[0], activity_type_id: params[1], product_batch_id: params[2], started_at: new Date() }]);
      }
      return resp([]);
    } };
  }
  beforeEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    const ph = opAuth.hashPin('1234');
    mem = {
      persons: [{ id: 4, display_name: 'Vitor', role: 'operator', pin_hash: ph.pin_hash, pin_salt: ph.pin_salt, is_sandbox: false }],
      sessions: [], events: [],
      acts: [
        { id: 10, slug: 'production_line', requires_product: false, is_background: false },
        { id: 11, slug: 'cleaning', requires_product: false, is_background: false },
        { id: 12, slug: 'lunch', requires_product: false, is_background: false },
        { id: 13, slug: 'encapsulation', requires_product: false, is_background: true },
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
  const openCount = () => mem.events.filter((e) => !e.ended_at).length;

  test('2 foreground (slug diferente) → concurrent_open (não cria, pede confirmação)', async () => {
    const tok = await login();
    await start(tok, { activity_slug: 'production_line' });
    const r = await start(tok, { activity_slug: 'cleaning' });
    expect(r.body.concurrent_open).toBe(true);
    expect(r.body.open_tasks[0].slug).toBe('production_line');
    expect(mem.events.filter((e) => e.slug === 'cleaning').length).toBe(0); // não criou ainda
  });
  test('concurrent_ack=close fecha a anterior e cria a nova', async () => {
    const tok = await login();
    const a = await start(tok, { activity_slug: 'production_line' });
    await start(tok, { activity_slug: 'cleaning', concurrent_ack: 'close' });
    expect(mem.events.find((e) => e.id === a.body.event.id).ended_at).not.toBe(null); // anterior fechada
    expect(openCount()).toBe(1); // só a nova aberta
    expect(mem.events.find((e) => e.slug === 'cleaning' && !e.ended_at)).toBeTruthy();
  });
  test('concurrent_ack=both deixa as duas abertas', async () => {
    const tok = await login();
    await start(tok, { activity_slug: 'production_line' });
    await start(tok, { activity_slug: 'cleaning', concurrent_ack: 'both' });
    expect(openCount()).toBe(2);
  });
  test('começar almoço FECHA o trabalho de foreground ativo', async () => {
    const tok = await login();
    const prod = await start(tok, { activity_slug: 'production_line' });
    await start(tok, { activity_slug: 'lunch' });
    expect(mem.events.find((e) => e.id === prod.body.event.id).ended_at).not.toBe(null); // produção parada
    expect(mem.events.find((e) => e.slug === 'lunch' && !e.ended_at)).toBeTruthy(); // almoço aberto
  });
  test('com almoço aberto, começar foreground → lunch_active (bloqueia)', async () => {
    const tok = await login();
    await start(tok, { activity_slug: 'lunch' });
    const r = await start(tok, { activity_slug: 'production_line' });
    expect(r.body.lunch_active).toBe(true);
    expect(mem.events.filter((e) => e.slug === 'production_line').length).toBe(0); // não criou
  });
  test('concurrent_ack=end_lunch encerra o almoço e começa a tarefa', async () => {
    const tok = await login();
    const lunch = await start(tok, { activity_slug: 'lunch' });
    await start(tok, { activity_slug: 'production_line', concurrent_ack: 'end_lunch' });
    expect(mem.events.find((e) => e.id === lunch.body.event.id).ended_at).not.toBe(null); // almoço encerrado
    expect(mem.events.find((e) => e.slug === 'production_line' && !e.ended_at)).toBeTruthy();
  });
  test('background (encapsulação) NÃO conflita com foreground aberto', async () => {
    const tok = await login();
    await start(tok, { activity_slug: 'production_line' });
    const r = await start(tok, { activity_slug: 'encapsulation' });
    expect(r.body.concurrent_open).toBeFalsy();
    expect(r.body.lunch_active).toBeFalsy();
    expect(openCount()).toBe(2); // foreground + background coexistem
  });
});
