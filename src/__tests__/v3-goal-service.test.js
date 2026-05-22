'use strict';
// HEALTHFARE V3 — Bloco 2 — testes comportamentais do GoalService.
const { GoalService, normalizeBatchNumber } = require('../v3/services/GoalService');

/** Fake in-memory de v3.production_goals / v3.audit_log. */
function makeFakeDb() {
  let nextId = 1;
  const goals = [];
  const audit = [];

  function run(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    if (/^INSERT INTO v3\.production_goals/.test(s)) {
      const row = {
        id: nextId++, product_id: params[0], batch_number: params[1],
        expected_quantity: params[2], unit: params[3], destinations: params[4],
        production_date: params[5], source: params[6], source_message_ts: params[7],
        created_by_person_id: params[8], confidence: params[9], notes: params[10],
        superseded_by: null, deleted_at: null, deleted_by: null,
        created_at: new Date(), updated_at: new Date(),
      };
      goals.push(row);
      return { rows: [{ ...row }] };
    }
    if (/^UPDATE v3\.production_goals SET /.test(s)) {
      const setPart = s.match(/SET ([\s\S]+) WHERE id = \$1/)[1];
      const row = goals.find((g) => g.id === params[0]);
      if (!row) return { rows: [] };
      for (const a of setPart.split(',').map((x) => x.trim())) {
        if (a.startsWith('updated_at')) { row.updated_at = new Date(); continue; }
        const m = a.match(/^(\w+) = \$(\d+)$/);
        if (m) row[m[1]] = params[Number(m[2]) - 1];
      }
      return { rows: [{ ...row }] };
    }
    if (/^SELECT \* FROM v3\.production_goals WHERE id = \$1/.test(s)) {
      const r = goals.find((g) => g.id === params[0]);
      return { rows: r ? [{ ...r }] : [] };
    }
    if (/^SELECT \* FROM v3\.production_goals WHERE source_message_ts/.test(s)) {
      const r = goals.filter((g) => g.source_message_ts === params[0]
        && (g.batch_number == null ? params[1] == null : g.batch_number === params[1])
        && g.deleted_at == null).sort((a, b) => a.id - b.id);
      return { rows: r.slice(0, 1).map((x) => ({ ...x })) };
    }
    if (/^INSERT INTO v3\.audit_log/.test(s)) {
      audit.push({ actor_type: params[0], action: params[2], target_id: params[3] });
      return { rows: [] };
    }
    return { rows: [] };
  }

  const db = {
    goals, audit,
    query: jest.fn((sql, p) => Promise.resolve(run(sql, p))),
  };
  db.connect = () => Promise.resolve({ query: db.query, release: () => {} });
  return db;
}

const svc = (db) => new GoalService({ db });
const actions = (db) => db.audit.map((a) => a.action);

describe('V3 Bloco 2 — normalizeBatchNumber', () => {
  test('extrai o grupo numérico final do lote', () => {
    expect(normalizeBatchNumber('BR-2026-0135')).toBe('0135');
    expect(normalizeBatchNumber('Plant (0136)')).toBe('0136');
    expect(normalizeBatchNumber('0142')).toBe('0142');
    expect(normalizeBatchNumber(null)).toBeNull();
  });
});

describe('V3 Bloco 2 — GoalService.record', () => {
  test('cria meta nova; batch_number normalizado', async () => {
    const db = makeFakeDb();
    const g = await svc(db).record({
      product_id: 56, batch_number: 'BR-2026-0135', expected_quantity: 750,
      destinations: [{ dest: 'FBA', qty: 750 }], production_date: '2026-05-19',
      source: 'channel', source_message_ts: '111.1', actor_type: 'llm_observer',
    });
    expect(g.id).toBeDefined();
    expect(g.batch_number).toBe('0135');
    expect(g.expected_quantity).toBe(750);
    expect(actions(db)).toContain('goal.created');
  });

  test('idempotente — mesma mensagem+lote → UPDATE, não duplica', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.record({ batch_number: '0135', expected_quantity: 750, production_date: '2026-05-19',
      source_message_ts: 'm1', actor_type: 'llm_observer' });
    const second = await s.record({ batch_number: '0135', expected_quantity: 800, production_date: '2026-05-19',
      source_message_ts: 'm1', actor_type: 'llm_observer' });
    expect(db.goals).toHaveLength(1);
    expect(second.expected_quantity).toBe(800);
    expect(actions(db)).toContain('goal.updated');
  });

  test('mesma mensagem, LOTES diferentes → 2 metas', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.record({ batch_number: '0135', expected_quantity: 750, production_date: '2026-05-19', source_message_ts: 'm1', actor_type: 'llm_observer' });
    await s.record({ batch_number: '0136', expected_quantity: 750, production_date: '2026-05-19', source_message_ts: 'm1', actor_type: 'llm_observer' });
    expect(db.goals).toHaveLength(2);
  });

  test('expected_quantity e production_date obrigatórios', async () => {
    const db = makeFakeDb();
    await expect(svc(db).record({ production_date: '2026-05-19', actor_type: 'system' }))
      .rejects.toThrow(/expected_quantity/);
    await expect(svc(db).record({ expected_quantity: 100, actor_type: 'system' }))
      .rejects.toThrow(/production_date/);
  });

  test('actor_type inválido → erro defensivo', async () => {
    const db = makeFakeDb();
    await expect(svc(db).record({ expected_quantity: 1, production_date: '2026-05-19', actor_type: 'hacker' }))
      .rejects.toThrow(/actor_type inválido/);
  });
});

describe('V3 Bloco 2 — GoalService.correct / softDelete', () => {
  test('correct edita campos permitidos e audita', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const g = await s.record({ batch_number: '0135', expected_quantity: 750, production_date: '2026-05-19', actor_type: 'admin' });
    const after = await s.correct(g.id, { expected_quantity: 900 }, 1, 'ajuste');
    expect(after.expected_quantity).toBe(900);
    expect(actions(db)).toContain('goal.corrected');
  });

  test('correct rejeita campo não-corrigível', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const g = await s.record({ batch_number: '0135', expected_quantity: 750, production_date: '2026-05-19', actor_type: 'admin' });
    await expect(s.correct(g.id, { id: 999 }, 1)).rejects.toThrow(/não-corrigível/);
  });

  test('softDelete marca deleted_at, não some com a meta', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const g = await s.record({ batch_number: '0135', expected_quantity: 750, production_date: '2026-05-19', actor_type: 'admin' });
    const after = await s.softDelete(g.id, 1, 'duplicada');
    expect(after.deleted_at).toBeTruthy();
    expect(db.goals).toHaveLength(1); // registro fica
    expect(actions(db)).toContain('goal.deleted');
  });
});
