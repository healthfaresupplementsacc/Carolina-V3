'use strict';
/**
 * E7-cérebro #2 — formulação SEQUENCIAL (mesmo produto+batch+pessoa).
 * Reusa o padrão de fake-DB do v3-event-service.test.js + handler novo
 * pra a query com JOIN activity_types is_background=true.
 */
const { EventService } = require('../v3/services/EventService');

const SIEVE = 10;   // peneira (bg)
const MIX   = 11;   // mix (bg)
const FORM  = 12;   // formulação (bg)
const LINE  = 20;   // linha de produção (fg)
const LUNCH = 30;   // almoço (meta) — pra regra 27 (F implícito de meta)

function makeFakeDb(settings = {}) {
  let nextId = 1;
  const events = [];
  const audit = [];
  const ATS = {
    [SIEVE]: { category: 'production_phase', is_background: true,  flow: 'production' },
    [MIX]:   { category: 'production_phase', is_background: true,  flow: 'production' },
    [FORM]:  { category: 'production_phase', is_background: true,  flow: 'production' },
    [LINE]:  { category: 'production_phase', is_background: false, flow: 'production' },
    [LUNCH]: { category: 'meta',              is_background: false, flow: 'support' },
  };

  function run(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    if (/^INSERT INTO v3\.events \(/.test(s)) {
      const cols = s.match(/\(([^)]+)\)/)[1].split(',').map((x) => x.trim());
      const row = { id: nextId++, created_at: new Date(), updated_at: new Date(), deleted_at: null };
      cols.forEach((c, i) => { row[c] = params[i]; });
      events.push(row);
      return { rows: [{ ...row }] };
    }
    if (/^UPDATE v3\.events SET /.test(s)) {
      const setPart = s.match(/SET ([\s\S]+) WHERE id = \$1/)[1];
      const row = events.find((e) => e.id === params[0]);
      if (!row) return { rows: [] };
      for (const a of setPart.split(',').map((x) => x.trim())) {
        if (a.startsWith('updated_at')) { row.updated_at = new Date(); continue; }
        const m = a.match(/^(\w+) = \$(\d+)$/);
        if (m) row[m[1]] = params[Number(m[2]) - 1];
      }
      return { rows: [{ ...row }] };
    }
    if (/^SELECT \* FROM v3\.events WHERE source_message_ts/.test(s)) {
      const r = events.filter((e) => e.source_message_ts === params[0] && e.deleted_at == null);
      return { rows: r.slice(0, 1).map((x) => ({ ...x })) };
    }
    if (/^SELECT started_at FROM v3\.events WHERE id = \$1/.test(s)) {
      const r = events.find((e) => e.id === params[0]);
      return { rows: r ? [{ started_at: r.started_at }] : [] };
    }
    if (/^SELECT \* FROM v3\.events WHERE id = \$1/.test(s)) {
      const r = events.find((e) => e.id === params[0]);
      return { rows: r ? [{ ...r }] : [] };
    }
    if (/^SELECT \* FROM v3\.events WHERE person_id/.test(s)) {
      const r = events.filter((e) => e.person_id === params[0] && e.ended_at == null && e.deleted_at == null);
      return { rows: r.map((x) => ({ ...x })) };
    }
    // safetyAutoClose query — lista events abertos com ny_date derivada,
    // PULA is_long_running=true (E7-write-5).
    if (/SELECT e\.id, e\.person_id, e\.activity_type_id, e\.started_at, e\.ended_at, e\.cowork_with, e\.confidence, \(e\.started_at AT TIME ZONE 'America\/New_York'\)::date AS ny_date FROM v3\.events e WHERE e\.ended_at IS NULL AND e\.deleted_at IS NULL/.test(s)) {
      const r = events.filter((e) =>
        e.ended_at == null && e.deleted_at == null
        && !e.is_long_running);   // filter da COALESCE(is_long_running, false) = false
      return { rows: r.map((x) => ({
        id: x.id, person_id: x.person_id, activity_type_id: x.activity_type_id,
        started_at: x.started_at, ended_at: x.ended_at,
        cowork_with: x.cowork_with || [], confidence: x.confidence,
        ny_date: String(x.started_at).slice(0, 10),
      })) };
    }
    // E7-cérebro: query do _closeMatchingBgSamePB
    if (/SELECT e\.id, e\.activity_type_id, e\.product_batch_id, e\.started_at FROM v3\.events e LEFT JOIN v3\.activity_types at ON at\.id = e\.activity_type_id WHERE e\.person_id = \$1 AND e\.product_batch_id = \$2 AND e\.ended_at IS NULL AND e\.deleted_at IS NULL AND at\.is_background = true/.test(s)) {
      const [personId, batchId] = params;
      const r = events.filter((e) =>
        e.person_id === personId
        && e.product_batch_id === batchId
        && e.ended_at == null
        && e.deleted_at == null
        && (ATS[e.activity_type_id] || {}).is_background === true);
      return { rows: r.map((x) => ({ id: x.id, activity_type_id: x.activity_type_id, product_batch_id: x.product_batch_id, started_at: x.started_at })) };
    }
    if (/^SELECT category, is_background FROM v3\.activity_types/.test(s)) {
      const a = ATS[params[0]];
      return { rows: a != null ? [{ category: a.category, is_background: a.is_background }] : [] };
    }
    if (/^SELECT category FROM v3\.activity_types/.test(s)) {
      const a = ATS[params[0]];
      return { rows: a != null ? [{ category: a.category }] : [] };
    }
    if (/^SELECT value FROM v3\.settings WHERE key = \$1/.test(s)) {
      if (Object.prototype.hasOwnProperty.call(settings, params[0])) {
        return { rows: [{ value: settings[params[0]] }] };
      }
      return { rows: [] };
    }
    if (/^INSERT INTO v3\.audit_log/.test(s)) {
      audit.push({
        actor_type: params[0], actor_person_id: params[1], action: params[2],
        target_id: params[3], before_data: params[4], after_data: params[5], metadata: params[6],
      });
      return { rows: [] };
    }
    return { rows: [] };
  }

  const db = { events, audit, query: jest.fn((sql, params) => Promise.resolve(run(sql, params))) };
  db.connect = () => Promise.resolve({ query: db.query, release: () => {} });
  return db;
}

const T = (h, m = 0) => `2026-05-26T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const svc = (db) => new EventService({ db });

describe('E7-cérebro #2 — formulação sequencial (mesmo prod+batch+pessoa)', () => {
  test('Peneira → Mix no MESMO Potassium 0164: 2ª fecha 1ª', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev1 = await s.upsert({
      person_id: 1, activity_type_id: SIEVE, product_batch_id: 100,
      started_at: T(11, 46), source_message_ts: 'm1', actor_type: 'llm_observer',
    });
    await s.upsert({
      person_id: 1, activity_type_id: MIX, product_batch_id: 100,
      started_at: T(11, 58), source_message_ts: 'm2', actor_type: 'llm_observer',
    });
    const ev1After = db.events.find((e) => e.id === ev1.id);
    expect(ev1After.ended_at).toBe(T(11, 58));
    expect(ev1After.closed_reason).toBe('next_phase');
    // ev1 fechado pela regra sequencial; ev2 aberto
    const stillOpen = db.events.filter((e) => e.ended_at == null);
    expect(stillOpen).toHaveLength(1);
  });

  test('Mesmo produto, batches DIFERENTES → paralelo (não fecha)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev1 = await s.upsert({
      person_id: 1, activity_type_id: FORM, product_batch_id: 100,    // Potassium
      started_at: T(10, 0), source_message_ts: 'm10', actor_type: 'llm_observer',
    });
    await s.upsert({
      person_id: 1, activity_type_id: FORM, product_batch_id: 101,    // L-Carnitine
      started_at: T(10, 30), source_message_ts: 'm11', actor_type: 'llm_observer',
    });
    expect(db.events.find((e) => e.id === ev1.id).ended_at).toBeFalsy();
    expect(db.events.filter((e) => e.ended_at == null)).toHaveLength(2);
  });

  test('Mesmo prod+batch, PESSOAS diferentes → paralelo (não fecha)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const evA = await s.upsert({
      person_id: 1, activity_type_id: MIX, product_batch_id: 100,
      started_at: T(10, 0), source_message_ts: 'mA', actor_type: 'llm_observer',
    });
    await s.upsert({
      person_id: 2, activity_type_id: MIX, product_batch_id: 100,
      started_at: T(10, 30), source_message_ts: 'mB', actor_type: 'llm_observer',
    });
    expect(db.events.find((e) => e.id === evA.id).ended_at).toBeFalsy();
  });

  test('Foreground não é afetada pela regra sequencial BG', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const evFg = await s.upsert({
      person_id: 1, activity_type_id: LINE, product_batch_id: 100,
      started_at: T(9, 0), source_message_ts: 'mFG', actor_type: 'llm_observer',
    });
    // BG novo no mesmo batch: fecha bg anterior (não tem) mas NÃO toca o fg
    await s.upsert({
      person_id: 1, activity_type_id: MIX, product_batch_id: 100,
      started_at: T(9, 30), source_message_ts: 'mBG', actor_type: 'llm_observer',
    });
    expect(db.events.find((e) => e.id === evFg.id).ended_at).toBeFalsy();
  });

  test('Sem product_batch_id, regra antiga (BG coexistem)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev1 = await s.upsert({
      person_id: 1, activity_type_id: FORM, product_batch_id: null,
      started_at: T(10, 0), source_message_ts: 'mX', actor_type: 'llm_observer',
    });
    await s.upsert({
      person_id: 1, activity_type_id: MIX, product_batch_id: null,
      started_at: T(10, 30), source_message_ts: 'mY', actor_type: 'llm_observer',
    });
    expect(db.events.find((e) => e.id === ev1.id).ended_at).toBeFalsy();
  });

  test('Audit log marca closed_reason=next_phase + sequential=true', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({
      person_id: 1, activity_type_id: SIEVE, product_batch_id: 100,
      started_at: T(11, 46), source_message_ts: 'a1', actor_type: 'llm_observer',
    });
    await s.upsert({
      person_id: 1, activity_type_id: MIX, product_batch_id: 100,
      started_at: T(11, 58), source_message_ts: 'a2', actor_type: 'llm_observer',
    });
    const closed = db.audit.find((a) => a.action === 'event.closed');
    expect(closed).toBeDefined();
    const meta = JSON.parse(closed.metadata);
    expect(meta.reason).toBe('next_phase');
    expect(meta.sequential).toBe(true);
  });
});

describe('E7-bloco-27 regra 27 — F implícito de META (fg fecha break/lunch aberto)', () => {
  test('abrir foreground fecha lunch aberto da mesma pessoa', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    // 1) Bruno abre lunch
    const lunch = await s.upsert({
      person_id: 7, activity_type_id: LUNCH,
      started_at: '2026-05-27T17:40:00-04:00', source_message_ts: 'lunch1',
      actor_type: 'llm_observer',
    });
    expect(lunch.ended_at).toBeNull();
    // 2) Bruno posta NOVA foreground sem F do lunch
    await s.upsert({
      person_id: 7, activity_type_id: LINE,
      started_at: '2026-05-27T18:27:00-04:00', source_message_ts: 'line1',
      actor_type: 'llm_observer',
    });
    // 3) lunch deve estar FECHADO em 18:27 com closed_reason='meta_closed_by_fg'
    const lunchAfter = db.events.find((e) => e.id === lunch.id);
    expect(lunchAfter.ended_at).toBe('2026-05-27T18:27:00-04:00');
    expect(lunchAfter.closed_reason).toBe('meta_closed_by_fg');
  });

  test('abrir BACKGROUND NÃO fecha lunch (só fg fecha meta)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const lunch = await s.upsert({
      person_id: 7, activity_type_id: LUNCH,
      started_at: '2026-05-27T17:40:00-04:00', source_message_ts: 'lunch2',
      actor_type: 'llm_observer',
    });
    // BG (formulação) — não fecha meta
    await s.upsert({
      person_id: 7, activity_type_id: FORM, product_batch_id: 50,
      started_at: '2026-05-27T17:45:00-04:00', source_message_ts: 'form-during-lunch',
      actor_type: 'llm_observer',
    });
    const lunchAfter = db.events.find((e) => e.id === lunch.id);
    expect(lunchAfter.ended_at).toBeFalsy();   // lunch ainda OPEN
  });
});

describe('E7-write-5 — is_long_running (Potassium/Chromium multi-dia)', () => {
  test('markLongRunning audita e seta flag', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({
      person_id: 1, activity_type_id: FORM, product_batch_id: null,
      started_at: T(15, 46), source_message_ts: 'pot1', actor_type: 'llm_observer',
    });
    const r = await s.markLongRunning(ev.id, true, { actorType: 'admin', reason: 'Potassium multi-dia' });
    expect(r.is_long_running).toBe(true);
    const audit = db.audit.find((a) => a.action === 'event.long_running_set');
    expect(audit).toBeDefined();
    expect(JSON.parse(audit.metadata).reason).toBe('Potassium multi-dia');
  });

  test('safetyAutoClose PULA events com is_long_running=true', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({
      person_id: 1, activity_type_id: LINE,
      started_at: '2026-05-26T19:30:00-04:00', source_message_ts: 'long1',
      actor_type: 'llm_observer',
    });
    // Marca como long-running
    await s.markLongRunning(ev.id, true, { actorType: 'admin' });
    // refTime depois do EOD 21h
    const closed = await s.safetyAutoClose(new Date('2026-05-27T01:30:00.000Z'));
    expect(closed).toHaveLength(0);   // skipped — não fechou
    const evAfter = db.events.find((e) => e.id === ev.id);
    expect(evAfter.ended_at).toBeFalsy();   // ainda aberto
  });

  test('safetyAutoClose AINDA fecha events normais (sem is_long_running)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({
      person_id: 1, activity_type_id: LINE,
      started_at: '2026-05-26T19:30:00-04:00', source_message_ts: 'normal1',
      actor_type: 'llm_observer',
    });
    const closed = await s.safetyAutoClose(new Date('2026-05-27T01:30:00.000Z'));
    expect(closed).toHaveLength(1);   // fechou normalmente
  });
});

describe('E7-cérebro #1 — safetyAutoClose 21h (default novo)', () => {
  test('default fallback subiu de 19 pra 21h', async () => {
    const db = makeFakeDb();  // sem settings → cai no default
    const s = svc(db);
    // event aberto às 19:30 no dia 2026-05-26 (NY)
    await s.upsert({
      person_id: 1, activity_type_id: LINE,
      started_at: '2026-05-26T19:30:00-04:00', source_message_ts: 'safe1',
      actor_type: 'llm_observer',
    });
    // refTime 20:00 NY (= 00:00Z next day em EDT) — antes do EOD 21h → não fecha
    const beforeEod = await s.safetyAutoClose(new Date('2026-05-27T00:00:00.000Z'));
    expect(beforeEod).toHaveLength(0);
    // refTime 21:30 NY (= 01:30Z next day em EDT) — pós EOD → fecha
    const closed = await s.safetyAutoClose(new Date('2026-05-27T01:30:00.000Z'));
    expect(closed.length).toBeGreaterThanOrEqual(1);
    const e = db.events[0];
    expect(e.ended_at).toMatch(/^2026-05-26T21:00:00-04:00$/);
    expect(e.closed_reason).toBe('auto_closed_eod');
  });
});
