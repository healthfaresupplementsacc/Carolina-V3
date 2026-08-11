'use strict';
/**
 * StockService — as garantias que fazem "estoque SEMPRE sincronizado":
 *  1. idempotência: mesma (source, source_ref) duas vezes = UM movimento, UMA dedução
 *  2. transação: movimento + qty na mesma tx (rollback conjunto)
 *  3. floor em 0 + onDiscrepancy quando o bin não tem o suficiente (REGRA #0: avisa, não trava)
 *  4. restock move caixa→bin e esvazia caixa; contagem divergente vira 'count' + discrepância
 *  5. damaged deduz o bin e abre stock_issue
 * DB mockado com um mini-motor em memória que entende as queries do service —
 * shape REAL das tabelas 058/060 ([[smoke-must-match-real-backend]]).
 */
const { StockService } = require('../v3/services/StockService');

/** Mini-DB em memória: interpreta as queries específicas do StockService. */
function makeDb() {
  const state = {
    movements: [], bins: new Map(), boxes: new Map(), issues: [], audit: [],
    nextId: 1, inTx: false, failNextUpdate: false,
  };
  const clone = (o) => (o ? { ...o } : o);
  const api = {
    state,
    async connect() { return api; },
    release() {},
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      if (q === 'BEGIN') { state.inTx = true; state._snapshot = JSON.stringify({ m: state.movements, i: state.issues, b: [...state.bins], x: [...state.boxes] }); return {}; }
      if (q === 'COMMIT') { state.inTx = false; state._snapshot = null; return {}; }
      if (q === 'ROLLBACK') {
        if (state._snapshot) {
          const s = JSON.parse(state._snapshot);
          state.movements = s.m; state.issues = s.i;
          state.bins = new Map(s.b); state.boxes = new Map(s.x);
        }
        state.inTx = false; return {};
      }
      if (q.startsWith('SELECT * FROM v3.stock_movements WHERE source')) {
        const found = state.movements.find((m) => m.source === params[0] && m.source_ref === params[1]);
        return { rows: found ? [clone(found)] : [], rowCount: found ? 1 : 0 };
      }
      if (q.startsWith('INSERT INTO v3.stock_movements')) {
        const [kind, product_id, qty, bin_id, box_id, person_id, source, source_ref] = params;
        if (source_ref && state.movements.some((m) => m.source === source && m.source_ref === source_ref)) {
          return { rows: [], rowCount: 0 };  // ON CONFLICT DO NOTHING
        }
        const row = { id: state.nextId++, kind, product_id, qty, bin_id, box_id, person_id, source, source_ref, note: params[9], is_test: params[10] };
        state.movements.push(row);
        return { rows: [clone(row)], rowCount: 1 };
      }
      if (/SELECT \* FROM v3\.stock_bins WHERE id = \$1/.test(q)) {
        const b = state.bins.get(params[0]);
        if (!b) return { rows: [] };
        return { rows: [clone(b)] };
      }
      if (/SELECT \* FROM v3\.stock_bins WHERE product_id = \$1/.test(q)) {
        const cands = [...state.bins.values()].filter((b) => b.product_id === params[0] && b.active !== false)
          .sort((a, b) => b.qty - a.qty);
        return { rows: cands.length ? [clone(cands[0])] : [] };
      }
      if (/SELECT \* FROM v3\.stock_boxes WHERE id = \$1/.test(q)) {
        const b = state.boxes.get(params[0]);
        if (!b) return { rows: [] };
        return { rows: [clone(b)] };
      }
      if (q.startsWith('UPDATE v3.stock_bins SET qty')) {
        if (state.failNextUpdate) { state.failNextUpdate = false; throw new Error('boom (teste de rollback)'); }
        const b = state.bins.get(params[0]); if (b) b.qty = params[1];
        return {};
      }
      if (q.startsWith('UPDATE v3.stock_bins SET product_id')) {
        const b = state.bins.get(params[0]); if (b) b.product_id = params[1];
        return {};
      }
      if (q.startsWith('UPDATE v3.stock_boxes SET qty')) {
        const b = state.boxes.get(params[0]);
        if (b) { b.qty = params[1]; b.status = params[2]; }
        return {};
      }
      if (q.startsWith('UPDATE v3.stock_boxes SET product_id')) {
        const b = state.boxes.get(params[0]); if (b) b.product_id = params[1];
        return {};
      }
      if (q.startsWith('INSERT INTO v3.stock_issues')) {
        const row = { id: state.nextId++, product_id: params[0], qty: params[1], reason: params[2], bin_id: params[3], person_id: params[4], note: params[5], is_test: params[6], status: 'separated' };
        state.issues.push(row);
        return { rows: [clone(row)] };
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push({ action: params[2] }); return {}; }
      throw new Error('query não mapeada no mock: ' + q.slice(0, 90));
    },
  };
  return api;
}

function svc(db, onDiscrepancy) { return new StockService({ db, onDiscrepancy }); }

describe('StockService', () => {
  test('pick é idempotente: mesma source_ref 2x = 1 movimento, 1 dedução', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 50, active: true });
    const s = svc(db);
    const r1 = await s.pick({ product_id: 10, qty: 5, source: 'veeqo_ship', source_ref: '123:9' });
    const r2 = await s.pick({ product_id: 10, qty: 5, source: 'veeqo_ship', source_ref: '123:9' });
    expect(r1.duplicate).toBe(false);
    expect(r1.applied).toBe(5);
    expect(r2.duplicate).toBe(true);
    expect(r2.applied).toBe(0);
    expect(db.state.bins.get(1).qty).toBe(45);            // deduziu UMA vez
    expect(db.state.movements.filter((m) => m.kind === 'pick').length).toBe(1);
  });

  test('pick sem estoque suficiente: floor em 0 + onDiscrepancy (avisa, não trava)', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 3, active: true });
    const flags = [];
    const s = svc(db, async (d) => flags.push(d));
    const r = await s.pick({ product_id: 10, qty: 8, source: 'veeqo_ship', source_ref: '77:1' });
    expect(r.applied).toBe(3);                            // deduziu o que tinha
    expect(db.state.bins.get(1).qty).toBe(0);             // nunca negativo
    expect(flags.length).toBe(1);
    expect(flags[0].kind).toBe('insufficient_stock');
    expect(flags[0].wanted).toBe(8);
    expect(flags[0].applied).toBe(3);
  });

  test('storeIn falhando no meio: rollback conjunto (nem movimento nem qty)', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 10, active: true });
    db.state.failNextUpdate = true;                       // UPDATE do bin explode
    const s = svc(db);
    await expect(s.storeIn({ product_id: 10, qty: 5, bin_id: 1, person_id: 2 })).rejects.toThrow('boom');
    expect(db.state.movements.length).toBe(0);            // movimento não sobreviveu
    expect(db.state.bins.get(1).qty).toBe(10);            // qty intacto
  });

  test('restock: caixa→bin, caixa esvazia → status empty', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 2, min_qty: 10, active: true });
    db.state.boxes.set(5, { id: 5, box_number: 'BOX-045', product_id: 10, qty: 30, status: 'in_storage' });
    const s = svc(db);
    const r = await s.restock({ bin_id: 1, box_id: 5, qty: 30, person_id: 2 });
    expect(r.applied).toBe(30);
    expect(r.bin_now).toBe(32);
    expect(r.box_left).toBe(0);
    expect(db.state.boxes.get(5).status).toBe('empty');   // caixa vazia marcada
  });

  test('restock com contagem divergente: vira count + discrepância, e usa o ENCONTRADO', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 8, active: true });
    db.state.boxes.set(5, { id: 5, box_number: 'BOX-045', product_id: 10, qty: 40, status: 'in_storage' });
    const flags = [];
    const s = svc(db, async (d) => flags.push(d));
    // operador achou só 3 no bin (sistema dizia 8) e 38 na caixa (sistema dizia 40)
    const r = await s.restock({ bin_id: 1, box_id: 5, qty: 20, person_id: 2, found_bin_qty: 3, found_box_qty: 38 });
    expect(r.applied).toBe(20);
    expect(db.state.bins.get(1).qty).toBe(23);            // 3 (encontrado) + 20
    expect(db.state.boxes.get(5).qty).toBe(18);           // 38 (encontrado) − 20
    const counts = db.state.movements.filter((m) => m.kind === 'count');
    expect(counts.length).toBe(2);                        // bin + caixa reconciliados
    expect(flags.filter((f) => f.kind === 'count_variance').length).toBe(2);
  });

  test('damaged: deduz o bin e abre issue "separated"', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 12, active: true });
    const s = svc(db);
    const r = await s.damaged({ product_id: 10, qty: 2, reason: 'seal', person_id: 3 });
    expect(r.applied).toBe(2);
    expect(db.state.bins.get(1).qty).toBe(10);
    expect(db.state.issues.length).toBe(1);
    expect(db.state.issues[0].status).toBe('separated');
    expect(db.state.issues[0].reason).toBe('seal');
  });

  test('count: qty do bin vira o ENCONTRADO, delta vira movimento', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 20, active: true });
    const flags = [];
    const s = svc(db, async (d) => flags.push(d));
    const r = await s.count({ bin_id: 1, found: 17, person_id: 2 });
    expect(r.applied).toBe(-3);
    expect(db.state.bins.get(1).qty).toBe(17);
    expect(flags[0].kind).toBe('count_variance');
  });

  test('validações: qty inválido / destino faltando rejeitam com erro claro', async () => {
    const db = makeDb();
    const s = svc(db);
    await expect(s.storeIn({ product_id: 1, qty: 0, bin_id: 1 })).rejects.toThrow('qty inválido');
    await expect(s.storeIn({ product_id: 1, qty: 5 })).rejects.toThrow('bin_id ou box_id');
    await expect(s.adjust({ qty: 0, bin_id: 1, note: 'x' })).rejects.toThrow('qty inteiro');
    await expect(s.adjust({ qty: 2, bin_id: 1 })).rejects.toThrow('note');
    await expect(s.count({ bin_id: 1, found: -1 })).rejects.toThrow('found');
  });
});
