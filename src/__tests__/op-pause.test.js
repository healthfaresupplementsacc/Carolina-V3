'use strict';
/* FASE PAUSA — pausa congela TODOS os processos ativos do operador; voltar
   descongela e desconta o tempo. Nota obrigatória no break. */
const express = require('express');
const { createOpRouter } = require('../routes/op');
const opAuth = require('../lib/op-auth');

const resp = (rows) => ({ rows, rowCount: rows.length });
const TOKEN = 'page-token';

describe('FASE PAUSA — congela / retoma', () => {
  let server, base, mem;
  function slugOf(actId) { const a = mem.acts.find((x) => x.id === actId); return a ? a.slug : null; }
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
      // expireOvernightPauses (login) — sem eventos de ontem nestes testes
      if (/closed_reason = 'pause_expired_overnight'/.test(s)) return resp([]);
      if (/SET is_unfinished = TRUE/.test(s)) return resp([]);
      if (/FROM v3\.activity_types WHERE slug = \$1/.test(s)) { const a = mem.acts.find((x) => x.slug === params[0]); return resp(a ? [a] : []); }
      // detectGap: tem task aberta? (1ª query) → sem gap se aberta
      if (/SELECT 1 FROM v3\.events WHERE person_id = \$1 AND ended_at IS NULL AND deleted_at IS NULL LIMIT 1/.test(s)) {
        return resp(mem.events.some((e) => e.person === params[0] && !e.ended_at) ? [{ x: 1 }] : []);
      }
      if (/SELECT GREATEST\(.*AS ref/.test(s)) return resp([{ ref: null, minutes: 0 }]); // sem gap (1º login)
      if (/FROM v3\.product_batches pb LEFT JOIN v3\.products pr/.test(s)) return resp([]);
      // INSERT event (solo)
      if (/INSERT INTO v3\.events/.test(s)) {
        const id = 500 + mem.events.length;
        mem.events.push({ id, person: params[0], activity: params[1], slug: slugOf(params[1]), started_at: new Date(), ended_at: null, paused_at: null, total_paused_seconds: 0 });
        return resp([{ id, person_id: params[0], activity_type_id: params[1], product_batch_id: params[2], started_at: new Date() }]);
      }
      // loadOwnedOpenEvent
      if (/FROM v3\.events e LEFT JOIN v3\.activity_types at/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0]); if (!e) return resp([]);
        return resp([{ id: e.id, person_id: e.person, cowork_with: null, product_batch_id: null, ended_at: e.ended_at, deleted_at: null, is_long_running: false, cowork_group_id: null, slug: e.slug, requires_order_count: false, product_id: null }]);
      }
      // cowork count (não usado — solo)
      if (/COUNT\(\*\)::int AS n FROM v3\.events WHERE cowork_group_id/.test(s)) return resp([{ n: 1 }]);
      // end UPDATE
      if (/UPDATE v3\.events SET ended_at = NOW\(\), closed_reason = 'operator_page'/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0]); if (e) e.ended_at = new Date(); return resp([]);
      }
      // ── src/v3/pause/service.js (Bruno 08-19: a pausa é do GRUPO) ──
      // getPause: o evento de 'break' em si
      if (/WHERE e\.id = \$1 AND e\.deleted_at IS NULL AND at\.slug = ANY/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0] && x.slug === 'break');
        return resp(e ? [{ id: e.id, person_id: e.person, started_at: e.started_at || new Date(), ended_at: e.ended_at, cowork_group_id: e.cowork_group_id || null, cowork_with: e.cowork_with || [], description: null, is_test: false, slug: 'break' }] : []);
      }
      // participantsOf: breaks do mesmo grupo (aqui sempre solo → sem grupo)
      if (/WHERE e\.cowork_group_id = \$1 AND e\.deleted_at IS NULL AND at\.slug = ANY/.test(s)) return resp([]);
      // FASE PAUSA freeze (agora por pessoa, com crédito retroativo em $4)
      if (/UPDATE v3\.events SET paused_at = NOW\(\)/.test(s)) {
        const [pid, except, , add] = params; const out = [];
        mem.events.forEach((e) => {
          if (e.person !== pid || e.ended_at || e.paused_at || e.slug === 'break') return;
          if ((except || []).indexOf(e.id) >= 0) return;
          e.paused_at = new Date(Date.now() - 60000); e.total_paused_seconds += (add || 0); out.push({ id: e.id });
        });
        return resp(out);
      }
      // FASE PAUSA resume
      if (/SET total_paused_seconds = total_paused_seconds \+/.test(s)) {
        const pid = params[0]; const out = [];
        mem.events.forEach((e) => { if (e.person === pid && !e.ended_at && e.paused_at) { e.total_paused_seconds += 60; e.paused_at = null; out.push({ id: e.id }); } });
        return resp(out);
      }
      // describeTasks (o "continuar ou finalizar?" de cada um)
      if (/AS needs_count FROM v3\.events e JOIN v3\.activity_types at/.test(s)) {
        return resp(mem.events.filter((e) => (params[0] || []).indexOf(e.id) >= 0)
          .map((e) => ({ id: e.id, person_id: e.person, slug: e.slug, label: e.slug, batch_number: null, product: null, needs_count: false })));
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
      acts: [{ id: 10, slug: 'production_line', requires_product: true }, { id: 16, slug: 'break', requires_product: false }],
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

  test('break sem nota → 400 note_required', async () => {
    const tok = await login();
    expect((await start(tok, { activity_slug: 'break' })).body.error).toBe('note_required');
  });
  test('iniciar PAUSA congela os processos ativos (paused_at setado)', async () => {
    const tok = await login();
    const prod = await start(tok, { activity_slug: 'production_line' });
    const prodId = prod.body.event.id;
    expect(mem.events.find((e) => e.id === prodId).paused_at).toBe(null); // rodando
    await start(tok, { activity_slug: 'break', note: 'almoço' });
    expect(mem.events.find((e) => e.id === prodId).paused_at).not.toBe(null); // CONGELADO
    const br = mem.events.find((e) => e.slug === 'break');
    expect(br.paused_at).toBe(null); // a própria pausa não se congela
  });
  test('terminar a PAUSA descongela e acumula total_paused_seconds', async () => {
    const tok = await login();
    const prod = await start(tok, { activity_slug: 'production_line' });
    const prodId = prod.body.event.id;
    await start(tok, { activity_slug: 'break', note: 'café' });
    const br = mem.events.find((e) => e.slug === 'break');
    const r = await end(tok, br.id, {});
    expect(r.status).toBe(200);
    expect(r.body.resumed).toBe(1); // 1 processo retomado
    const p = mem.events.find((e) => e.id === prodId);
    expect(p.paused_at).toBe(null); // voltou a rodar
    expect(p.total_paused_seconds).toBeGreaterThan(0); // tempo pausado descontado
  });
});
