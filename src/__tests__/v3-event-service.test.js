'use strict';
// HEALTHFARE V3 — PARTE 2.4 — testes comportamentais do EventService.
const { EventService } = require('../v3/services/EventService');

// activity_type ids usados nos testes
const WORK = 10;   // production_phase
const BREAK = 20;  // meta
const LUNCH = 21;  // meta

/** Fake in-memory de v3.events / v3.activity_types / v3.audit_log. */
function makeFakeDb() {
  let nextId = 1;
  const events = [];
  const audit = [];
  const cats = { [WORK]: 'production_phase', [BREAK]: 'meta', [LUNCH]: 'meta' };

  function run(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    if (/^INSERT INTO v3\.events \(/.test(s)) {
      const cols = s.match(/\(([^)]+)\)/)[1].split(',').map((x) => x.trim());
      const row = { id: nextId++, created_at: new Date(), updated_at: new Date(), deleted_at: null, deleted_by: null };
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
      const r = events.filter((e) => e.source_message_ts === params[0] && e.deleted_at == null)
        .sort((a, b) => a.id - b.id);
      return { rows: r.slice(0, 1).map((x) => ({ ...x })) };
    }
    if (/^SELECT \* FROM v3\.events WHERE id = \$1/.test(s)) {
      const r = events.find((e) => e.id === params[0]);
      return { rows: r ? [{ ...r }] : [] };
    }
    if (/^SELECT started_at FROM v3\.events WHERE id = \$1/.test(s)) {
      const r = events.find((e) => e.id === params[0]);
      return { rows: r ? [{ started_at: r.started_at }] : [] };
    }
    if (/^SELECT \* FROM v3\.events WHERE person_id/.test(s)) {
      const r = events.filter((e) => e.person_id === params[0] && e.ended_at == null && e.deleted_at == null)
        .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
      return { rows: r.map((x) => ({ ...x })) };
    }
    if (/^SELECT category FROM v3\.activity_types/.test(s)) {
      const c = cats[params[0]];
      return { rows: c != null ? [{ category: c }] : [] };
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

  const db = {
    events, audit,
    query: jest.fn((sql, params) => Promise.resolve(run(sql, params))),
  };
  db.connect = () => Promise.resolve({ query: db.query, release: () => {} });
  return db;
}

const T = (h) => `2026-05-20T${String(h).padStart(2, '0')}:00:00.000Z`;
const svc = (db) => new EventService({ db });
const actions = (db) => db.audit.map((a) => a.action);
const active = (db, personId) => db.events.filter((e) => e.person_id === personId && e.ended_at == null && e.deleted_at == null);

describe('V3 §2.4 — upsert + idempotência', () => {
  test('upsert cria event novo', async () => {
    const db = makeFakeDb();
    const ev = await svc(db).upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    expect(ev.id).toBeDefined();
    expect(ev.person_id).toBe(1);
    expect(db.events).toHaveLength(1);
  });

  test('upsert com mesmo source_message_ts → UPDATE, não duplica', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), source_message_ts: 'm1', description: 'v1', actor_type: 'llm_observer' });
    const second = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), source_message_ts: 'm1', description: 'v2', actor_type: 'llm_observer' });
    expect(db.events).toHaveLength(1);
    expect(second.description).toBe('v2');
    expect(actions(db)).toContain('event.updated');
  });

  test('person_id / started_at obrigatórios', async () => {
    const db = makeFakeDb();
    await expect(svc(db).upsert({ started_at: T(9), actor_type: 'system' })).rejects.toThrow(/person_id/);
    await expect(svc(db).upsert({ person_id: 1, actor_type: 'system' })).rejects.toThrow(/started_at/);
  });

  test('actor_type inválido → erro defensivo', async () => {
    const db = makeFakeDb();
    await expect(svc(db).upsert({ person_id: 1, started_at: T(9), actor_type: 'hacker' }))
      .rejects.toThrow(/actor_type inválido/);
  });
});

describe('V3 §2.4 — auto-close + invariante', () => {
  test('2º event de trabalho ativo fecha o 1º (mesma pessoa)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const e1 = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(11), actor_type: 'llm_observer' });
    const closed = db.events.find((e) => e.id === e1.id);
    expect(closed.ended_at).toBe(T(11));
    expect(closed.closed_reason).toBe('next_event');
    expect(active(db, 1)).toHaveLength(1); // só o novo
  });

  test('auto-close NÃO fecha event de OUTRA pessoa', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 2, activity_type_id: WORK, started_at: T(10), actor_type: 'llm_observer' });
    expect(active(db, 1)).toHaveLength(1);
    expect(active(db, 2)).toHaveLength(1);
  });

  test('break NÃO fecha event de trabalho — coexistem (2 ativos OK)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: BREAK, started_at: T(12), actor_type: 'llm_observer' });
    expect(active(db, 1)).toHaveLength(2); // trabalho + break
  });

  test('lunch (meta) coexiste com trabalho', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: LUNCH, started_at: T(12), actor_type: 'llm_observer' });
    expect(active(db, 1)).toHaveLength(2);
  });

  test('closeActivePersonEvent fecha o event de trabalho ativo', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    const closed = await s.closeActivePersonEvent(1, T(17), 'manual');
    expect(closed).toHaveLength(1);
    expect(active(db, 1)).toHaveLength(0);
  });
});

describe('V3 §2.4 — cowork bidirecional', () => {
  test('A↔B sincroniza simétrico', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const eB = await s.upsert({ person_id: 2, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    const eA = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), cowork_with: [2], actor_type: 'llm_observer' });
    expect(db.events.find((e) => e.id === eA.id).cowork_with).toEqual([2]);
    expect(db.events.find((e) => e.id === eB.id).cowork_with).toEqual([1]);
  });

  test('3 pessoas (A,B,C) — cada uma aponta pras outras 2', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const eB = await s.upsert({ person_id: 2, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    const eC = await s.upsert({ person_id: 3, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    const eA = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), cowork_with: [2, 3], actor_type: 'llm_observer' });
    expect(db.events.find((e) => e.id === eA.id).cowork_with.sort()).toEqual([2, 3]);
    expect(db.events.find((e) => e.id === eB.id).cowork_with.sort()).toEqual([1, 3]);
    expect(db.events.find((e) => e.id === eC.id).cowork_with.sort()).toEqual([1, 2]);
  });

  test('ao fechar A, B e C têm A removido do cowork_with', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const eB = await s.upsert({ person_id: 2, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    const eC = await s.upsert({ person_id: 3, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), cowork_with: [2, 3], actor_type: 'llm_observer' });
    await s.closeActivePersonEvent(1, T(12), 'manual');
    expect(db.events.find((e) => e.id === eB.id).cowork_with).toEqual([3]);
    expect(db.events.find((e) => e.id === eC.id).cowork_with).toEqual([2]);
  });
});

describe('V3 §2.4 — soft delete / restore / correct', () => {
  test('softDelete preserva a row (deleted_at setado)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    const del = await s.softDelete(ev.id, 99, 'engano');
    expect(del.deleted_at).not.toBeNull();
    expect(del.deleted_by).toBe(99);
    expect(db.events).toHaveLength(1); // não removeu a row
  });

  test('restore desfaz o softDelete', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await s.softDelete(ev.id, 99, 'engano');
    const r = await s.restore(ev.id, 99);
    expect(r.deleted_at).toBeNull();
  });

  test('correct aplica changes e audita before/after', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), description: 'antigo', actor_type: 'llm_observer' });
    const after = await s.correct(ev.id, { description: 'novo' }, 99, 'ajuste manual');
    expect(after.description).toBe('novo');
    const corr = db.audit.find((a) => a.action === 'event.corrected');
    expect(JSON.parse(corr.before_data).description).toBe('antigo');
    expect(JSON.parse(corr.after_data).description).toBe('novo');
  });

  test('correct rejeita campo não-corrigível', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await expect(s.correct(ev.id, { id: 999 }, 99)).rejects.toThrow(/não-corrigível/);
  });
});

describe('V3 §2.4 — merge / split', () => {
  test('mergeEvents funde N em 1 (started_at min, ended_at max)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const e1 = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), ended_at: T(11), actor_type: 'admin' });
    const e2 = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(13), ended_at: T(15), actor_type: 'admin' });
    const merged = await s.mergeEvents([e2.id, e1.id], 99);
    expect(merged.id).toBe(e1.id);          // sobrevivente = menor started_at
    expect(merged.started_at).toBe(T(9));
    expect(merged.ended_at).toBe(T(15));
    expect(db.events.find((e) => e.id === e2.id).deleted_at).not.toBeNull();
  });

  test('mergeEvents exige >= 2 ids', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const e1 = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'admin' });
    await expect(s.mergeEvents([e1.id], 99)).rejects.toThrow(/>= 2/);
  });

  test('splitEvent divide 1 em 2 no split_at', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), ended_at: T(17), actor_type: 'admin' });
    const { first, second } = await s.splitEvent(ev.id, T(12), 99);
    expect(first.ended_at).toBe(T(12));
    expect(first.closed_reason).toBe('split');
    expect(second.started_at).toBe(T(12));
    expect(second.ended_at).toBe(T(17));
    expect(second.source_message_ts).toBeNull(); // não copia (UNIQUE)
    expect(db.events).toHaveLength(2);
  });
});

describe('V3 §2.4 — findBySource + audit', () => {
  test('findBySource acha por ts e retorna null quando não existe', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), source_message_ts: 'abc', actor_type: 'llm_observer' });
    expect((await s.findBySource('abc')).source_message_ts).toBe('abc');
    expect(await s.findBySource('nope')).toBeNull();
  });

  test('audit registrado em CADA mutação', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(11), actor_type: 'llm_observer' }); // created + closed
    await s.correct(ev.id, { phase_label: 'rev' }, 99);
    await s.softDelete(ev.id, 99, 'x');
    await s.restore(ev.id, 99);
    const a = actions(db);
    expect(a).toEqual(expect.arrayContaining([
      'event.created', 'event.closed', 'event.corrected', 'event.deleted', 'event.restored',
    ]));
  });
});

describe('V3 §2.4 — guard de duração negativa (achado pós-shadow)', () => {
  test('close com ended_at < started_at → clampa pro started_at, nunca grava negativo', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(14), actor_type: 'llm_observer' });
    // mensagem fora de ordem: fecha às 11h um event que abriu às 14h
    const closed = await s.closeActivePersonEvent(1, T(11), 'manual');
    const row = db.events.find((e) => e.id === ev.id);
    expect(row.ended_at).toBe(T(14));               // clampado pro started_at, não T(11)
    expect(new Date(row.ended_at) >= new Date(row.started_at)).toBe(true); // nunca negativo
    expect(closed[0].ended_at).toBe(T(14));
    expect(actions(db)).toContain('event.negative_duration_clamped');
    expect(active(db, 1)).toHaveLength(0);          // invariante: event fechou (não ficou aberto)
  });

  test('close normal (ended_at > started_at) NÃO clampa nem audita anomalia', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    const closed = await s.closeActivePersonEvent(1, T(17), 'manual');
    expect(closed[0].ended_at).toBe(T(17));         // valor normal preservado
    expect(actions(db)).not.toContain('event.negative_duration_clamped');
  });

  test('isNegativeDuration: só true quando ended < started; nulo/inválido → false', () => {
    const { isNegativeDuration } = require('../v3/services/EventService');
    expect(isNegativeDuration(T(14), T(11))).toBe(true);
    expect(isNegativeDuration(T(9), T(17))).toBe(false);
    expect(isNegativeDuration(T(9), null)).toBe(false);
    expect(isNegativeDuration(null, T(9))).toBe(false);
    expect(isNegativeDuration('lixo', T(9))).toBe(false);
  });
});
