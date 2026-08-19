'use strict';
/* PAUSA (Bruno 08-19, evento 3583) — o serviço único de pausa.
 *
 * O bug: Vitor abriu um break 11:18:36 → 12:43:07 (5071s) com o Bruno Sarmento no
 * cowork. O evento do Vitor congelou certo (total_paused_seconds = 5071). Os do
 * Bruno Sarmento (#3575 revisão 09:50:06 → 13:05:19, #3576) ficaram com 0.
 *
 * Aqui: freeze/resume multi-pessoa, a matemática de 'inicio' vs 'agora', a
 * pergunta pendente, e o reparo (dry-run + apply) com a forma REAL do 3583.
 */
const { createPauseService, SINCE, isSince } = require('../v3/pause/service');

const resp = (rows) => ({ rows, rowCount: rows.length });
const S = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// ── banco de mentira: guarda eventos em memória e responde às queries do serviço ──
function makeDb(mem) {
  const slugOf = (actId) => (mem.acts.find((a) => a.id === actId) || {}).slug || null;
  const isPause = (e) => slugOf(e.activity_type_id) === 'break';
  return {
    calls: [],
    query: async function (sql, params = []) {
      const s = S(sql);
      this.calls.push(s);

      // getPause
      if (/FROM v3\.events e JOIN v3\.activity_types at ON at\.id = e\.activity_type_id WHERE e\.id = \$1 AND e\.deleted_at IS NULL AND at\.slug = ANY/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0] && !x.deleted_at && isPause(x));
        return resp(e ? [{ ...e, slug: 'break' }] : []);
      }
      // participantsOf: eventos de pausa do grupo
      if (/WHERE e\.cowork_group_id = \$1 AND e\.deleted_at IS NULL AND at\.slug = ANY/.test(s)) {
        return resp(mem.events.filter((x) => x.cowork_group_id === params[0] && !x.deleted_at && isPause(x))
          .map((x) => ({ pause_event_id: x.id, person_id: x.person_id, joined_since: x.joined_since || null, joined_at: x.joined_at || null, join_assumed: !!x.join_assumed, started_at: x.started_at })));
      }
      // freezeFor
      if (/UPDATE v3\.events SET paused_at = NOW\(\), total_paused_seconds = total_paused_seconds \+ \$4/.test(s)) {
        const [pid, except, , add] = params;
        const hit = [];
        mem.events.forEach((e) => {
          if (e.person_id !== pid || e.ended_at || e.deleted_at || e.paused_at || e.is_unfinished) return;
          if ((except || []).indexOf(e.id) >= 0 || isPause(e)) return;
          e.paused_at = mem.now(); e.total_paused_seconds += (add || 0); hit.push({ id: e.id });
        });
        return resp(hit);
      }
      // resumeFor
      if (/SET total_paused_seconds = total_paused_seconds \+ GREATEST\(0, EXTRACT\(EPOCH FROM \(NOW\(\) - paused_at\)\)/.test(s)) {
        const pid = params[0]; const hit = [];
        mem.events.forEach((e) => {
          if (e.person_id !== pid || e.ended_at || e.deleted_at || !e.paused_at) return;
          e.total_paused_seconds += Math.max(0, Math.round((mem.now() - e.paused_at) / 1000));
          e.paused_at = null; hit.push({ id: e.id });
        });
        return resp(hit);
      }
      // describeTasks
      if (/AS needs_count FROM v3\.events e JOIN v3\.activity_types at/.test(s)) {
        return resp(mem.events.filter((e) => (params[0] || []).indexOf(e.id) >= 0)
          .map((e) => ({ id: e.id, person_id: e.person_id, slug: slugOf(e.activity_type_id), label: slugOf(e.activity_type_id), batch_number: null, product: null, needs_count: slugOf(e.activity_type_id) === 'production_line' })));
      }
      // joinPause: evento de pausa DESTA pessoa
      if (/WHERE e\.person_id = \$1 AND e\.deleted_at IS NULL AND at\.slug = ANY\(\$2::text\[\]\) AND \(e\.cowork_group_id = \$3::uuid OR e\.id = \$4\)/.test(s)) {
        const e = mem.events.find((x) => x.person_id === params[0] && !x.deleted_at && isPause(x)
          && (x.cowork_group_id === params[2] || x.id === params[3]));
        return resp(e ? [{ id: e.id, joined_since: e.joined_since || null, joined_at: e.joined_at || null, join_assumed: !!e.join_assumed }] : []);
      }
      // joinPause: INSERT do evento de pausa do joiner (clona o do starter)
      if (/INSERT INTO v3\.events .*source, is_test, joined_at, joined_since, join_assumed\) SELECT/.test(s)) {
        const src = mem.events.find((x) => x.id === params[1]);
        const id = mem.nextId();
        const ev = {
          id, person_id: params[0], activity_type_id: src.activity_type_id, product_batch_id: null,
          started_at: mem.now(), ended_at: null, deleted_at: null, paused_at: null,
          total_paused_seconds: 0, is_unfinished: false, cowork_group_id: src.cowork_group_id,
          cowork_with: [], joined_at: mem.now(), joined_since: params[2] || null, join_assumed: !!params[3],
        };
        mem.events.push(ev);
        return resp([{ id, joined_since: ev.joined_since, joined_at: ev.joined_at, join_assumed: ev.join_assumed }]);
      }
      // segundos desde o início da pausa até agora
      if (/SELECT GREATEST\(0, EXTRACT\(EPOCH FROM \(NOW\(\) - \$1::timestamptz\)\)::int\) AS secs/.test(s)) {
        return resp([{ secs: Math.max(0, Math.round((mem.now() - new Date(params[0])) / 1000)) }]);
      }
      // diferença entre dois instantes (answerPending)
      if (/SELECT GREATEST\(0, EXTRACT\(EPOCH FROM \(\$2::timestamptz - \$1::timestamptz\)\)::int\) AS secs/.test(s)) {
        return resp([{ secs: Math.max(0, Math.round((new Date(params[1]) - new Date(params[0])) / 1000)) }]);
      }
      // "já está congelado?"
      if (/SELECT 1 FROM v3\.events WHERE person_id = \$1 AND ended_at IS NULL AND deleted_at IS NULL AND paused_at IS NOT NULL AND id <> \$2 LIMIT 1/.test(s)) {
        return resp(mem.events.some((e) => e.person_id === params[0] && !e.ended_at && !e.deleted_at && e.paused_at && e.id !== params[1]) ? [{ x: 1 }] : []);
      }
      // correção do crédito quando já estava congelado
      if (/SET total_paused_seconds = total_paused_seconds \+ \$2::int, updated_at = NOW\(\) WHERE person_id = \$1 AND ended_at IS NULL AND deleted_at IS NULL AND paused_at IS NOT NULL AND id <> \$3 RETURNING id/.test(s)) {
        const hit = [];
        mem.events.forEach((e) => { if (e.person_id === params[0] && !e.ended_at && !e.deleted_at && e.paused_at && e.id !== params[2]) { e.total_paused_seconds += params[1]; hit.push({ id: e.id }); } });
        return resp(hit);
      }
      // answerPending: credita a JANELA CEGA por evento (interseção real).
      // NÃO exige paused_at: o 3583 respondeu com a pausa já fechada.
      if (/UPDATE v3\.events e SET total_paused_seconds = e\.total_paused_seconds \+ GREATEST/.test(s)) {
        const [pid, from, to, meId] = params;
        const A = new Date(from); const B = new Date(to); const hit = [];
        mem.events.forEach((e) => {
          if (e.person_id !== pid || e.deleted_at || e.id === meId || isPause(e)) return;
          const st = new Date(e.started_at); const en = e.ended_at ? new Date(e.ended_at) : mem.now();
          if (!(st < B && en > A)) return;
          e.total_paused_seconds += Math.max(0, Math.round((Math.min(+en, +B) - Math.max(+st, +A)) / 1000));
          hit.push({ id: e.id });
        });
        return resp(hit);
      }
      // grava a resposta
      if (/SET joined_since = \$2, joined_at = COALESCE\(joined_at, NOW\(\)\), join_assumed = \$3/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0]);
        if (e) { e.joined_since = params[1]; e.joined_at = e.joined_at || mem.now(); e.join_assumed = params[2]; }
        return resp([]);
      }
      if (/SET joined_since = \$2, join_assumed = FALSE/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0]);
        if (e) { e.joined_since = params[1]; e.join_assumed = false; }
        return resp([]);
      }
      // syncCoworkWith
      if (/SET cowork_with = array_append/.test(s)) return resp([]);
      // pendingQuestionFor (pausa PODE já ter terminado; só o dia de hoje)
      if (/AND e\.joined_since IS NULL AND e\.joined_at IS NOT NULL/.test(s)) {
        const day = (d) => new Date(d).toISOString().slice(0, 10);
        const me = mem.events.find((e) => e.person_id === params[0] && !e.deleted_at && isPause(e)
          && !e.joined_since && e.joined_at && day(e.started_at) === day(mem.now()));
        if (!me) return resp([]);
        const pe = mem.events.find((e) => e.cowork_group_id === me.cowork_group_id && isPause(e) && e.person_id !== me.person_id);
        const hh = (d) => (d ? new Date(d).toISOString().slice(11, 16) : null);
        return resp([{
          event_id: me.id, cowork_group_id: me.cowork_group_id, joined_at: me.joined_at,
          joined_hhmm: hh(me.joined_at), description: me.description || null,
          pause_event_id: pe ? pe.id : null, pause_started_at: pe ? pe.started_at : null,
          pause_hhmm: pe ? hh(pe.started_at) : null, starter_name: pe ? 'Vitor' : null,
        }]);
      }
      // answerPending: carrega o evento de pausa da pessoa
      if (/WHERE e\.id = \$1 AND e\.person_id = \$2 AND e\.deleted_at IS NULL AND at\.slug = ANY/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0] && x.person_id === params[1] && !x.deleted_at && isPause(x));
        return resp(e ? [{ id: e.id, person_id: e.person_id, started_at: e.started_at, joined_at: e.joined_at, joined_since: e.joined_since || null, cowork_group_id: e.cowork_group_id }] : []);
      }
      // answerPending: início da pausa do grupo
      if (/SELECT MIN\(e2\.started_at\) AS s FROM v3\.events e2/.test(s)) {
        const g = mem.events.filter((e) => e.cowork_group_id === params[0] && !e.deleted_at && isPause(e));
        return resp([{ s: g.length ? new Date(Math.min(...g.map((e) => +new Date(e.started_at)))) : null }]);
      }
      // repairPauseOverlap: janela
      if (/SELECT \$1::timestamptz AS s, COALESCE\(\$2::timestamptz, NOW\(\)\) AS e/.test(s)) {
        const a = new Date(params[0]); const b = params[1] ? new Date(params[1]) : mem.now();
        return resp([{ s: a, e: b, secs: Math.max(0, Math.round((b - a) / 1000)) }]);
      }
      // repairPauseOverlap: eventos sobrepostos
      if (/AS overlap_seconds FROM v3\.events e JOIN v3\.activity_types at/.test(s)) {
        const [ws, we, people, exceptIds] = params;
        const A = new Date(ws); const B = new Date(we);
        const out = mem.events.filter((e) => {
          if ((people || []).indexOf(e.person_id) < 0 || e.deleted_at) return false;
          if ((exceptIds || []).indexOf(e.id) >= 0 || isPause(e)) return false;
          const st = new Date(e.started_at); const en = e.ended_at ? new Date(e.ended_at) : mem.now();
          return st < B && en > A;
        }).map((e) => {
          const st = new Date(e.started_at); const en = e.ended_at ? new Date(e.ended_at) : mem.now();
          const ov = Math.max(0, Math.round((Math.min(+en, +B) - Math.max(+st, +A)) / 1000));
          return { event_id: e.id, person_id: e.person_id, person: (mem.names || {})[e.person_id] || null, slug: slugOf(e.activity_type_id), started_at: e.started_at, ended_at: e.ended_at, current_paused: e.total_paused_seconds, overlap_seconds: ov };
        });
        return resp(out);
      }
      // repair apply
      if (/SET total_paused_seconds = total_paused_seconds \+ \$2::int, updated_at = NOW\(\) WHERE id = \$1/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0]); if (e) e.total_paused_seconds += params[1];
        return resp([]);
      }
      return resp([]);
    },
  };
}

function makeMem(nowMs) {
  let seq = 600;
  return {
    events: [], names: {},
    acts: [{ id: 10, slug: 'production_line' }, { id: 11, slug: 'review' }, { id: 12, slug: 'special_task' }, { id: 16, slug: 'break' }],
    _now: nowMs || Date.now(),
    now() { return new Date(this._now); },
    tick(sec) { this._now += sec * 1000; },
    nextId() { return ++seq; },
  };
}

describe('pause/service — congela e descongela o GRUPO', () => {
  let mem, db, svc;
  beforeEach(() => {
    mem = makeMem(new Date('2026-08-19T15:18:36Z').getTime());
    db = makeDb(mem);
    svc = createPauseService({ db });
  });

  test('freezeFor congela os eventos de TODAS as pessoas, não só do starter', async () => {
    mem.events.push(
      { id: 1, person_id: 4, activity_type_id: 10, started_at: mem.now(), ended_at: null, deleted_at: null, paused_at: null, total_paused_seconds: 0, is_unfinished: false },
      { id: 2, person_id: 7, activity_type_id: 11, started_at: mem.now(), ended_at: null, deleted_at: null, paused_at: null, total_paused_seconds: 0, is_unfinished: false },
      { id: 3, person_id: 7, activity_type_id: 12, started_at: mem.now(), ended_at: null, deleted_at: null, paused_at: null, total_paused_seconds: 0, is_unfinished: false },
      { id: 9, person_id: 4, activity_type_id: 16, started_at: mem.now(), ended_at: null, deleted_at: null, paused_at: null, total_paused_seconds: 0, is_unfinished: false },
    );
    const r = await svc.freezeFor([4, 7], [9]);
    expect(r.count).toBe(3);                                  // 1 do Vitor + 2 do Bruno
    expect(mem.events.find((e) => e.id === 1).paused_at).not.toBeNull();
    expect(mem.events.find((e) => e.id === 2).paused_at).not.toBeNull(); // era ISTO que faltava
    expect(mem.events.find((e) => e.id === 3).paused_at).not.toBeNull();
    expect(mem.events.find((e) => e.id === 9).paused_at).toBeNull();     // a própria pausa não congela
  });

  test('freezeFor nunca congela o break de outra pessoa (pausa não congela pausa)', async () => {
    mem.events.push({ id: 20, person_id: 7, activity_type_id: 16, started_at: mem.now(), ended_at: null, deleted_at: null, paused_at: null, total_paused_seconds: 0, is_unfinished: false });
    const r = await svc.freezeFor([7], []);
    expect(r.count).toBe(0);
    expect(mem.events.find((e) => e.id === 20).paused_at).toBeNull();
  });

  test('resumeFor descongela TODA a gente e devolve as tarefas por pessoa', async () => {
    mem.events.push(
      { id: 1, person_id: 4, activity_type_id: 10, started_at: mem.now(), ended_at: null, deleted_at: null, paused_at: mem.now(), total_paused_seconds: 0, is_unfinished: false },
      { id: 2, person_id: 7, activity_type_id: 11, started_at: mem.now(), ended_at: null, deleted_at: null, paused_at: mem.now(), total_paused_seconds: 0, is_unfinished: false },
    );
    mem.tick(600); // 10 min de pausa
    const r = await svc.resumeFor([4, 7]);
    expect(r.count).toBe(2);
    expect(r.by_person[4].count).toBe(1);
    expect(r.by_person[7].count).toBe(1);                      // o COLEGA também volta
    expect(r.by_person[7].tasks.length).toBe(1);               // e recebe "continuar ou finalizar?"
    expect(mem.events.find((e) => e.id === 2).total_paused_seconds).toBe(600);
    expect(mem.events.find((e) => e.id === 2).paused_at).toBeNull();
  });

  test('endPauseFor descongela o grupo inteiro a partir do evento de pausa', async () => {
    const gid = 'g-1';
    mem.events.push(
      { id: 50, person_id: 4, activity_type_id: 16, started_at: mem.now(), ended_at: null, deleted_at: null, paused_at: null, total_paused_seconds: 0, is_unfinished: false, cowork_group_id: gid, cowork_with: [7] },
      { id: 51, person_id: 7, activity_type_id: 16, started_at: mem.now(), ended_at: null, deleted_at: null, paused_at: null, total_paused_seconds: 0, is_unfinished: false, cowork_group_id: gid, cowork_with: [4] },
      { id: 1, person_id: 4, activity_type_id: 10, started_at: mem.now(), ended_at: null, deleted_at: null, paused_at: mem.now(), total_paused_seconds: 0, is_unfinished: false },
      { id: 2, person_id: 7, activity_type_id: 11, started_at: mem.now(), ended_at: null, deleted_at: null, paused_at: mem.now(), total_paused_seconds: 0, is_unfinished: false },
    );
    mem.tick(300);
    const r = await svc.endPauseFor(50);
    expect(r.count).toBe(2);
    expect(r.participants.map((p) => p.person_id).sort()).toEqual([4, 7]);
    expect(mem.events.find((e) => e.id === 2).total_paused_seconds).toBe(300);
  });

  test('participantsOf junta o grupo E o cowork_with (quem o admin anexou sem evento)', async () => {
    const gid = 'g-2';
    mem.events.push(
      { id: 60, person_id: 4, activity_type_id: 16, started_at: mem.now(), ended_at: null, deleted_at: null, cowork_group_id: gid, cowork_with: [7, 9], total_paused_seconds: 0 },
    );
    const p = await svc.participantsOf(60);
    expect(p.map((x) => x.person_id).sort()).toEqual([4, 7, 9]);
    expect(p.find((x) => x.person_id === 4).is_starter).toBe(true);
    expect(p.find((x) => x.person_id === 9).pause_event_id).toBeNull(); // só no cowork_with
  });
});

describe('pause/service — "Você estava nisso desde o começo?"', () => {
  let mem, db, svc;
  const GID = 'g-3583';
  beforeEach(() => {
    mem = makeMem(new Date('2026-08-19T15:18:36Z').getTime()); // pausa começa
    db = makeDb(mem);
    svc = createPauseService({ db });
    mem.events.push(
      // pausa do Vitor (#3578 no mundo real)
      { id: 100, person_id: 4, activity_type_id: 16, started_at: mem.now(), ended_at: null, deleted_at: null, paused_at: null, total_paused_seconds: 0, is_unfinished: false, cowork_group_id: GID, cowork_with: [], description: 'Organizando estoque que chegaram pallets' },
      // revisão do Bruno Sarmento (#3575), já rodando há 1h28
      { id: 101, person_id: 7, activity_type_id: 11, started_at: new Date(mem._now - 5310 * 1000), ended_at: null, deleted_at: null, paused_at: null, total_paused_seconds: 0, is_unfinished: false },
    );
  });

  test("'agora' congela do instante da entrada e não credita nada", async () => {
    mem.tick(1800); // entrou 30 min depois do começo da pausa
    const r = await svc.joinPause({ pause_event_id: 100, person_id: 7, since: 'agora' });
    expect(r.ok).toBe(true);
    expect(r.since).toBe('agora');
    expect(r.assumed).toBe(false);
    expect(r.credited_seconds).toBe(0);
    expect(mem.events.find((e) => e.id === 101).paused_at).not.toBeNull();
    expect(mem.events.find((e) => e.id === 101).total_paused_seconds).toBe(0);
  });

  test("'inicio' credita desde o started_at da pausa e congela agora", async () => {
    mem.tick(1800); // 30 min = 1800s
    const r = await svc.joinPause({ pause_event_id: 100, person_id: 7, since: 'inicio' });
    expect(r.ok).toBe(true);
    expect(r.since).toBe('inicio');
    expect(r.credited_seconds).toBe(1800);
    const ev = mem.events.find((e) => e.id === 101);
    expect(ev.total_paused_seconds).toBe(1800);  // o trecho ANTES da entrada
    expect(ev.paused_at).not.toBeNull();          // e o resto segue congelado
  });

  test('sem resposta assume o conservador (agora), marca join_assumed e deixa a pergunta pendente', async () => {
    mem.tick(1800);
    const r = await svc.joinPause({ pause_event_id: 100, person_id: 7 }); // sem since — caso 3583
    expect(r.ok).toBe(true);
    expect(r.since).toBe('agora');
    expect(r.assumed).toBe(true);
    expect(r.credited_seconds).toBe(0);
    const q = await svc.pendingQuestionFor(7);
    expect(q).not.toBeNull();
    expect(q.assumed).toBe('agora');
    expect(q.pause_hhmm).toBe('15:18');
    expect(q.joined_hhmm).toBe('15:48');
  });

  test('responder "desde o começo" DEPOIS corrige os números (o caso do 3583)', async () => {
    mem.tick(1800);
    await svc.joinPause({ pause_event_id: 100, person_id: 7 });   // assumiu 'agora'
    expect(mem.events.find((e) => e.id === 101).total_paused_seconds).toBe(0);
    const q = await svc.pendingQuestionFor(7);
    mem.tick(60);                                                  // ela responde 1 min depois
    const a = await svc.answerPending({ event_id: q.event_id, person_id: 7, since: 'inicio' });
    expect(a.ok).toBe(true);
    expect(a.credited_seconds).toBe(1800);                         // o pedaço que faltava
    expect(mem.events.find((e) => e.id === 101).total_paused_seconds).toBe(1800);
    expect(await svc.pendingQuestionFor(7)).toBeNull();            // a pergunta some
  });

  test('responder "comecei agora" confirma o assumido e não mexe em nada', async () => {
    mem.tick(1800);
    await svc.joinPause({ pause_event_id: 100, person_id: 7 });
    const q = await svc.pendingQuestionFor(7);
    const a = await svc.answerPending({ event_id: q.event_id, person_id: 7, since: 'agora' });
    expect(a.credited_seconds).toBe(0);
    expect(mem.events.find((e) => e.id === 101).total_paused_seconds).toBe(0);
    expect(await svc.pendingQuestionFor(7)).toBeNull();
  });

  test('a pergunta SOBREVIVE ao fim da pausa (é o caso real do 3583)', async () => {
    mem.tick(1800);
    await svc.joinPause({ pause_event_id: 100, person_id: 7 });   // assumiu 'agora', sem resposta
    // a pausa acaba e os eventos são descongelados; a pessoa só volta ao kiosk depois
    mem.tick(2400);
    await svc.resumeFor([7]);
    mem.events.filter((e) => e.activity_type_id === 16).forEach((e) => { e.ended_at = mem.now(); });
    mem.tick(3600);                                                // ela toca a tela 1h depois
    const q = await svc.pendingQuestionFor(7);
    expect(q).not.toBeNull();                                      // não some sem ser perguntada
    expect(q.pause_hhmm).toBe('15:18');
    expect(q.joined_hhmm).toBe('15:48');
  });

  test('responder "desde o começo" com a pausa JÁ FECHADA ainda credita a janela cega', async () => {
    mem.tick(1800);
    await svc.joinPause({ pause_event_id: 100, person_id: 7 });
    mem.tick(2400);
    await svc.resumeFor([7]);                                      // descongelou: paused_at = NULL
    const afterResume = mem.events.find((e) => e.id === 101).total_paused_seconds;
    expect(afterResume).toBe(2400);                                // só o pedaço a partir da entrada
    mem.events.filter((e) => e.activity_type_id === 16).forEach((e) => { e.ended_at = mem.now(); });
    mem.tick(3600);
    const q = await svc.pendingQuestionFor(7);
    const a = await svc.answerPending({ event_id: q.event_id, person_id: 7, since: 'inicio' });
    expect(a.credited_seconds).toBe(1800);                         // a janela cega 15:18 → 15:48
    expect(a.events).toBe(1);
    expect(mem.events.find((e) => e.id === 101).total_paused_seconds).toBe(4200); // 2400 + 1800
  });

  test('joinPause é idempotente: chamar 2x com a mesma resposta não credita 2x', async () => {
    mem.tick(1800);
    await svc.joinPause({ pause_event_id: 100, person_id: 7, since: 'inicio' });
    const before = mem.events.find((e) => e.id === 101).total_paused_seconds;
    await svc.joinPause({ pause_event_id: 100, person_id: 7, since: 'inicio' });
    expect(mem.events.find((e) => e.id === 101).total_paused_seconds).toBe(before);
  });

  test('o starter nunca é perguntado: ele começou a pausa', async () => {
    const r = await svc.joinPause({ pause_event_id: 100, person_id: 4, since: null });
    expect(r.is_starter).toBe(true);
    expect(r.since).toBe('inicio');
    expect(await svc.pendingQuestionFor(4)).toBeNull();
  });

  test('pausa já terminada não aceita entrada', async () => {
    mem.events.find((e) => e.id === 100).ended_at = mem.now();
    const r = await svc.joinPause({ pause_event_id: 100, person_id: 7, since: 'inicio' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('pause_already_ended');
  });

  test('resposta inválida é recusada sem quebrar nada (REGRA #0: nunca 500)', async () => {
    const r = await svc.answerPending({ event_id: 999, person_id: 7, since: 'talvez' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_since');
  });

  test('isSince aceita só as duas opções do Bruno', () => {
    expect(isSince(SINCE.INICIO)).toBe(true);
    expect(isSince(SINCE.AGORA)).toBe(true);
    expect(isSince('desde_o_comeco')).toBe(false);
    expect(isSince(null)).toBe(false);
  });
});

describe('pause/service — REPARO do evento 3583 (dados reais)', () => {
  // Vitor break  11:18:36 → 12:43:07  (5071s), cowork [Bruno Sarmento]
  // Bruno review 09:50:06 → 13:05:19, total_paused_seconds = 0  → would_add 5071
  const T = (hhmmss) => new Date('2026-08-19T' + hhmmss + '-04:00');
  let mem, db, svc;
  beforeEach(() => {
    mem = makeMem(T('14:00:00').getTime());
    db = makeDb(mem);
    svc = createPauseService({ db });
    mem.names = { 4: 'Vitor', 7: 'Bruno Sarmento' };
    mem.events.push(
      { id: 3578, person_id: 4, activity_type_id: 16, started_at: T('11:18:36'), ended_at: T('12:43:07'), deleted_at: null, paused_at: null, total_paused_seconds: 0, is_unfinished: false, cowork_group_id: 'g3583', cowork_with: [7] },
      { id: 3583, person_id: 7, activity_type_id: 16, started_at: T('11:18:36'), ended_at: T('12:43:07'), deleted_at: null, paused_at: null, total_paused_seconds: 0, is_unfinished: false, cowork_group_id: 'g3583', cowork_with: [4] },
      { id: 3575, person_id: 7, activity_type_id: 11, started_at: T('09:50:06'), ended_at: T('13:05:19'), deleted_at: null, paused_at: null, total_paused_seconds: 0, is_unfinished: false },
      { id: 3576, person_id: 7, activity_type_id: 12, started_at: T('11:00:00'), ended_at: T('12:00:00'), deleted_at: null, paused_at: null, total_paused_seconds: 0, is_unfinished: false },
      // o do Vitor JÁ está certo (5071) — o reparo não pode mexer nele
      { id: 3577, person_id: 4, activity_type_id: 10, started_at: T('09:00:00'), ended_at: T('13:00:00'), deleted_at: null, paused_at: null, total_paused_seconds: 5071, is_unfinished: false },
    );
  });

  test('dry-run mede a sobreposição real e NÃO escreve', async () => {
    const r = await svc.repairPauseOverlap({ pause_event_id: 3578 });
    expect(r.ok).toBe(true);
    expect(r.dry_run).toBe(true);
    expect(r.applied).toBe(0);
    expect(r.window.seconds).toBe(5071);   // 11:18:36 → 12:43:07

    const rev = r.rows.find((x) => x.event_id === 3575);
    expect(rev.person).toBe('Bruno Sarmento');
    expect(rev.current_paused).toBe(0);
    expect(rev.would_add).toBe(5071);      // a revisão cobre a pausa inteira
    expect(rev.new_paused).toBe(5071);

    // special_task 11:00→12:00 cobre 11:18:36→12:00:00 = 2484s
    const sp = r.rows.find((x) => x.event_id === 3576);
    expect(sp.would_add).toBe(2484);

    // o evento do Vitor já tinha o desconto certo: nada a somar
    const vit = r.rows.find((x) => x.event_id === 3577);
    expect(vit.current_paused).toBe(5071);
    expect(vit.would_add).toBe(0);

    // os próprios breaks ficam de fora
    expect(r.rows.some((x) => x.event_id === 3578 || x.event_id === 3583)).toBe(false);

    // e nada foi escrito
    expect(mem.events.find((e) => e.id === 3575).total_paused_seconds).toBe(0);
  });

  test('{apply:true} escreve só o que falta e é seguro rodar 2 vezes', async () => {
    const first = await svc.repairPauseOverlap({ pause_event_id: 3578, apply: true });
    expect(first.applied).toBe(2);                            // 3575 e 3576
    expect(mem.events.find((e) => e.id === 3575).total_paused_seconds).toBe(5071);
    expect(mem.events.find((e) => e.id === 3576).total_paused_seconds).toBe(2484);
    expect(mem.events.find((e) => e.id === 3577).total_paused_seconds).toBe(5071); // intocado

    const again = await svc.repairPauseOverlap({ pause_event_id: 3578, apply: true });
    expect(again.applied).toBe(0);                            // idempotente
    expect(again.total_would_add).toBe(0);
    expect(mem.events.find((e) => e.id === 3575).total_paused_seconds).toBe(5071);
  });

  test('o reparo NUNCA remove desconto (would_add nunca é negativo)', async () => {
    mem.events.find((e) => e.id === 3575).total_paused_seconds = 9999; // já descontado demais
    const r = await svc.repairPauseOverlap({ pause_event_id: 3578 });
    expect(r.rows.find((x) => x.event_id === 3575).would_add).toBe(0);
  });

  test('pausa inexistente devolve erro em vez de estourar', async () => {
    const r = await svc.repairPauseOverlap({ pause_event_id: 12345 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('pause_not_found');
  });
});
