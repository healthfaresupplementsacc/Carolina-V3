'use strict';
/* HEALTHFARE V3 — tests behavioral da Operator Page API (Deploy 2).
   HTTP real (Express + listen + fetch). Fake-db com estado em memória. */
const express = require('express');
const { createOpRouter } = require('../routes/op');
const opAuth = require('../lib/op-auth');

const PAGE_TOKEN = 'p'.repeat(64);
const ADMIN_PIN = '510510';

// PINs FIXTURE de teste (hasheados com scrypt, mesmo caminho do prod).
// Propositalmente DIFERENTES dos PINs reais — o repo não revela prod.
const PINS = { 4: '1111', 5: '2222', 6: '3333', 7: '4444' };

function makeMem() {
  const persons = [
    { id: 4, display_name: 'Vitor', role: 'operator', active: true, deleted_at: null, auto_logoff_seconds: 30, count_exempt: false },
    { id: 5, display_name: 'Simone', role: 'operator', active: true, deleted_at: null, auto_logoff_seconds: 30, count_exempt: false },
    { id: 6, display_name: 'Ana', role: 'operator', active: true, deleted_at: null, auto_logoff_seconds: null, count_exempt: false },
    { id: 7, display_name: 'Bruno Sarmento', role: 'operator', active: true, deleted_at: null, auto_logoff_seconds: 30, count_exempt: true },
    { id: 1, display_name: 'Bruno Camp', role: 'owner', active: true, deleted_at: null, auto_logoff_seconds: 30, count_exempt: false },
  ];
  for (const p of persons) {
    if (PINS[p.id]) Object.assign(p, opAuth.hashPin(PINS[p.id]));
  }
  return {
    persons,
    activities: [
      { id: 5, slug: 'production_line', requires_product: true, active: true },
      { id: 3, slug: 'encapsulation', requires_product: true, active: true },
      { id: 10, slug: 'cleaning', requires_product: false, active: true },
      { id: 17, slug: 'lunch', requires_product: false, active: true },
      { id: 16, slug: 'break', requires_product: false, active: true },
    ],
    batches: [
      { id: 39, batch_number: 'BR-2026-0190', product_id: 1, product: 'Magnesium Glycinate' },
      { id: 44, batch_number: '0200', product_id: 3, product: 'Berberine' },
    ],
    sessions: [], events: [], counts: [], notes: [], notifications: [], audits: [],
    seq: { session: 1, event: 100, note: 1, notif: 1 },
  };
}

function makeFakeDb(mem) {
  const resp = (rows) => ({ rows, rowCount: rows.length });
  return {
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();

      if (/INSERT INTO v3\.audit_log/.test(s)) {
        mem.audits.push({ person_id: params[0], action: params[1], target_type: params[2], target_id: params[3], metadata: JSON.parse(params[4]) });
        return resp([]);
      }
      // ── op-auth ──
      if (/INSERT INTO v3\.operator_sessions/.test(s)) {
        const row = { id: mem.seq.session++, person_id: params[0], session_token: params[1], ip_address: params[2], user_agent: params[3], created_at: new Date(), last_activity_at: new Date(), logged_out_at: null, logoff_reason: null };
        mem.sessions.push(row);
        return resp([{ id: row.id, person_id: row.person_id, session_token: row.session_token, created_at: row.created_at }]);
      }
      if (/FROM v3\.operator_sessions s JOIN v3\.persons p ON p\.id = s\.person_id WHERE s\.session_token/.test(s)) {
        const sess = mem.sessions.find((x) => x.session_token === params[0] && !x.logged_out_at);
        if (!sess) return resp([]);
        const p = mem.persons.find((x) => x.id === sess.person_id);
        return resp([{ session_id: sess.id, person_id: p.id, last_activity_at: sess.last_activity_at, display_name: p.display_name, role: p.role, active: p.active, auto_logoff_seconds: p.auto_logoff_seconds, count_exempt: p.count_exempt }]);
      }
      if (/UPDATE v3\.operator_sessions SET last_activity_at/.test(s)) {
        const sess = mem.sessions.find((x) => x.session_token === params[0] && !x.logged_out_at);
        if (!sess) return resp([]);
        sess.last_activity_at = new Date();
        return resp([{ id: sess.id, person_id: sess.person_id }]);
      }
      if (/UPDATE v3\.operator_sessions SET logged_out_at = NOW\(\)/.test(s)) {
        const sess = mem.sessions.find((x) => x.session_token === params[0] && !x.logged_out_at);
        if (!sess) return resp([]);
        sess.logged_out_at = new Date(); sess.logoff_reason = params[1];
        return resp([{ id: sess.id, person_id: sess.person_id }]);
      }
      if (/COUNT\(\*\)::int AS n FROM v3\.operator_sessions s JOIN v3\.persons p/.test(s)) {
        const n = mem.sessions.filter((x) => !x.logged_out_at && x.id !== params[0]
          && (mem.persons.find((p) => p.id === x.person_id) || {}).role === 'operator').length;
        return resp([{ n }]);
      }
      // ── persons ──
      if (/FROM v3\.persons WHERE role = 'operator' AND active = true AND deleted_at IS NULL AND pin_hash IS NOT NULL/.test(s)) {
        return resp(mem.persons.filter((p) => p.role === 'operator' && p.active && !p.deleted_at && p.pin_hash));
      }
      if (/UPDATE v3\.persons SET last_page_login_at/.test(s)) return resp([]);
      if (/SELECT id, display_name, auto_logoff_seconds FROM v3\.persons WHERE id/.test(s)) {
        const p = mem.persons.find((x) => x.id === params[0]);
        return resp(p ? [{ id: p.id, display_name: p.display_name, auto_logoff_seconds: p.auto_logoff_seconds }] : []);
      }
      if (/UPDATE v3\.persons SET auto_logoff_seconds/.test(s)) {
        const p = mem.persons.find((x) => x.id === params[0]);
        if (!p) return resp([]);
        p.auto_logoff_seconds = params[1];
        return resp([{ id: p.id, display_name: p.display_name, auto_logoff_seconds: p.auto_logoff_seconds }]);
      }
      // ── domínio ──
      if (/FROM v3\.activity_types WHERE slug = \$1/.test(s)) {
        return resp(mem.activities.filter((a) => a.slug === params[0] && a.active));
      }
      if (/FROM v3\.product_batches pb LEFT JOIN v3\.products pr/.test(s)) {
        const bn = params[0];
        const b = mem.batches.find((x) => x.batch_number === bn || x.batch_number === 'BR-2026-' + bn);
        return resp(b ? [b] : []);
      }
      if (/INSERT INTO v3\.events/.test(s)) {
        const ev = {
          id: mem.seq.event++, person_id: params[0], activity_type_id: params[1],
          product_batch_id: params[2], started_at: new Date(), ended_at: null,
          description: params[3], cowork_with: params[4] || [], confidence: 'high',
          source: 'operator_page', deleted_at: null, is_long_running: false, closed_reason: null,
        };
        mem.events.push(ev);
        return resp([{ id: ev.id, person_id: ev.person_id, activity_type_id: ev.activity_type_id, product_batch_id: ev.product_batch_id, started_at: ev.started_at, cowork_with: ev.cowork_with }]);
      }
      if (/SELECT e\.id, e\.person_id, e\.cowork_with, e\.product_batch_id, e\.ended_at, e\.deleted_at/.test(s)) {
        const ev = mem.events.find((x) => x.id === params[0]);
        if (!ev) return resp([]);
        const act = mem.activities.find((a) => a.id === ev.activity_type_id) || {};
        const b = mem.batches.find((x) => x.id === ev.product_batch_id) || {};
        return resp([{ ...ev, slug: act.slug, product_id: b.product_id || null }]);
      }
      if (/UPDATE v3\.events SET ended_at = NOW\(\), closed_reason = 'operator_page'/.test(s)) {
        const ev = mem.events.find((x) => x.id === params[0]);
        if (ev) { ev.ended_at = new Date(); ev.closed_reason = 'operator_page'; if (params[1]) ev.description = (ev.description || '') + ' | fim: ' + params[1]; }
        return resp([]);
      }
      if (/UPDATE v3\.events SET cowork_with = array_append/.test(s)) {
        const ev = mem.events.find((x) => x.id === params[0] && !x.deleted_at && !x.ended_at
          && x.person_id !== params[1] && !(x.cowork_with || []).includes(params[1]));
        if (!ev) return resp([]);
        ev.cowork_with = [...(ev.cowork_with || []), params[1]];
        return resp([{ id: ev.id, person_id: ev.person_id, cowork_with: ev.cowork_with }]);
      }
      if (/SELECT id, ended_at, person_id, cowork_with FROM v3\.events WHERE id/.test(s)) {
        const ev = mem.events.find((x) => x.id === params[0] && !x.deleted_at);
        return resp(ev ? [ev] : []);
      }
      if (/UPDATE v3\.events SET ended_at = NOW\(\), closed_reason = 'clock_out'/.test(s)) {
        const closed = mem.events.filter((x) => x.person_id === params[0] && !x.ended_at && !x.deleted_at && !x.is_long_running);
        closed.forEach((x) => { x.ended_at = new Date(); x.closed_reason = 'clock_out'; });
        return resp(closed.map((x) => ({ id: x.id })));
      }
      if (/SELECT e\.id, e\.product_batch_id, pb\.product_id FROM v3\.events e/.test(s)) {
        const ev = mem.events.find((x) => x.id === params[0] && !x.deleted_at);
        if (!ev) return resp([]);
        const b = mem.batches.find((x) => x.id === ev.product_batch_id) || {};
        return resp([{ id: ev.id, product_batch_id: ev.product_batch_id, product_id: b.product_id || null }]);
      }
      if (/INSERT INTO v3\.production_counts/.test(s)) {
        mem.counts.push({ product_id: params[0], product_batch_id: params[1], bottles: params[2], reported_by: params[3], source_event_id: params[4], unit: params[5] });
        return resp([]);
      }
      if (/INSERT INTO v3\.op_notes/.test(s)) {
        const n = { id: mem.seq.note++, person_id: params[0], text: params[1] };
        mem.notes.push(n);
        return resp([{ id: n.id }]);
      }
      if (/LEFT JOIN LATERAL/.test(s)) { // active-operators
        return resp(mem.persons.filter((p) => p.role === 'operator' && p.active).map((p) => {
          const ce = mem.events.find((e) => e.person_id === p.id && !e.ended_at && !e.deleted_at && !e.is_long_running);
          const act = ce ? (mem.activities.find((a) => a.id === ce.activity_type_id) || {}) : {};
          const b = ce ? (mem.batches.find((x) => x.id === ce.product_batch_id) || {}) : {};
          return {
            id: p.id, display_name: p.display_name,
            online: mem.sessions.some((sx) => sx.person_id === p.id && !sx.logged_out_at),
            current_event_id: ce ? ce.id : null, current_slug: act.slug || null,
            current_batch: b.batch_number || null, current_started_at: ce ? ce.started_at : null,
            current_cowork: ce ? ce.cowork_with : null,
          };
        }));
      }
      if (/slug IN \('production_line', 'encapsulation'\)/.test(s)) { // missingCounts
        const rows = mem.events.filter((e) => {
          const act = mem.activities.find((a) => a.id === e.activity_type_id) || {};
          return ['production_line', 'encapsulation'].includes(act.slug) && e.ended_at && !e.deleted_at
            && !mem.counts.some((cc) => cc.source_event_id === e.id);
        }).map((e) => {
          const p = mem.persons.find((x) => x.id === e.person_id) || {};
          const act = mem.activities.find((a) => a.id === e.activity_type_id) || {};
          const b = mem.batches.find((x) => x.id === e.product_batch_id) || {};
          return { event_id: e.id, display_name: p.display_name, slug: act.slug, batch_number: b.batch_number || null, product: b.product || null, finalized_at_edt: '01:00 PM' };
        });
        return resp(rows);
      }
      if (/INSERT INTO v3\.notifications/.test(s)) {
        const n = { id: mem.seq.notif++, type: 'unfilled_bottle_count', payload: JSON.parse(params[0]), status: 'pending' };
        mem.notifications.push(n);
        return resp([{ id: n.id }]);
      }
      return resp([]);
    }),
  };
}

let server, base, mem, db, slack;
const url = (p) => base + p;
async function post(path, { body, session, noPageToken } = {}) {
  const headers = {};
  if (!noPageToken) headers.Authorization = 'Bearer ' + PAGE_TOKEN;
  if (session) headers['X-Session-Token'] = session;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(url(path), { method: 'POST', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
async function get(path, { session, headers = {} } = {}) {
  const h = { Authorization: 'Bearer ' + PAGE_TOKEN, ...headers };
  if (session) h['X-Session-Token'] = session;
  const r = await fetch(url(path), { headers: h });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
async function login(personId) {
  const r = await post('/api/v3/op/auth/login', { body: { pin: PINS[personId] } });
  expect(r.status).toBe(200);
  return r.body.session_token;
}

beforeEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  mem = makeMem();
  db = makeFakeDb(mem);
  slack = { postAs: jest.fn(async () => ({ ts: 'x' })) };
  const app = express();
  app.use('/', createOpRouter({ db, operatorToken: PAGE_TOKEN, adminPin: ADMIN_PIN, slack, adminChannelId: 'C_ADMIN' }));
  server = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

// ─── auth ────────────────────────────────────────────────────
describe('op API — auth', () => {
  test('sem page token → 401', async () => {
    const r = await post('/api/v3/op/auth/login', { body: { pin: PINS[4] }, noPageToken: true });
    expect(r.status).toBe(401);
  });

  test('login PIN correto → session + person + auto_logoff', async () => {
    const r = await post('/api/v3/op/auth/login', { body: { pin: PINS[4] } });
    expect(r.status).toBe(200);
    expect(r.body.session_token).toHaveLength(96);
    expect(r.body.person).toEqual({ id: 4, display_name: 'Vitor', role: 'operator', count_exempt: false });
    expect(r.body.auto_logoff_seconds).toBe(30);
  });

  test('login PIN errado → 401; formato ruim → 400', async () => {
    expect((await post('/api/v3/op/auth/login', { body: { pin: '0000' } })).status).toBe(401);
    expect((await post('/api/v3/op/auth/login', { body: { pin: '12' } })).status).toBe(400);
    expect((await post('/api/v3/op/auth/login', { body: {} })).status).toBe(400);
  });

  test('rate-limit login: 6ª tentativa no minuto → 429', async () => {
    for (let i = 0; i < 5; i++) await post('/api/v3/op/auth/login', { body: { pin: '0000' } });
    const r = await post('/api/v3/op/auth/login', { body: { pin: PINS[4] } });
    expect(r.status).toBe(429);
  });

  test('heartbeat com sessão → ok; sem → 401', async () => {
    const s = await login(4);
    expect((await post('/api/v3/op/auth/heartbeat', { session: s })).status).toBe(200);
    expect((await post('/api/v3/op/auth/heartbeat', { session: 'nope' })).status).toBe(401);
  });

  test('logout idempotente', async () => {
    const s = await login(4);
    const r1 = await post('/api/v3/op/auth/logout', { session: s });
    expect(r1.body.closed).toBe(true);
    const r2 = await post('/api/v3/op/auth/logout', { session: s });
    expect(r2.body.closed).toBe(false);
    expect(mem.sessions[0].logoff_reason).toBe('manual');
  });

  test('logout auto_timeout grava reason', async () => {
    const s = await login(4);
    await post('/api/v3/op/auth/logout', { session: s, body: { reason: 'auto_timeout' } });
    expect(mem.sessions[0].logoff_reason).toBe('auto_timeout');
  });
});

// ─── events ──────────────────────────────────────────────────
describe('op API — events', () => {
  test('start cleaning sem batch → event source=operator_page + audit operator_page', async () => {
    const s = await login(4);
    const r = await post('/api/v3/op/event/start', { session: s, body: { activity_slug: 'cleaning' } });
    expect(r.status).toBe(200);
    expect(r.body.event.slug).toBe('cleaning');
    expect(mem.events[0].source).toBe('operator_page');
    expect(mem.audits.some((a) => a.action === 'event.created_via_page')).toBe(true);
  });

  test('start production_line com batch "0190" resolve BR-2026-0190', async () => {
    const s = await login(4);
    const r = await post('/api/v3/op/event/start', { session: s, body: { activity_slug: 'production_line', batch_number: '0190' } });
    expect(r.status).toBe(200);
    expect(r.body.event.batch_number).toBe('BR-2026-0190');
    expect(mem.events[0].product_batch_id).toBe(39);
  });

  test('start: batch inexistente → 400; slug inválido → 400; sem sessão → 401', async () => {
    const s = await login(4);
    expect((await post('/api/v3/op/event/start', { session: s, body: { activity_slug: 'production_line', batch_number: '9999' } })).status).toBe(400);
    expect((await post('/api/v3/op/event/start', { session: s, body: { activity_slug: 'voar' } })).status).toBe(400);
    expect((await post('/api/v3/op/event/start', { body: { activity_slug: 'cleaning' } })).status).toBe(401);
  });

  test('start break SEM nota → 400 note_required; COM nota → 200 (regra Pausa)', async () => {
    const s = await login(4);
    const r1 = await post('/api/v3/op/event/start', { session: s, body: { activity_slug: 'break' } });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe('note_required');
    const r2 = await post('/api/v3/op/event/start', { session: s, body: { activity_slug: 'break', note: '  ' } });
    expect(r2.status).toBe(400);
    const r3 = await post('/api/v3/op/event/start', { session: s, body: { activity_slug: 'break', note: 'água/banheiro' } });
    expect(r3.status).toBe(200);
  });

  test('start com cowork_with (cowork A) — remove self da lista', async () => {
    const s = await login(4);
    const r = await post('/api/v3/op/event/start', { session: s, body: { activity_slug: 'cleaning', cowork_with: [6, 4, 7] } });
    expect(r.status).toBe(200);
    expect(mem.events[0].cowork_with).toEqual([6, 7]);
  });

  test('end própria com bottles → fecha + cria production_count linkado', async () => {
    const s = await login(4);
    const st = await post('/api/v3/op/event/start', { session: s, body: { activity_slug: 'production_line', batch_number: '0190' } });
    const id = st.body.event.id;
    const r = await post(`/api/v3/op/event/${id}/end`, { session: s, body: { bottles: 746 } });
    expect(r.status).toBe(200);
    expect(r.body.count_created).toBe(true);
    expect(mem.events[0].ended_at).toBeTruthy();
    expect(mem.counts[0]).toMatchObject({ bottles: 746, source_event_id: id, product_batch_id: 39, unit: 'bottle' });
  });

  test('end de event de OUTRO → 403; já fechada → 409; cowork member PODE fechar', async () => {
    const sv = await login(4);
    const st = await post('/api/v3/op/event/start', { session: sv, body: { activity_slug: 'cleaning', cowork_with: [6] } });
    const id = st.body.event.id;
    const ss = await login(5); // Simone não é dona nem cowork
    expect((await post(`/api/v3/op/event/${id}/end`, { session: ss, body: {} })).status).toBe(403);
    const sa = await login(6); // Ana é cowork → pode
    expect((await post(`/api/v3/op/event/${id}/end`, { session: sa, body: {} })).status).toBe(200);
    expect((await post(`/api/v3/op/event/${id}/end`, { session: sv, body: {} })).status).toBe(409);
  });

  test('join (cowork B) → adiciona; repetido → already; fechada → 409', async () => {
    const sv = await login(4);
    const st = await post('/api/v3/op/event/start', { session: sv, body: { activity_slug: 'cleaning' } });
    const id = st.body.event.id;
    const sa = await login(6);
    const r1 = await post(`/api/v3/op/event/${id}/join`, { session: sa, body: {} });
    expect(r1.status).toBe(200);
    expect(r1.body.cowork_with).toEqual([6]);
    const r2 = await post(`/api/v3/op/event/${id}/join`, { session: sa, body: {} });
    expect(r2.body.already).toBe(true);
    await post(`/api/v3/op/event/${id}/end`, { session: sv, body: {} });
    const r3 = await post(`/api/v3/op/event/${id}/join`, { session: sa, body: {} });
    expect(r3.status).toBe(409);
  });

  test('note → op_notes; vazia → 400', async () => {
    const s = await login(5);
    const r = await post('/api/v3/op/note', { session: s, body: { text: 'faltou label matte' } });
    expect(r.status).toBe(200);
    expect(mem.notes[0].text).toBe('faltou label matte');
    expect((await post('/api/v3/op/note', { session: s, body: { text: '  ' } })).status).toBe(400);
  });

  test('active-operators → shape com current task', async () => {
    const s = await login(4);
    await post('/api/v3/op/event/start', { session: s, body: { activity_slug: 'production_line', batch_number: '0190' } });
    const r = await get('/api/v3/op/active-operators', { session: s });
    expect(r.status).toBe(200);
    const vitor = r.body.operators.find((o) => o.id === 4);
    expect(vitor.online).toBe(true);
    expect(vitor.current_slug).toBe('production_line');
    expect(vitor.current_batch).toBe('BR-2026-0190');
  });
});

// ─── clock-out (P5) ──────────────────────────────────────────
describe('op API — clock-out P5', () => {
  async function mkFinishedProduction(session, batch) {
    const st = await post('/api/v3/op/event/start', { session, body: { activity_slug: 'production_line', batch_number: batch } });
    const id = st.body.event.id;
    // fecha SEM bottles direto na mem (simula F sem count)
    mem.events.find((e) => e.id === id).ended_at = new Date();
    return id;
  }

  test('missing-bottle-counts: can_skip=true quando há OUTRO operador logado', async () => {
    const sv = await login(4);
    await login(5); // Simone também logada
    await mkFinishedProduction(sv, '0190');
    const r = await get('/api/v3/op/missing-bottle-counts', { session: sv });
    expect(r.status).toBe(200);
    expect(r.body.missing).toHaveLength(1);
    expect(r.body.is_last_operator).toBe(false);
    expect(r.body.can_skip).toBe(true);
  });

  test('último operador não-exempt: is_last=true, can_skip=false', async () => {
    const sv = await login(4);
    await mkFinishedProduction(sv, '0190');
    const r = await get('/api/v3/op/missing-bottle-counts', { session: sv });
    expect(r.body.is_last_operator).toBe(true);
    expect(r.body.can_skip).toBe(false);
  });

  test('Bruno Sarmento (count_exempt) pode pular MESMO sendo último', async () => {
    const sb = await login(7);
    await mkFinishedProduction(sb, '0190');
    const r = await get('/api/v3/op/missing-bottle-counts', { session: sb });
    expect(r.body.is_last_operator).toBe(true);
    expect(r.body.can_skip).toBe(true);
    const co = await post('/api/v3/op/clock-out', { session: sb, body: { counts: [], unknown_event_ids: [] } });
    expect(co.status).toBe(200);
  });

  test('último não-exempt saindo com buraco sem "não sei" → 422 com missing', async () => {
    const sv = await login(4);
    await mkFinishedProduction(sv, '0190');
    const r = await post('/api/v3/op/clock-out', { session: sv, body: { counts: [], unknown_event_ids: [] } });
    expect(r.status).toBe(422);
    expect(r.body.missing).toHaveLength(1);
    // sessão NÃO foi fechada (pode corrigir e tentar de novo)
    expect(mem.sessions.find((x) => !x.logged_out_at)).toBeTruthy();
  });

  test('clock-out com counts → production_counts criados + sai', async () => {
    const sv = await login(4);
    const evId = await mkFinishedProduction(sv, '0190');
    const r = await post('/api/v3/op/clock-out', { session: sv, body: { counts: [{ event_id: evId, bottles: 788 }], unknown_event_ids: [] } });
    expect(r.status).toBe(200);
    expect(mem.counts[0]).toMatchObject({ bottles: 788, source_event_id: evId });
    expect(mem.sessions[0].logoff_reason).toBe('clock_out');
  });

  test('clock-out "não sei" → notification + Carolina avisa admin (top-level, sender.name)', async () => {
    const sv = await login(4);
    const evId = await mkFinishedProduction(sv, '0190');
    const r = await post('/api/v3/op/clock-out', { session: sv, body: { counts: [], unknown_event_ids: [evId] } });
    expect(r.status).toBe(200);
    expect(r.body.unknown_notified).toBe(1);
    expect(mem.notifications[0]).toMatchObject({ type: 'unfilled_bottle_count', status: 'pending' });
    expect(slack.postAs).toHaveBeenCalledTimes(1);
    const call = slack.postAs.mock.calls[0][0];
    expect(call.channel).toBe('C_ADMIN');
    expect(call.sender).toEqual({ name: 'Carolina' });
    expect(call.thread_ts).toBeNull();
    expect(call.text).toContain('Magnesium Glycinate');
  });

  test('clock-out fecha as tasks ABERTAS do operador (long_running fica)', async () => {
    const sv = await login(4);
    await post('/api/v3/op/event/start', { session: sv, body: { activity_slug: 'cleaning' } });
    const st2 = await post('/api/v3/op/event/start', { session: sv, body: { activity_slug: 'cleaning' } });
    mem.events.find((e) => e.id === st2.body.event.id).is_long_running = true;
    const r = await post('/api/v3/op/clock-out', { session: sv, body: { counts: [], unknown_event_ids: [] } });
    expect(r.status).toBe(200);
    expect(r.body.closed_events).toHaveLength(1);
    expect(mem.events.find((e) => e.is_long_running).ended_at).toBeNull();
  });
});

// ─── admin auto-logoff ───────────────────────────────────────
describe('op API — admin auto-logoff', () => {
  const put = async (id, seconds, pin) => {
    const r = await fetch(url(`/api/admin/operator/${id}/auto-logoff`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(pin ? { 'x-admin-pin': pin } : {}) },
      body: JSON.stringify({ seconds }),
    });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  };

  test('sem PIN → 401; PIN errado → 401', async () => {
    expect((await put(4, 60, null)).status).toBe(401);
    expect((await put(4, 60, '000000')).status).toBe(401);
  });

  test('GET com PIN → row', async () => {
    const r = await fetch(url('/api/admin/operator/4/auto-logoff'), { headers: { 'x-admin-pin': ADMIN_PIN } });
    expect(r.status).toBe(200);
    expect((await r.json()).auto_logoff_seconds).toBe(30);
  });

  test('PUT 120 → atualiza; PUT null → desativa; inválido → 400; inexistente → 404', async () => {
    expect((await put(4, 120, ADMIN_PIN)).body.auto_logoff_seconds).toBe(120);
    expect((await put(4, null, ADMIN_PIN)).body.auto_logoff_seconds).toBeNull();
    expect((await put(4, 2, ADMIN_PIN)).status).toBe(400);
    expect((await put(99, 60, ADMIN_PIN)).status).toBe(404);
  });
});
