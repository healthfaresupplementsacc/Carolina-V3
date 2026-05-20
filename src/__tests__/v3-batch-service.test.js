'use strict';
// HEALTHFARE V3 — PARTE 2.5 — testes comportamentais do BatchService.
const { BatchService, unionSeconds } = require('../v3/services/BatchService');

const pad = (n) => String(n).padStart(2, '0');
const T = (h, m = 0) => `2026-05-20T${pad(h)}:${pad(m)}:00.000Z`;

const ACTIVITY_TYPES = [
  { id: 10, slug: 'formulation', display_name: 'Formulação' },
  { id: 20, slug: 'mixing', display_name: 'Mix' },
];
const PERSONS = [
  { id: 1, display_name: 'Ana' },
  { id: 2, display_name: 'Vitor' },
  { id: 3, display_name: 'Simone' },
];

/** Fake in-memory de v3.product_batches/events/production_counts/etc. */
function makeFakeDb({ events = [], counts = [], activityTypes = ACTIVITY_TYPES, persons = PERSONS } = {}) {
  let nextBatchId = 1;
  const batches = [];
  const audit = [];

  function run(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    if (/^INSERT INTO v3\.product_batches/.test(s)) {
      const row = {
        id: nextBatchId++, product_id: params[0], batch_number: params[1],
        started_at: params[2], status: 'in_progress', finished_at: null, notes: null,
        deleted_at: null, deleted_by: null, created_at: new Date(), updated_at: new Date(),
      };
      batches.push(row);
      return { rows: [{ ...row }] };
    }
    if (/^UPDATE v3\.product_batches SET /.test(s)) {
      const setPart = s.match(/SET ([\s\S]+) WHERE id = \$1/)[1];
      const row = batches.find((b) => b.id === params[0]);
      if (!row) return { rows: [] };
      for (const a of setPart.split(',').map((x) => x.trim())) {
        if (a.startsWith('updated_at')) { row.updated_at = new Date(); continue; }
        const m = a.match(/^(\w+) = \$(\d+)$/);
        if (m) row[m[1]] = params[Number(m[2]) - 1];
      }
      return { rows: [{ ...row }] };
    }
    if (/^SELECT \* FROM v3\.product_batches WHERE product_id/.test(s)) {
      const r = batches.filter((b) => b.product_id === params[0] && b.batch_number === params[1] && b.deleted_at == null)
        .sort((a, b) => a.id - b.id);
      return { rows: r.slice(0, 1).map((x) => ({ ...x })) };
    }
    if (/^SELECT \* FROM v3\.product_batches WHERE id = \$1/.test(s)) {
      const r = batches.find((b) => b.id === params[0]);
      return { rows: r ? [{ ...r }] : [] };
    }
    if (/^SELECT \* FROM v3\.product_batches WHERE status/.test(s)) {
      const r = batches.filter((b) => b.status === 'in_progress' && b.deleted_at == null)
        .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
      return { rows: r.map((x) => ({ ...x })) };
    }
    if (/^UPDATE v3\.events SET product_batch_id/.test(s)) {
      const moved = events.filter((e) => e.product_batch_id === params[0] && e.deleted_at == null);
      moved.forEach((e) => { e.product_batch_id = params[1]; });
      return { rows: /RETURNING id/.test(s) ? moved.map((e) => ({ id: e.id })) : [] };
    }
    if (/^SELECT id, person_id, activity_type_id/.test(s)) {
      const r = events.filter((e) => e.product_batch_id === params[0] && e.deleted_at == null)
        .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
      return { rows: r.map((e) => ({ id: e.id, person_id: e.person_id, activity_type_id: e.activity_type_id, started_at: e.started_at, ended_at: e.ended_at })) };
    }
    if (/^UPDATE v3\.production_counts SET product_batch_id/.test(s)) {
      counts.filter((c) => c.product_batch_id === params[0] && c.deleted_at == null)
        .forEach((c) => { c.product_batch_id = params[1]; });
      return { rows: [] };
    }
    if (/^SELECT bottles FROM v3\.production_counts/.test(s)) {
      const r = counts.filter((c) => c.product_batch_id === params[0] && c.superseded_by == null && c.deleted_at == null);
      return { rows: r.map((c) => ({ bottles: c.bottles })) };
    }
    if (/^SELECT id, slug, display_name FROM v3\.activity_types/.test(s)) {
      return { rows: activityTypes.filter((a) => params[0].includes(a.id)).map((x) => ({ ...x })) };
    }
    if (/^SELECT id, display_name FROM v3\.persons/.test(s)) {
      return { rows: persons.filter((p) => params[0].includes(p.id)).map((x) => ({ ...x })) };
    }
    if (/^INSERT INTO v3\.audit_log/.test(s)) {
      audit.push({ actor_type: params[0], action: params[2], target_id: params[3] });
      return { rows: [] };
    }
    return { rows: [] };
  }

  const db = {
    batches, events, counts, audit,
    query: jest.fn((sql, p) => Promise.resolve(run(sql, p))),
  };
  db.connect = () => Promise.resolve({ query: db.query, release: () => {} });
  return db;
}

const svc = (db, opts) => new BatchService(Object.assign({ db }, opts));
const auditActions = (db) => db.audit.map((a) => a.action);

describe('V3 §2.5 — unionSeconds (dedup de cowork)', () => {
  test('intervalo simples', () => {
    expect(unionSeconds([{ start: new Date(T(10)), end: new Date(T(12)) }])).toBe(7200);
  });
  test('3 intervalos idênticos (cowork) contam 1x', () => {
    const iv = { start: new Date(T(10)), end: new Date(T(11, 30)) };
    expect(unionSeconds([iv, { ...iv }, { ...iv }])).toBe(5400);
  });
  test('intervalos disjuntos somam', () => {
    expect(unionSeconds([
      { start: new Date(T(9)), end: new Date(T(10)) },
      { start: new Date(T(14)), end: new Date(T(15)) },
    ])).toBe(7200);
  });
  test('sobreposição parcial funde', () => {
    expect(unionSeconds([
      { start: new Date(T(10)), end: new Date(T(12)) },
      { start: new Date(T(11)), end: new Date(T(13)) },
    ])).toBe(10800); // 10:00–13:00
  });
});

describe('V3 §2.5 — findOrCreateActive', () => {
  test('cria batch novo', async () => {
    const db = makeFakeDb();
    const b = await svc(db).findOrCreateActive(5, '0136', T(9), { actorType: 'llm_observer' });
    expect(b.id).toBeDefined();
    expect(b.status).toBe('in_progress');
    expect(db.batches).toHaveLength(1);
  });
  test('acha existente — não duplica', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const b1 = await s.findOrCreateActive(5, '0136', T(9), { actorType: 'llm_observer' });
    const b2 = await s.findOrCreateActive(5, '0136', T(10), { actorType: 'llm_observer' });
    expect(b2.id).toBe(b1.id);
    expect(db.batches).toHaveLength(1);
  });
  test('product_id obrigatório', async () => {
    await expect(svc(makeFakeDb()).findOrCreateActive(null, '0136', T(9))).rejects.toThrow(/product_id/);
  });
});

describe('V3 §2.5 — closeBatch', () => {
  test('muda status e finished_at', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const b = await s.findOrCreateActive(5, '0136', T(9));
    const closed = await s.closeBatch(b.id, T(17), 'completed', { actorPersonId: 1 });
    expect(closed.status).toBe('completed');
    expect(closed.finished_at).toBe(T(17));
  });
  test('rejeita status inválido', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const b = await s.findOrCreateActive(5, '0136', T(9));
    await expect(s.closeBatch(b.id, T(17), 'in_progress')).rejects.toThrow(/status inválido/);
    await expect(s.closeBatch(b.id, T(17), 'banana')).rejects.toThrow(/status inválido/);
  });
});

describe('V3 §2.5 — reassignEvents', () => {
  test('move events de batch A pra B', async () => {
    const db = makeFakeDb({
      events: [
        { id: 101, product_batch_id: 1, deleted_at: null },
        { id: 102, product_batch_id: 1, deleted_at: null },
        { id: 103, product_batch_id: 9, deleted_at: null },
      ],
    });
    const r = await svc(db).reassignEvents(1, 2, { actorPersonId: 1 });
    expect(r.reassigned.sort()).toEqual([101, 102]);
    expect(db.events.find((e) => e.id === 101).product_batch_id).toBe(2);
    expect(db.events.find((e) => e.id === 103).product_batch_id).toBe(9); // não tocado
  });
});

describe('V3 §2.5 — mergeBatches', () => {
  test('funde 2: events+counts migram, perdedor soft-deleted, sobrevivente = menor started_at', async () => {
    const db = makeFakeDb({
      events: [{ id: 201, product_batch_id: 2, deleted_at: null }],
      counts: [{ id: 301, product_batch_id: 2, bottles: 100, superseded_by: null, deleted_at: null }],
    });
    const s = svc(db);
    const b1 = await s.findOrCreateActive(5, '0136', T(8));   // mais cedo
    const b2 = await s.findOrCreateActive(5, '0137', T(14));  // mais tarde
    const survivor = await s.mergeBatches([b2.id, b1.id], { actorPersonId: 1 });
    expect(survivor.id).toBe(b1.id);                          // menor started_at
    expect(db.events.find((e) => e.id === 201).product_batch_id).toBe(b1.id);
    expect(db.counts.find((c) => c.id === 301).product_batch_id).toBe(b1.id);
    expect(db.batches.find((b) => b.id === b2.id).deleted_at).not.toBeNull();
  });
  test('exige >= 2 batch_ids', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const b = await s.findOrCreateActive(5, '0136', T(9));
    await expect(s.mergeBatches([b.id])).rejects.toThrow(/>= 2/);
  });
});

describe('V3 §2.5 — listActive', () => {
  test('retorna só in_progress', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const b1 = await s.findOrCreateActive(5, '0136', T(9));
    await s.findOrCreateActive(5, '0137', T(10));
    await s.closeBatch(b1.id, T(17), 'completed');
    const act = await s.listActive();
    expect(act).toHaveLength(1);
    expect(act[0].batch_number).toBe('0137');
  });
});

describe('V3 §2.5 — getSummary', () => {
  test('tempo total simples (1 pessoa)', async () => {
    const db = makeFakeDb({
      events: [{ id: 1, product_batch_id: 1, person_id: 1, activity_type_id: 10, started_at: T(10), ended_at: T(12), deleted_at: null }],
    });
    const s = svc(db);
    await s.findOrCreateActive(5, '0136', T(9));
    const sum = await s.getSummary(1);
    expect(sum.total_seconds).toBe(7200);
    expect(sum.event_count).toBe(1);
  });

  test('DEDUP cowork — 3 pessoas sobrepostas contam 1x', async () => {
    const db = makeFakeDb({
      events: [
        { id: 1, product_batch_id: 1, person_id: 1, activity_type_id: 10, started_at: T(10), ended_at: T(11, 30), deleted_at: null },
        { id: 2, product_batch_id: 1, person_id: 2, activity_type_id: 10, started_at: T(10), ended_at: T(11, 30), deleted_at: null },
        { id: 3, product_batch_id: 1, person_id: 3, activity_type_id: 10, started_at: T(10), ended_at: T(11, 30), deleted_at: null },
      ],
    });
    const s = svc(db);
    await s.findOrCreateActive(5, '0136', T(9));
    const sum = await s.getSummary(1);
    expect(sum.total_seconds).toBe(5400);          // 1h30, NÃO 4h30
    expect(sum.people.map((p) => p.person_id).sort()).toEqual([1, 2, 3]);
  });

  test('garrafas soma counts não-superseded; exclui superseded', async () => {
    const db = makeFakeDb({
      events: [{ id: 1, product_batch_id: 1, person_id: 1, activity_type_id: 10, started_at: T(10), ended_at: T(11), deleted_at: null }],
      counts: [
        { id: 1, product_batch_id: 1, bottles: 684, superseded_by: null, deleted_at: null },
        { id: 2, product_batch_id: 1, bottles: 200, superseded_by: null, deleted_at: null },
        { id: 3, product_batch_id: 1, bottles: 999, superseded_by: 1, deleted_at: null }, // superseded
      ],
    });
    const s = svc(db);
    await s.findOrCreateActive(5, '0136', T(9));
    expect((await s.getSummary(1)).bottles).toBe(884); // 684+200, exclui 999
  });

  test('fases em ordem cronológica de 1ª ocorrência', async () => {
    const db = makeFakeDb({
      events: [
        { id: 1, product_batch_id: 1, person_id: 1, activity_type_id: 10, started_at: T(10), ended_at: T(11), deleted_at: null },
        { id: 2, product_batch_id: 1, person_id: 1, activity_type_id: 20, started_at: T(11), ended_at: T(12), deleted_at: null },
        { id: 3, product_batch_id: 1, person_id: 1, activity_type_id: 10, started_at: T(12), ended_at: T(13), deleted_at: null },
      ],
    });
    const s = svc(db);
    await s.findOrCreateActive(5, '0136', T(9));
    const sum = await s.getSummary(1);
    expect(sum.phases.map((p) => p.slug)).toEqual(['formulation', 'mixing']);
  });

  test('batch vazio — total 0, people/phases vazios, 0 garrafas', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.findOrCreateActive(5, '0136', T(9));
    const sum = await s.getSummary(1);
    expect(sum.total_seconds).toBe(0);
    expect(sum.people).toEqual([]);
    expect(sum.phases).toEqual([]);
    expect(sum.bottles).toBe(0);
  });

  test('batch inexistente → erro', async () => {
    await expect(svc(makeFakeDb()).getSummary(999)).rejects.toThrow(/não existe/);
  });
});

describe('V3 §2.5 — audit', () => {
  test('mergeBatches e closeBatch geram audit', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const b1 = await s.findOrCreateActive(5, '0136', T(8));
    const b2 = await s.findOrCreateActive(5, '0137', T(9));
    await s.closeBatch(b1.id, T(17), 'completed');
    await s.mergeBatches([b1.id, b2.id]);
    expect(auditActions(db)).toEqual(expect.arrayContaining([
      'batch.created', 'batch.closed', 'batch.merged',
    ]));
  });
});
