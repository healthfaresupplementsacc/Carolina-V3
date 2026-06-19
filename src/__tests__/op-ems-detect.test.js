'use strict';
/* FASE FORM — detecção passiva: /ems/my-activity (sugestão) + /ems/register-detected
   (1 toque cria event com tempo do TOQUE). REGRA #0: sugestão, nunca obrigação. */
const express = require('express');
const { createOpRouter } = require('../routes/op');
const opAuth = require('../lib/op-auth');

const resp = (rows) => ({ rows, rowCount: rows.length });
const TOKEN = 'page-token';

describe('FASE FORM — detecção passiva EMS', () => {
  let server, base, mem;
  function makeDb(mem) {
    return { query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) { mem.audits.push({ action: params[1] }); return resp([]); }
      if (/INSERT INTO v3\.operator_action_log/.test(s)) { mem.actionLogs.push({ type: params[2] }); return resp([]); }
      if (/FROM v3\.persons WHERE role = 'operator'/.test(s)) return resp(mem.persons.filter((p) => p.pin_hash));
      if (/INSERT INTO v3\.operator_sessions/.test(s)) { mem.sessions.push({ token: params[1], person_id: params[0] }); return resp([{ id: 1, person_id: params[0], session_token: params[1], created_at: new Date() }]); }
      if (/UPDATE v3\.persons SET last_page_login_at/.test(s)) return resp([]);
      if (/SELECT s\.person_id, p\.display_name, to_char/.test(s)) return resp([]); // detect forgotten
      if (/FROM v3\.operator_sessions s JOIN v3\.persons p/.test(s)) {
        const x = mem.sessions.find((y) => y.token === params[0]); if (!x) return resp([]);
        const p = mem.persons.find((z) => z.id === x.person_id);
        return resp([{ session_id: 1, person_id: p.id, last_activity_at: new Date(), display_name: p.display_name, role: p.role, active: true, auto_logoff_seconds: null, count_exempt: false }]);
      }
      // detectedForPerson: cache do EMS
      if (/FROM v3\.ems_activity_cache WHERE tracker_person_id/.test(s)) {
        return resp(mem.cache.filter((c) => c.tracker_person_id === params[0] && c.sync_status === 'active' && c.machine));
      }
      // open-event check (já registrou esse lote?)
      if (/SELECT 1 FROM v3\.events e LEFT JOIN v3\.product_batches pb/.test(s)) {
        return resp(mem.openBatches.includes(params[1]) ? [{ x: 1 }] : []);
      }
      if (/SELECT id, canonical_name, aliases FROM v3\.products WHERE active = true/.test(s)) return resp(mem.products);
      if (/FROM v3\.activity_types WHERE slug = \$1 AND active = true/.test(s)) {
        const a = mem.acts.find((x) => x.slug === params[0]); return resp(a ? [a] : []);
      }
      if (/FROM v3\.product_batches pb LEFT JOIN v3\.products pr/.test(s)) {
        const b = mem.batches.find((x) => x.batch_number === params[0]); return resp(b ? [b] : []);
      }
      if (/INSERT INTO v3\.product_batches/.test(s)) { const id = 900 + mem.batches.length; mem.batches.push({ id, batch_number: params[1], product_id: params[0] }); return resp([{ id, batch_number: params[1], product_id: params[0] }]); }
      if (/INSERT INTO v3\.events/.test(s)) {
        mem.events.push({ person: params[0], activity: params[1], batch: params[2], source: 'ems_passive_detect', started_at_param: params[5] || null });
        return resp([{ id: 4242, person_id: params[0], activity_type_id: params[1], product_batch_id: params[2], started_at: params[5] || new Date() }]);
      }
      return resp([]);
    } };
  }
  beforeEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    const ph = opAuth.hashPin('1234');
    mem = {
      persons: [{ id: 4, display_name: 'Vitor', role: 'operator', pin_hash: ph.pin_hash, pin_salt: ph.pin_salt }],
      sessions: [], audits: [], actionLogs: [], events: [], openBatches: [],
      acts: [{ id: 30, slug: 'encapsulation', requires_product: true }, { id: 10, slug: 'production_line', requires_product: true }],
      products: [{ id: 5, canonical_name: 'Glutathione 1000mg', aliases: [] }],
      batches: [{ id: 77, batch_number: 'BR-2026-0223', product_id: 5, product: 'Glutathione 1000mg' }],
      cache: [{ ems_key: 'eq1:b1', tracker_person_id: 4, sync_status: 'active', machine: 'NJP1200', machine_type: 'capsule_machine', stage: 'encapsulating', process_type: 'encapsulation', supplement_name: 'Glutathione 1000mg', batch_number: 'BR-2026-0223', formula_code: 'FRM-30', product_image: null, started_at: new Date() }],
    };
    const app = express();
    app.use('/', createOpRouter({ db: makeDb(mem), slack: { postAs: () => {} }, operatorToken: TOKEN, adminChannelId: 'C_ADMIN' }));
    server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });
  async function login() { const r = await fetch(base + '/api/v3/op/auth/login', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1234' }) }); return (await r.json()).session_token; }
  async function get(p, tok) { const r = await fetch(base + p, { headers: { Authorization: 'Bearer ' + TOKEN, 'X-Session-Token': tok } }); return { status: r.status, body: await r.json() }; }
  async function post(p, tok, body) { const r = await fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'X-Session-Token': tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j }; }

  test('my-activity → sugere a atividade que o EMS mostra (máquina + lote + stage→slug)', async () => {
    const tok = await login();
    const r = await get('/api/v3/op/ems/my-activity', tok);
    expect(r.status).toBe(200);
    expect(r.body.detected).toMatchObject({ ems_key: 'eq1:b1', machine: 'NJP1200', slug: 'encapsulation', batch_number: 'BR-2026-0223', product_name: 'Glutathione 1000mg' });
  });
  test('Parte 1: detected traz nome AMIGÁVEL da máquina (sem modelo técnico)', async () => {
    const tok = await login();
    const r = await get('/api/v3/op/ems/my-activity', tok);
    expect(r.body.detected.machine_label).toBe('máquina de cápsula'); // capsule_machine → PT humano
  });
  test('Parte 2: register-detected com started_at PASSADO usa essa hora', async () => {
    const tok = await login();
    const past = new Date(Date.now() - 90 * 60000).toISOString(); // 1h30 atrás
    const r = await post('/api/v3/op/ems/register-detected', tok, { ems_key: 'eq1:b1', started_at: past });
    expect(r.status).toBe(200);
    expect(mem.events[0].started_at_param).toBe(past); // hora do toque escolhida, não NOW
    expect(r.body.late_flag).toBe(false); // < 8h → sem flag
  });
  test('Parte 2: register-detected com started_at FUTURO → 400', async () => {
    const tok = await login();
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const r = await post('/api/v3/op/ems/register-detected', tok, { ems_key: 'eq1:b1', started_at: future });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('started_at_future');
  });
  test('Parte 2: started_at >8h atrás → aceita mas late_flag=true (admin avisado)', async () => {
    const tok = await login();
    const old = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
    const r = await post('/api/v3/op/ems/register-detected', tok, { ems_key: 'eq1:b1', started_at: old });
    expect(r.status).toBe(200);
    expect(r.body.late_flag).toBe(true);
  });
  test('my-activity → null se já tem event aberto pro mesmo lote (não sugere de novo)', async () => {
    mem.openBatches = ['BR-2026-0223'];
    const tok = await login();
    expect((await get('/api/v3/op/ems/my-activity', tok)).body.detected).toBe(null);
  });
  test('register-detected (1 toque) → cria event source=ems_passive_detect + action_log', async () => {
    const tok = await login();
    const r = await post('/api/v3/op/ems/register-detected', tok, { ems_key: 'eq1:b1' });
    expect(r.status).toBe(200);
    expect(r.body.event.id).toBe(4242);
    expect(r.body.event.slug).toBe('encapsulation');
    expect(mem.events[0].source).toBe('ems_passive_detect');
    expect(mem.actionLogs.some((a) => a.type === 'task_start_ems_detect')).toBe(true);
  });
  test('register-detected com ems_key que o EMS não mostra mais → 409 not_detected (anti-fantasma)', async () => {
    const tok = await login();
    const r = await post('/api/v3/op/ems/register-detected', tok, { ems_key: 'ghost:999' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('not_detected');
  });
  test('register-detected sem ems_key → 400', async () => {
    const tok = await login();
    expect((await post('/api/v3/op/ems/register-detected', tok, {})).body.error).toBe('ems_key_required');
  });
  test('máquina sem operador atribuído (fila) NÃO vira sugestão (card só p/ máquina)', async () => {
    mem.cache = [{ ems_key: 'b2:weighing', tracker_person_id: 4, sync_status: 'active', machine: null, stage: 'weighing', batch_number: 'BR-2026-0218', started_at: new Date() }];
    const tok = await login();
    expect((await get('/api/v3/op/ems/my-activity', tok)).body.detected).toBe(null);
  });
});
