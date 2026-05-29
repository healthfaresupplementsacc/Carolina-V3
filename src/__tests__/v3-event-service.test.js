'use strict';
// HEALTHFARE V3 — PARTE 2.4 — testes comportamentais do EventService.
const { EventService } = require('../v3/services/EventService');

// activity_type ids usados nos testes
const WORK = 10;   // production_phase (foreground)
const BREAK = 20;  // meta
const LUNCH = 21;  // meta
const BG = 30;     // is_background=true (formulação/mix/encapsulação)
const BG2 = 31;    // outro background tipo (pra testes de FIFO de mesmo tipo)
const EOD = 22;    // meta · slug='end_of_day' (bloco 28/mai noite #32)

/** Fake in-memory de v3.events / v3.activity_types / v3.audit_log / v3.settings. */
function makeFakeDb(settings = {}) {
  let nextId = 1;
  const events = [];
  const audit = [];
  // { category, is_background } por activity_type_id
  const ATS = {
    [WORK]: { category: 'production_phase', is_background: false, slug: 'production_line' },
    [BREAK]: { category: 'meta', is_background: false, slug: 'break' },
    [LUNCH]: { category: 'meta', is_background: false, slug: 'lunch' },
    [BG]: { category: 'production_phase', is_background: true, slug: 'mixing' },
    [BG2]: { category: 'production_phase', is_background: true, slug: 'formulation' },
    [EOD]: { category: 'meta', is_background: false, slug: 'end_of_day' },
  };

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
    if (/^SELECT started_at, activity_type_id FROM v3\.events WHERE id = \$1/.test(s)) {
      const r = events.find((e) => e.id === params[0]);
      return { rows: r ? [{ started_at: r.started_at, activity_type_id: r.activity_type_id }] : [] };
    }
    if (/^SELECT \* FROM v3\.events WHERE person_id/.test(s)) {
      const r = events.filter((e) => e.person_id === params[0] && e.ended_at == null && e.deleted_at == null)
        .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
      return { rows: r.map((x) => ({ ...x })) };
    }
    if (/^SELECT category, is_background FROM v3\.activity_types/.test(s)) {
      const a = ATS[params[0]];
      return { rows: a != null ? [{ category: a.category, is_background: a.is_background }] : [] };
    }
    if (/^SELECT 1 FROM v3\.activity_types WHERE id = \$1 AND slug = 'end_of_day'/.test(s)) {
      const a = ATS[params[0]];
      return { rows: (a && a.slug === 'end_of_day') ? [{}] : [] };
    }
    if (/^SELECT category FROM v3\.activity_types/.test(s)) {
      // legacy: alguns callers antigos ainda pedem só category
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

  test('break (meta) PAUSA o foreground — invariante nova (Captura A4)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: BREAK, started_at: T(12), actor_type: 'llm_observer' });
    // antes coexistiam (2); agora meta pausa foreground → só o break ativo.
    expect(active(db, 1)).toHaveLength(1);
    expect(active(db, 1)[0].activity_type_id).toBe(BREAK);
    // o WORK foi fechado por 'paused_by_meta' (auditado)
    expect(actions(db)).toContain('event.closed');
  });

  test('lunch PAUSA foreground mas NÃO o background (Captura A4)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: BG, started_at: T(10), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: LUNCH, started_at: T(12), actor_type: 'llm_observer' });
    // foreground (WORK) pausado; background (BG) e lunch continuam abertos.
    const act = active(db, 1);
    expect(act).toHaveLength(2);
    const types = act.map((e) => e.activity_type_id).sort();
    expect(types).toEqual([BG, LUNCH].sort());
  });

  test('meta_pauses_foreground=false desliga a pausa (setting)', async () => {
    const db = makeFakeDb({ meta_pauses_foreground: false });
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: LUNCH, started_at: T(12), actor_type: 'llm_observer' });
    // setting OFF → comportamento antigo (coexistem)
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

  test('ao fechar A, B e C MANTÊM A no cowork_with (histórico) — Captura A3', async () => {
    // Bug do dia 22/mai: _unlinkCoworkOnClose apagava o histórico do lado
    // que fechou depois (ev 120/130/134). Conserto: removeu o unlink;
    // cowork fica histórico bidirecional nos dois lados.
    const db = makeFakeDb();
    const s = svc(db);
    const eB = await s.upsert({ person_id: 2, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    const eC = await s.upsert({ person_id: 3, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    const eA = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), cowork_with: [2, 3], actor_type: 'llm_observer' });
    // antes do close: bidirecional, simétrico
    expect(db.events.find((e) => e.id === eA.id).cowork_with.sort()).toEqual([2, 3]);
    expect(db.events.find((e) => e.id === eB.id).cowork_with.sort()).toEqual([1, 3]);
    expect(db.events.find((e) => e.id === eC.id).cowork_with.sort()).toEqual([1, 2]);
    // A fecha primeiro
    await s.closeActivePersonEvent(1, T(12), 'manual');
    // todos MANTÊM o cowork histórico
    expect(db.events.find((e) => e.id === eA.id).cowork_with.sort()).toEqual([2, 3]);
    expect(db.events.find((e) => e.id === eB.id).cowork_with.sort()).toEqual([1, 3]);
    expect(db.events.find((e) => e.id === eC.id).cowork_with.sort()).toEqual([1, 2]);
  });
});

describe('V3 §2.4 — background vs foreground (Captura Aprimorada A1)', () => {
  test('background NÃO fecha foreground; coexistem', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: BG, started_at: T(10), actor_type: 'llm_observer' });
    expect(active(db, 1)).toHaveLength(2);
  });

  test('foreground nova fecha foreground anterior, NÃO mexe no background', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: BG, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(10), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(11), actor_type: 'llm_observer' });
    const act = active(db, 1);
    expect(act).toHaveLength(2); // bg + 2ª fg; 1ª fg fechou
    expect(act.find((e) => e.activity_type_id === BG)).toBeDefined();
    // a foreground que sobrou é a de T(11)
    const fg = act.find((e) => e.activity_type_id === WORK);
    expect(fg.started_at).toBe(T(11));
  });

  test('múltiplos backgrounds coexistem por pessoa', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: BG, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: BG2, started_at: T(10), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(11), actor_type: 'llm_observer' });
    expect(active(db, 1)).toHaveLength(3); // 2 bg + 1 fg
  });

  test('close nomeado por activity_type_id fecha só o(s) daquele tipo — FIFO se múltiplos', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    // foreground + 2 backgrounds DO MESMO TIPO + estado preparado
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: BG, started_at: T(10), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: BG, started_at: T(11), actor_type: 'llm_observer' });
    expect(active(db, 1)).toHaveLength(3);
    // "F: encapsulação" — close nomeado pelo activity_type_id
    await s.closeActivePersonEvent(1, T(12), 'manual', {
      kind: 'background', activityTypeId: BG, actorType: 'llm_observer',
    });
    const act = active(db, 1);
    // FIFO: o BG mais antigo (T(10)) fechou; o de T(11) e a foreground continuam
    expect(act).toHaveLength(2);
    expect(act.find((e) => e.activity_type_id === WORK)).toBeDefined();
    const remBg = act.find((e) => e.activity_type_id === BG);
    expect(remBg.started_at).toBe(T(11));
  });

  test('close genérico (sem activity_type_id) fecha só foreground; bg sobrevive', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(9), actor_type: 'llm_observer' });
    await s.upsert({ person_id: 1, activity_type_id: BG, started_at: T(10), actor_type: 'llm_observer' });
    await s.closeActivePersonEvent(1, T(12), 'manual', { actorType: 'llm_observer' });
    const act = active(db, 1);
    expect(act).toHaveLength(1);
    expect(act[0].activity_type_id).toBe(BG);
  });

  test('quantity / quantity_unit persistem no upsert', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({
      person_id: 1, activity_type_id: WORK, started_at: T(9),
      quantity: 142, quantity_unit: 'order', actor_type: 'llm_observer',
    });
    expect(db.events.find((e) => e.id === ev.id).quantity).toBe(142);
    expect(db.events.find((e) => e.id === ev.id).quantity_unit).toBe('order');
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
  test('close com ended_at < started_at → clamp ativo, daí o guard dur=0 BLOQUEIA o close', async () => {
    // Comportamento pós-bloco 29/mai-noite #3: o clamp empurra ended_at → started_at,
    // mas o guard dur=0 rejeita o patch resultante (slug WORK != end_of_day).
    // Net: event permanece LIVE. Ambos audits gravados (clamp + close blocked).
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({ person_id: 1, activity_type_id: WORK, started_at: T(14), actor_type: 'llm_observer' });
    // mensagem fora de ordem: fecha às 11h um event que abriu às 14h
    const closed = await s.closeActivePersonEvent(1, T(11), 'manual');
    const row = db.events.find((e) => e.id === ev.id);
    expect(row.ended_at).toBeNull();                // close foi rejeitado pelo guard dur=0
    expect(closed).toEqual([]);                     // nada de fato fechado
    expect(actions(db)).toContain('event.negative_duration_clamped'); // clamp tentou
    expect(actions(db)).toContain('event.close_blocked_dur_zero');    // guard bloqueou
    expect(active(db, 1)).toHaveLength(1);          // event continua LIVE
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

describe('V3 §2.4 — end_of_day instantâneo (bloco 28/mai noite #32)', () => {
  test('end_of_day fecha o próprio event imediatamente: ended_at = started_at', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({
      person_id: 1, activity_type_id: EOD, started_at: T(18),
      actor_type: 'llm_observer',
    });
    expect(ev.ended_at).toBe(T(18));
    expect(ev.closed_reason).toBe('end_of_day');
  });

  test('end_of_day fecha foreground LIVE da mesma pessoa com closed_reason=end_of_day', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    // FG live aberto desde 14h
    const fg = await s.upsert({
      person_id: 1, activity_type_id: WORK, started_at: T(14),
      actor_type: 'llm_observer',
    });
    expect(fg.ended_at).toBeNull();
    // EOD às 18h
    await s.upsert({
      person_id: 1, activity_type_id: EOD, started_at: T(18),
      actor_type: 'llm_observer',
    });
    const fgAfter = db.events.find((e) => e.id === fg.id);
    expect(fgAfter.ended_at).toBe(T(18));
    expect(fgAfter.closed_reason).toBe('end_of_day');
  });

  test('end_of_day NÃO fecha background LIVE (long_running ou single-day)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    // BG live aberto desde 12h
    const bg = await s.upsert({
      person_id: 1, activity_type_id: BG, started_at: T(12),
      actor_type: 'llm_observer',
    });
    expect(bg.ended_at).toBeNull();
    // EOD às 18h
    await s.upsert({
      person_id: 1, activity_type_id: EOD, started_at: T(18),
      actor_type: 'llm_observer',
    });
    const bgAfter = db.events.find((e) => e.id === bg.id);
    expect(bgAfter.ended_at).toBeNull();   // bg continua LIVE
  });

  test('end_of_day NÃO afeta foreground de OUTRA pessoa', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const fgOther = await s.upsert({
      person_id: 2, activity_type_id: WORK, started_at: T(14),
      actor_type: 'llm_observer',
    });
    await s.upsert({
      person_id: 1, activity_type_id: EOD, started_at: T(18),
      actor_type: 'llm_observer',
    });
    const after = db.events.find((e) => e.id === fgOther.id);
    expect(after.ended_at).toBeNull();   // outra pessoa não afetada
  });
});

describe('V3 §2.4 — guard dur=0 non-eod (bloco 29/mai-noite #3)', () => {
  test('INSERT bloqueia ended_at == started_at em foreground; audit gravado', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({
      person_id: 1, activity_type_id: WORK,
      started_at: T(10), ended_at: T(10),     // dur=0
      actor_type: 'llm_observer',
    });
    expect(ev).toBeNull();
    expect(db.events).toHaveLength(0);
    expect(actions(db)).toContain('event.insert_blocked_dur_zero');
  });

  test('INSERT bloqueia dur=0 em background também (qualquer non-eod)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({
      person_id: 1, activity_type_id: BG,
      started_at: T(11), ended_at: T(11),
      actor_type: 'llm_observer',
    });
    expect(ev).toBeNull();
    expect(actions(db)).toContain('event.insert_blocked_dur_zero');
  });

  test('INSERT PERMITE ended_at == started_at quando slug=end_of_day', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({
      person_id: 1, activity_type_id: EOD,
      started_at: T(18),                       // sem ended_at — upsert preenche com end_of_day rule
      actor_type: 'llm_observer',
    });
    expect(ev).not.toBeNull();
    expect(ev.ended_at).toBe(T(18));          // dur=0 LEGÍTIMO pra eod
    expect(ev.closed_reason).toBe('end_of_day');
  });

  test('PATCH (via _closeActive) bloqueia quando 2 opens têm mesmo started_at', async () => {
    // Reproduz o caso ev316/ev317 29/mai: 1ª open cria event LIVE; 2ª open
    // com mesmo started_at dispararia _closeActive que zeraria a duração.
    // Com guard: PRIMEIRO event permanece LIVE, segundo entra normalmente.
    const db = makeFakeDb();
    const s = svc(db);
    const first = await s.upsert({
      person_id: 1, activity_type_id: WORK, started_at: T(11),
      actor_type: 'llm_observer', source_message_ts: 'm1',
    });
    expect(first.ended_at).toBeNull();
    const second = await s.upsert({
      person_id: 1, activity_type_id: WORK, started_at: T(11),
      actor_type: 'llm_observer', source_message_ts: 'm1#a1',
    });
    expect(second).not.toBeNull();
    // first deve continuar LIVE (não fechado em dur=0)
    const firstAfter = db.events.find((e) => e.id === first.id);
    expect(firstAfter.ended_at).toBeNull();
    expect(actions(db)).toContain('event.close_blocked_dur_zero');
  });

  test('correct(ended_at=started_at) lança erro claro em non-eod', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({
      person_id: 1, activity_type_id: WORK, started_at: T(9),
      actor_type: 'llm_observer',
    });
    await expect(s.correct(ev.id, { ended_at: T(9) }, null, 'tentativa', 'admin'))
      .rejects.toThrow(/dur=0/);
  });

  test('correct(ended_at=started_at) PERMITE em end_of_day', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({
      person_id: 1, activity_type_id: EOD, started_at: T(18),
      actor_type: 'llm_observer',
    });
    // já é dur=0; outro correct igual deve passar (idempotente)
    const after = await s.correct(ev.id, { ended_at: T(18) }, null, 'reapply', 'admin');
    expect(after).not.toBeNull();
    expect(after.ended_at).toBe(T(18));
  });

  test('PATCH negative-duration clamp ainda funciona (não é o mesmo do guard)', async () => {
    // Quando ended_at < started_at, clamp pro started_at = dur=0.
    // Pré-fix, isso ficava como dur=0 (ruim). Pós-fix, AINDA clampa (preserva
    // semântica antiga), MAS o guard dur=0 vai bloquear se o resultado é
    // exact match.  Net result: ended_at ainda fica NULL (caller pega null).
    const db = makeFakeDb();
    const s = svc(db);
    const ev = await s.upsert({
      person_id: 1, activity_type_id: WORK, started_at: T(11),
      actor_type: 'llm_observer',
    });
    // tenta close em T(10) (antes do started T(11)) → clamp pra T(11)
    // → vai bater no guard dur=0 → patch rejected
    await s.closeActivePersonEvent(1, T(10), 'manual', 'foreground', 'admin');
    const after = db.events.find((e) => e.id === ev.id);
    // event AINDA está LIVE porque o clamp+guard bloqueou o close
    expect(after.ended_at).toBeNull();
  });
});
