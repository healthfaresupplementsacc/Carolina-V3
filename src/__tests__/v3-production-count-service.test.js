'use strict';
// HEALTHFARE V3 — PARTE 2.6 — testes comportamentais do ProductionCountService.
const { ProductionCountService } = require('../v3/services/ProductionCountService');

/** Fake in-memory de v3.production_counts / v3.audit_log. */
function makeFakeDb() {
  let nextId = 1;
  const counts = [];
  const audit = [];

  function run(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    if (/^INSERT INTO v3\.production_counts \(/.test(s)) {
      const cols = s.match(/\(([^)]+)\)/)[1].split(',').map((x) => x.trim());
      const row = {
        id: nextId++, superseded_by: null, deleted_at: null, deleted_by: null,
        created_at: new Date(), updated_at: new Date(),
      };
      cols.forEach((c, i) => { row[c] = params[i]; });
      counts.push(row);
      return { rows: [{ ...row }] };
    }
    if (/^UPDATE v3\.production_counts SET /.test(s)) {
      const setPart = s.match(/SET ([\s\S]+) WHERE id = \$1/)[1];
      const row = counts.find((c) => c.id === params[0]);
      if (!row) return { rows: [] };
      for (const a of setPart.split(',').map((x) => x.trim())) {
        if (a.startsWith('updated_at')) { row.updated_at = new Date(); continue; }
        const m = a.match(/^(\w+) = \$(\d+)$/);
        if (m) row[m[1]] = params[Number(m[2]) - 1];
      }
      return { rows: [{ ...row }] };
    }
    if (/^SELECT \* FROM v3\.production_counts WHERE id = \$1/.test(s)) {
      const r = counts.find((c) => c.id === params[0]);
      return { rows: r ? [{ ...r }] : [] };
    }
    if (/^SELECT \* FROM v3\.production_counts WHERE source_message_ts/.test(s)) {
      const r = counts.filter((c) => c.source_message_ts === params[0] && c.deleted_at == null)
        .sort((a, b) => a.id - b.id);
      return { rows: r.slice(0, 1).map((x) => ({ ...x })) };
    }
    if (/^SELECT \* FROM v3\.production_counts WHERE product_batch_id/.test(s)) {
      const r = counts.filter((c) => c.product_batch_id === params[0]
        && c.superseded_by == null && c.deleted_at == null);
      return { rows: r.map((x) => ({ ...x })) };
    }
    if (/^SELECT \* FROM v3\.production_counts WHERE product_id/.test(s)) {
      const r = counts.filter((c) => c.product_id === params[0] && c.production_date === params[1]
        && c.superseded_by == null && c.deleted_at == null);
      return { rows: r.map((x) => ({ ...x })) };
    }
    // Bloco 2 — detecção de duplicata (mesmo produto/dia, mesmo valor, batch
    // COMPATÍVEL: igual OU um dos dois null). Bruno 07-23: pega /op-com-lote vs
    // Slack-sem-lote. Ordena por id DESC (mais recente primeiro).
    if (/^SELECT id, source_event_id.*FROM\s+v3\.production_counts\s+WHERE product_id = \$1 AND bottles = \$2/s.test(s)) {
      const r = counts.filter((c) => c.product_id === params[0]
        && Number(c.bottles) === Number(params[1]) && c.production_date === params[2]
        && (c.product_batch_id == null || params[3] == null || c.product_batch_id === params[3])
        && c.superseded_by == null && c.deleted_at == null && c.possible_duplicate_of == null)
        .sort((a, b) => b.id - a.id);
      return { rows: r.length ? [{ ...r[0] }] : [] };
    }
    // incidente de dados (mock: só devolve id fake)
    if (/^INSERT INTO v3\.data_incidents/.test(s)) return { rows: [{ id: 1 }] };
    if (/^SELECT canonical_name FROM v3\.products/.test(s)) return { rows: [{ canonical_name: 'Produto' }] };
    if (/^SELECT display_name FROM v3\.persons/.test(s)) return { rows: [{ display_name: 'Fulano' }] };
    if (/^INSERT INTO v3\.audit_log/.test(s)) {
      audit.push({ actor_type: params[0], action: params[2], target_id: params[3] });
      return { rows: [] };
    }
    return { rows: [] };
  }

  const db = {
    counts, audit,
    query: jest.fn((sql, p) => Promise.resolve(run(sql, p))),
  };
  db.connect = () => Promise.resolve({ query: db.query, release: () => {} });
  return db;
}

const svc = (db) => new ProductionCountService({ db });
const DAY = '2026-05-20';
const base = (over = {}) => Object.assign({
  product_id: 5, product_batch_id: 1, bottles: 100, production_date: DAY,
  reported_by_person_id: 6, reported_at: '2026-05-20T18:00:00.000Z', actor_type: 'llm_observer',
}, over);
const auditActions = (db) => db.audit.map((a) => a.action);

describe('V3 §2.6 — record', () => {
  test('cria contagem', async () => {
    const db = makeFakeDb();
    const c = await svc(db).record(base({ bottles: 684 }));
    expect(c.id).toBeDefined();
    expect(c.bottles).toBe(684);
    expect(db.counts).toHaveLength(1);
  });

  test('product_batch_id NULL é permitido (batch ambíguo)', async () => {
    const db = makeFakeDb();
    const c = await svc(db).record(base({ product_batch_id: null }));
    expect(c.product_batch_id).toBeNull();
  });

  test('idempotente por source_message_ts — não duplica', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const c1 = await s.record(base({ source_message_ts: 'm1', bottles: 300 }));
    const c2 = await s.record(base({ source_message_ts: 'm1', bottles: 999 }));
    expect(c2.id).toBe(c1.id);
    expect(c2.bottles).toBe(300); // a 1ª prevalece
    expect(db.counts).toHaveLength(1);
  });

  test('bottles negativo → rejeita', async () => {
    await expect(svc(makeFakeDb()).record(base({ bottles: -5 }))).rejects.toThrow(/bottles inválido/);
  });

  test('product_id / reported_by / production_date obrigatórios', async () => {
    const db = makeFakeDb();
    await expect(svc(db).record(base({ product_id: null }))).rejects.toThrow(/product_id/);
    await expect(svc(db).record(base({ reported_by_person_id: null }))).rejects.toThrow(/reported_by/);
    await expect(svc(db).record(base({ production_date: null }))).rejects.toThrow(/production_date/);
  });
});

describe('V3 §2.6 — supersede', () => {
  test('cria nova row + marca a antiga com superseded_by', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const a = await s.record(base({ bottles: 684 }));
    const b = await s.supersede(a.id, 720, 99, 'corrigido pelo Bruno');
    expect(b.bottles).toBe(720);
    expect(b.id).not.toBe(a.id);
    expect(db.counts.find((c) => c.id === a.id).superseded_by).toBe(b.id);
  });

  test('preserva a antiga (NÃO deleta)', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const a = await s.record(base({ bottles: 684 }));
    await s.supersede(a.id, 720, 99);
    const old = db.counts.find((c) => c.id === a.id);
    expect(old).toBeDefined();
    expect(old.deleted_at).toBeNull();
    expect(old.bottles).toBe(684); // valor histórico intacto
  });

  test('chain A→B→C: só C conta no total', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const a = await s.record(base({ bottles: 100 }));
    const b = await s.supersede(a.id, 200, 99);
    await s.supersede(b.id, 300, 99);
    expect(await s.totalForBatch(1)).toBe(300);
    expect(db.counts).toHaveLength(3); // A, B, C preservados
  });

  test('supersede de count já-superseded → erro', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const a = await s.record(base({ bottles: 100 }));
    await s.supersede(a.id, 200, 99);
    await expect(s.supersede(a.id, 300, 99)).rejects.toThrow(/já foi superseded/);
  });

  test('bottles negativo no supersede → rejeita', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const a = await s.record(base({ bottles: 100 }));
    await expect(s.supersede(a.id, -1, 99)).rejects.toThrow(/bottles inválido/);
  });
});

describe('V3 §2.6 — listas e totais', () => {
  test('listForBatch exclui superseded', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const a = await s.record(base({ bottles: 100 }));
    await s.supersede(a.id, 200, 99);
    const list = await s.listForBatch(1);
    expect(list).toHaveLength(1);
    expect(list[0].bottles).toBe(200);
  });

  test('totalForBatch soma só não-superseded', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.record(base({ bottles: 684 }));
    await s.record(base({ bottles: 196 }));
    expect(await s.totalForBatch(1)).toBe(880);
  });

  test('totalForBatch batch vazio = 0', async () => {
    expect(await svc(makeFakeDb()).totalForBatch(999)).toBe(0);
  });

  test('listForProductDay / totalForProductDay excluem superseded', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const a = await s.record(base({ bottles: 300 }));
    await s.supersede(a.id, 684, 99);
    await s.record(base({ bottles: 196 }));
    const list = await s.listForProductDay(5, DAY);
    expect(list).toHaveLength(2);
    expect(await s.totalForProductDay(5, DAY)).toBe(880); // 684 + 196
  });
});

describe('V3 §2.6 — reassign / soft delete / restore / audit', () => {
  test('reassign move o count pra outro batch', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const a = await s.record(base({ product_batch_id: 1, bottles: 100 }));
    const r = await s.reassign(a.id, 2, 99);
    expect(r.product_batch_id).toBe(2);
  });

  test('softDelete preserva a row; restore desfaz', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const a = await s.record(base({ bottles: 100 }));
    const del = await s.softDelete(a.id, 99, 'engano');
    expect(del.deleted_at).not.toBeNull();
    expect(db.counts).toHaveLength(1);
    const res = await s.restore(a.id, 99);
    expect(res.deleted_at).toBeNull();
  });

  test('softDelete tira o count dos totais', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const a = await s.record(base({ bottles: 100 }));
    await s.record(base({ bottles: 50 }));
    await s.softDelete(a.id, 99, 'engano');
    expect(await s.totalForBatch(1)).toBe(50);
  });

  test('audit em record/supersede/reassign/delete', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const a = await s.record(base({ bottles: 100 }));
    await s.supersede(a.id, 200, 99);
    const b = db.counts.find((c) => c.id !== a.id);
    await s.reassign(b.id, 2, 99);
    await s.softDelete(b.id, 99, 'x');
    expect(auditActions(db)).toEqual(expect.arrayContaining([
      'count.recorded', 'count.superseded', 'count.reassigned', 'count.deleted',
    ]));
  });
});

describe('V3 Bloco 2 — anti-duplicação (§7.6)', () => {
  test('mesmo número 2x p/ mesmo produto/lote/dia → 2ª marca possible_duplicate_of', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const c1 = await s.record(base({ bottles: 568, source_message_ts: 'm1' }));
    const c2 = await s.record(base({ bottles: 568, source_message_ts: 'm2' }));
    expect(c1.possible_duplicate_of).toBeNull();    // 1ª não é suspeita
    expect(c2.possible_duplicate_of).toBe(c1.id);   // 2ª aponta pra 1ª
    // não somou, não rejeitou — as duas existem
    expect(db.counts).toHaveLength(2);
  });

  test('números diferentes p/ mesmo lote → nenhuma marca de duplicata', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    const c1 = await s.record(base({ bottles: 568, source_message_ts: 'm1' }));
    const c2 = await s.record(base({ bottles: 723, source_message_ts: 'm2' }));
    expect(c1.possible_duplicate_of).toBeNull();
    expect(c2.possible_duplicate_of).toBeNull();
  });

  test('unit é gravado (bottle/box/uncertain)', async () => {
    const db = makeFakeDb();
    const c = await svc(db).record(base({ bottles: 30, unit: 'box', source_message_ts: 'm1' }));
    expect(c.unit).toBe('box');
  });

  test('confirmNotDuplicate limpa a marca (admin: "é adicional")', async () => {
    const db = makeFakeDb();
    const s = svc(db);
    await s.record(base({ bottles: 568, source_message_ts: 'm1' }));
    const c2 = await s.record(base({ bottles: 568, source_message_ts: 'm2' }));
    expect(c2.possible_duplicate_of).not.toBeNull();
    const cleared = await s.confirmNotDuplicate(c2.id, 99);
    expect(cleared.possible_duplicate_of).toBeNull(); // entra na soma do realizado
    expect(auditActions(db)).toContain('count.confirmed_not_duplicate');
  });
});
