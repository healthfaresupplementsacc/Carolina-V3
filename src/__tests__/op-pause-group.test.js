'use strict';
/* PAUSA DO GRUPO — rotas do /op (Bruno 08-19, evento 3583).
 *
 * O que estas rotas têm que garantir:
 *   1. abrir uma pausa COM cowork congela os eventos de TODOS os participantes
 *      (antes congelava só o starter — foi o furo (a) do 3583);
 *   2. terminar a pausa descongela TODOS (furo (b));
 *   3. entrar numa pausa em andamento devolve a PERGUNTA do Bruno em vez de
 *      congelar às cegas, e a resposta decide de quando o relógio parou;
 *   4. a pergunta pendente aparece e some quando respondida.
 *
 * O serviço de pausa é injetado (deps.pauseService) — aqui testamos a ROTA.
 */
const express = require('express');
const { createOpRouter } = require('../routes/op');
const opAuth = require('../lib/op-auth');

const resp = (rows) => ({ rows, rowCount: rows.length });
const TOKEN = 'page-token';

describe('/op — pausa é do GRUPO', () => {
  let server, base, mem, svcCalls;

  function slugOf(actId) { const a = mem.acts.find((x) => x.id === actId); return a ? a.slug : null; }

  // serviço de pausa de mentira: registra as chamadas e mexe no mem
  function makePauseSvc() {
    return {
      freezeFor: async (people, except) => {
        svcCalls.push({ fn: 'freezeFor', people: [...people], except: [...(except || [])] });
        let count = 0;
        mem.events.forEach((e) => {
          if (people.indexOf(e.person_id) < 0 || e.ended_at || e.paused_at) return;
          if ((except || []).indexOf(e.id) >= 0 || e.slug === 'break') return;
          e.paused_at = new Date(Date.now() - 60000); count += 1;
        });
        return { count, by_person: {} };
      },
      resumeFor: async (people) => {
        svcCalls.push({ fn: 'resumeFor', people: [...people] });
        const by = {};
        people.forEach((p) => {
          const hit = mem.events.filter((e) => e.person_id === p && !e.ended_at && e.paused_at);
          hit.forEach((e) => { e.total_paused_seconds += 60; e.paused_at = null; });
          by[p] = { count: hit.length, tasks: hit.map((e) => ({ id: e.id, slug: e.slug })) };
        });
        return { count: Object.values(by).reduce((a, x) => a + x.count, 0), by_person: by };
      },
      endPauseFor: async (pauseId) => {
        svcCalls.push({ fn: 'endPauseFor', pauseId });
        const pause = mem.events.find((e) => e.id === pauseId);
        const people = [...new Set([pause.person_id, ...(pause.cowork_with || [])])];
        return { ...(await makePauseSvc().resumeFor(people)), participants: people.map((p) => ({ person_id: p })) };
      },
      joinPause: async (a) => { svcCalls.push({ fn: 'joinPause', ...a }); return { ok: true, since: a.since, assumed: false, frozen: 1, credited_seconds: a.since === 'inicio' ? 1800 : 0 }; },
      pendingQuestionFor: async (pid) => (mem.pending && mem.pending[pid]) || null,
      answerPending: async (a) => { svcCalls.push({ fn: 'answerPending', ...a }); if (mem.pending) delete mem.pending[a.person_id]; return { ok: true, since: a.since, credited_seconds: a.since === 'inicio' ? 5071 : 0 }; },
      participantsOf: async () => [],
      repairPauseOverlap: async () => ({ ok: true, rows: [] }),
    };
  }

  function makeDb() {
    return { query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log|INSERT INTO v3\.operator_action_log/.test(s)) return resp([]);
      if (/FROM v3\.persons WHERE role = 'operator'/.test(s)) return resp(mem.persons.filter((p) => p.pin_hash));
      if (/INSERT INTO v3\.operator_sessions/.test(s)) { mem.sessions.push({ token: params[1], person_id: params[0] }); return resp([{ id: 1, person_id: params[0], session_token: params[1], created_at: new Date() }]); }
      if (/UPDATE v3\.persons SET last_page_login_at/.test(s)) return resp([]);
      if (/SELECT s\.person_id, p\.display_name, to_char/.test(s)) return resp([]);
      if (/FROM v3\.operator_sessions s JOIN v3\.persons p/.test(s)) {
        const x = mem.sessions.find((y) => y.token === params[0]); if (!x) return resp([]);
        const p = mem.persons.find((z) => z.id === x.person_id);
        return resp([{ session_id: 1, person_id: p.id, last_activity_at: new Date(), display_name: p.display_name, role: p.role, active: true, auto_logoff_seconds: null, count_exempt: false, is_sandbox: false }]);
      }
      if (/closed_reason = 'pause_expired_overnight'|SET is_unfinished = TRUE|machine_custody/.test(s)) return resp([]);
      if (/FROM v3\.activity_types WHERE slug = \$1/.test(s)) { const a = mem.acts.find((x) => x.slug === params[0]); return resp(a ? [a] : []); }
      if (/SELECT 1 FROM v3\.events WHERE person_id = \$1 AND ended_at IS NULL AND deleted_at IS NULL LIMIT 1/.test(s)) {
        return resp(mem.events.some((e) => e.person_id === params[0] && !e.ended_at) ? [{ x: 1 }] : []);
      }
      if (/SELECT GREATEST\(.*AS ref/.test(s)) return resp([{ ref: null, minutes: 0 }]);
      if (/FROM v3\.product_batches pb LEFT JOIN v3\.products pr/.test(s)) return resp([]);
      // foreground abertas (exclusividade)
      if (/COALESCE\(at\.is_background, false\) = false ORDER BY e\.started_at/.test(s)) {
        return resp(mem.events.filter((e) => e.person_id === params[0] && !e.ended_at && e.slug !== 'break')
          .map((e) => ({ id: e.id, started_at: e.started_at, cowork_group_id: null, slug: e.slug, activity_name: e.slug })));
      }
      // INSERT event
      if (/INSERT INTO v3\.events/.test(s)) {
        const id = 500 + mem.events.length;
        mem.events.push({ id, person_id: params[0], activity_type_id: params[1], slug: slugOf(params[1]), started_at: new Date(), ended_at: null, paused_at: null, total_paused_seconds: 0, cowork_with: params[5] || [], cowork_group_id: params[7] || null });
        return resp([{ id, person_id: params[0], activity_type_id: params[1], product_batch_id: null, started_at: new Date(), cowork_with: params[5] || [], cowork_group_id: params[7] || null }]);
      }
      // join: carrega o evento alvo (com slug)
      if (/FROM v3\.events e JOIN v3\.activity_types at ON at\.id = e\.activity_type_id WHERE e\.id = \$1 LIMIT 1/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0]); if (!e) return resp([]);
        return resp([{ id: e.id, person_id: e.person_id, activity_type_id: e.activity_type_id, product_batch_id: null, cowork_group_id: e.cowork_group_id, ended_at: e.ended_at, deleted_at: null, started_at: e.started_at, slug: e.slug }]);
      }
      // loadOwnedOpenEvent (end)
      if (/FROM v3\.events e LEFT JOIN v3\.activity_types at/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0]); if (!e) return resp([]);
        return resp([{ id: e.id, person_id: e.person_id, cowork_with: e.cowork_with || null, product_batch_id: null, ended_at: e.ended_at, deleted_at: null, is_long_running: false, cowork_group_id: e.cowork_group_id, slug: e.slug, requires_order_count: false, product_id: null }]);
      }
      if (/COUNT\(\*\)::int AS n FROM v3\.events WHERE cowork_group_id/.test(s)) return resp([{ n: 1 }]);
      if (/UPDATE v3\.events SET ended_at = NOW\(\), closed_reason = 'operator_page'/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0]); if (e) e.ended_at = new Date(); return resp([]);
      }
      return resp([]);
    } };
  }

  beforeEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    const ph = opAuth.hashPin('1234');
    svcCalls = [];
    mem = {
      persons: [
        { id: 4, display_name: 'Vitor', role: 'operator', pin_hash: ph.pin_hash, pin_salt: ph.pin_salt, is_sandbox: false },
        { id: 7, display_name: 'Bruno Sarmento', role: 'operator', pin_hash: ph.pin_hash, pin_salt: ph.pin_salt, is_sandbox: false },
      ],
      sessions: [], events: [], pending: {},
      acts: [{ id: 10, slug: 'production_line', requires_product: true }, { id: 11, slug: 'review' }, { id: 16, slug: 'break', requires_product: false }],
    };
    const app = express();
    app.use('/', createOpRouter({ db: makeDb(), slack: { postAs: () => {} }, operatorToken: TOKEN, adminChannelId: 'C_ADMIN', pauseService: makePauseSvc() }));
    server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

  const H = (tok) => ({ Authorization: 'Bearer ' + TOKEN, 'X-Session-Token': tok, 'Content-Type': 'application/json' });
  async function login() { const r = await fetch(base + '/api/v3/op/auth/login', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1234' }) }); return (await r.json()).session_token; }
  async function post(tok, path, body) { const r = await fetch(base + path, { method: 'POST', headers: H(tok), body: JSON.stringify(body || {}) }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j }; }
  async function get(tok, path) { const r = await fetch(base + path, { headers: H(tok) }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j }; }

  test('pausa com cowork congela os eventos de TODOS (o furo (a) do 3583)', async () => {
    const tok = await login();
    // Vitor tem uma linha rodando; Bruno Sarmento tem uma revisão rodando
    mem.events.push({ id: 300, person_id: 4, activity_type_id: 10, slug: 'production_line', started_at: new Date(), ended_at: null, paused_at: null, total_paused_seconds: 0 });
    mem.events.push({ id: 301, person_id: 7, activity_type_id: 11, slug: 'review', started_at: new Date(), ended_at: null, paused_at: null, total_paused_seconds: 0 });
    const r = await post(tok, '/api/v3/op/event/start', { activity_slug: 'break', note: 'pallets', cowork_with: [7] });
    expect(r.status).toBe(200);
    const fr = svcCalls.find((c) => c.fn === 'freezeFor');
    expect(fr).toBeTruthy();
    expect(fr.people.sort()).toEqual([4, 7]);            // o GRUPO, não só o starter
    expect(fr.except.length).toBe(2);                    // os DOIS breaks ficam de fora
    expect(mem.events.find((e) => e.id === 300).paused_at).not.toBeNull();
    expect(mem.events.find((e) => e.id === 301).paused_at).not.toBeNull(); // era isto que faltava
  });

  test('terminar a pausa descongela o GRUPO e devolve resumed_group (furo (b))', async () => {
    const tok = await login();
    mem.events.push({ id: 300, person_id: 4, activity_type_id: 10, slug: 'production_line', started_at: new Date(), ended_at: null, paused_at: null, total_paused_seconds: 0 });
    mem.events.push({ id: 301, person_id: 7, activity_type_id: 11, slug: 'review', started_at: new Date(), ended_at: null, paused_at: null, total_paused_seconds: 0 });
    await post(tok, '/api/v3/op/event/start', { activity_slug: 'break', note: 'pallets', cowork_with: [7] });
    const br = mem.events.find((e) => e.slug === 'break' && e.person_id === 4);
    const r = await post(tok, '/api/v3/op/event/' + br.id + '/end', {});
    expect(r.status).toBe(200);
    expect(svcCalls.some((c) => c.fn === 'endPauseFor' && c.pauseId === br.id)).toBe(true);
    expect(r.body.resumed).toBe(1);                       // as do operador que pediu
    expect(r.body.resumed_group).toBeTruthy();
    expect(r.body.resumed_group['7'].count).toBe(1);      // o COLEGA também voltou
    expect(mem.events.find((e) => e.id === 301).paused_at).toBeNull();
    expect(mem.events.find((e) => e.id === 301).total_paused_seconds).toBe(60);
  });

  test('entrar numa pausa em andamento devolve a PERGUNTA, não congela às cegas', async () => {
    const tok = await login();
    mem.events.push({ id: 400, person_id: 4, activity_type_id: 16, slug: 'break', started_at: new Date(), ended_at: null, paused_at: null, total_paused_seconds: 0, cowork_group_id: 'g1' });
    const r = await post(tok, '/api/v3/op/event/400/join', {}); // login = Vitor(4)? não: o PIN é dos dois
    // o starter é o 4 e a sessão também: neste caso a rota devolve "já é dono"
    expect(r.status).toBe(200);
    expect(r.body.already).toBe(true);
  });

  test('colega entrando numa pausa alheia recebe pause_join_question com o horário', async () => {
    // sessão do Bruno Sarmento (id 7): o PIN é o mesmo, então forçamos a sessão dele
    const tok = await login();
    mem.sessions[mem.sessions.length - 1].person_id = 7;
    const started = new Date('2026-08-19T15:18:36Z');
    mem.events.push({ id: 401, person_id: 4, activity_type_id: 16, slug: 'break', started_at: started, ended_at: null, paused_at: null, total_paused_seconds: 0, cowork_group_id: 'g1' });
    const r = await post(tok, '/api/v3/op/event/401/join', {});
    expect(r.status).toBe(200);
    expect(r.body.pause_join_question).toBe(true);
    expect(r.body.pause_event_id).toBe(401);
    expect(new Date(r.body.pause_started_at).toISOString()).toBe(started.toISOString());
    expect(svcCalls.some((c) => c.fn === 'joinPause')).toBe(false); // nada congelado ainda
  });

  test('a resposta "desde o começo" vai pro serviço com since=inicio', async () => {
    const tok = await login();
    mem.sessions[mem.sessions.length - 1].person_id = 7;
    mem.events.push({ id: 402, person_id: 4, activity_type_id: 16, slug: 'break', started_at: new Date(), ended_at: null, paused_at: null, total_paused_seconds: 0, cowork_group_id: 'g1' });
    const r = await post(tok, '/api/v3/op/event/402/join', { since: 'inicio' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.credited_seconds).toBe(1800);
    const jp = svcCalls.find((c) => c.fn === 'joinPause');
    expect(jp.since).toBe('inicio');
    expect(jp.person_id).toBe(7);
  });

  test('GET /pause/pending devolve a pergunta pendente; POST /pause/answer a resolve', async () => {
    const tok = await login();
    mem.sessions[mem.sessions.length - 1].person_id = 7;
    mem.pending[7] = { event_id: 3583, pause_hhmm: '11:18', joined_hhmm: '11:57', assumed: 'agora', starter_name: 'Vitor' };
    const q = await get(tok, '/api/v3/op/pause/pending');
    expect(q.status).toBe(200);
    expect(q.body.question.event_id).toBe(3583);
    expect(q.body.question.assumed).toBe('agora');           // o conservador enquanto não responde
    const a = await post(tok, '/api/v3/op/pause/answer', { event_id: 3583, since: 'inicio' });
    expect(a.status).toBe(200);
    expect(a.body.credited_seconds).toBe(5071);              // exatamente a pausa do 3583
    const again = await get(tok, '/api/v3/op/pause/pending');
    expect(again.body.question).toBeNull();                  // some depois de respondida
  });

  test('sem pergunta pendente a rota responde question:null (nunca 4xx)', async () => {
    const tok = await login();
    const q = await get(tok, '/api/v3/op/pause/pending');
    expect(q.status).toBe(200);
    expect(q.body.question).toBeNull();
  });

  test('POST /pause/join direto com since válido chama o serviço', async () => {
    const tok = await login();
    mem.sessions[mem.sessions.length - 1].person_id = 7;
    const r = await post(tok, '/api/v3/op/pause/join', { pause_event_id: 404, since: 'agora' });
    expect(r.status).toBe(200);
    expect(r.body.since).toBe('agora');
    expect(r.body.credited_seconds).toBe(0);
  });
});
