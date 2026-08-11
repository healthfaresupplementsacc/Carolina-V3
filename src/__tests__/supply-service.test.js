'use strict';
const { SupplyService } = require('../v3/services/SupplyService');

// In-memory fake pg: supports the small set of queries SupplyService issues.
function fakeDb(state) {
  const run = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
    // idempotency lookup
    if (/SELECT id, supply_item_id, qty FROM v3.supply_movements WHERE source/.test(s)) {
      const [source, ref] = params;
      const m = state.movements.find((x) => x.source === source && x.source_ref === ref);
      return { rows: m ? [{ id: m.id, supply_item_id: m.supply_item_id, qty: m.qty }] : [] };
    }
    // size → supply
    if (/FROM v3.package_size_supply m/.test(s)) {
      const size = params[0];
      const map = state.map[size];
      if (!map) return { rows: [] };
      const it = state.items[map.supply_item_id];
      return { rows: [{ package_size: size, qty_per: map.qty_per, supply_item_id: it.id, name: it.name, qty: it.qty, min_qty: it.min_qty, active: true }] };
    }
    // FOR UPDATE current item
    if (/SELECT id, name, qty, min_qty FROM v3.supply_items WHERE id=\$1 FOR UPDATE/.test(s)) {
      const it = state.items[params[0]];
      return { rows: it ? [{ id: it.id, name: it.name, qty: it.qty, min_qty: it.min_qty }] : [] };
    }
    if (/INSERT INTO v3.supply_movements/.test(s)) {
      // params order differs by call; capture kind+item+qty generically
      state.movements.push({ id: state.movements.length + 1, kind: params[0], supply_item_id: params[1], qty: params[2], source: params[params.length - 4] || params[4], source_ref: params[params.length - 3] });
      return { rows: [] };
    }
    if (/UPDATE v3.supply_items SET qty=\$2/.test(s)) {
      state.items[params[0]].qty = params[1];
      return { rows: [] };
    }
    throw new Error('unhandled sql: ' + s);
  };
  return { query: run };  // no .connect → SupplyService uses db directly as client
}

function setup(overrides = {}) {
  const state = {
    items: { 1: { id: 1, name: 'Envelope A', qty: 1000, min_qty: 200 }, 2: { id: 2, name: 'Envelope Y', qty: 5, min_qty: 3 } },
    map: { A: { supply_item_id: 1, qty_per: 1 }, Y: { supply_item_id: 2, qty_per: 1 } },
    movements: [],
    ...overrides,
  };
  const lows = []; const discs = [];
  const svc = new SupplyService({ db: fakeDb(state), onLow: async (x) => lows.push(x), onDiscrepancy: async (x) => discs.push(x) });
  return { svc, state, lows, discs };
}

describe('SupplyService', () => {
  test('consume por tamanho deduz 1 do supply mapeado (1000→999)', async () => {
    const { svc, state } = setup();
    const r = await svc.consumeForSize({ size: 'A', source_ref: 'label:1' });
    expect(r.applied).toBe(1);
    expect(r.qty_after).toBe(999);
    expect(state.items[1].qty).toBe(999);
  });

  test('idempotente: a MESMA label não deduz 2×', async () => {
    const { svc, state } = setup();
    await svc.consumeForSize({ size: 'A', source_ref: 'label:7' });
    const again = await svc.consumeForSize({ size: 'A', source_ref: 'label:7' });
    expect(again.idempotent).toBe(true);
    expect(state.items[1].qty).toBe(999);   // não caiu pra 998
  });

  test('white bottle (Envelope Y) 5→4 e dispara alerta de baixo ao cruzar min=3', async () => {
    const { svc, state, lows } = setup();
    await svc.consumeForSize({ size: 'Y', source_ref: 'l1' });  // 5→4
    expect(lows).toHaveLength(0);
    await svc.consumeForSize({ size: 'Y', source_ref: 'l2' });  // 4→3 (cruza min=3)
    expect(state.items[2].qty).toBe(3);
    expect(lows).toHaveLength(1);
    expect(lows[0].item).toBe('Envelope Y');
    expect(lows[0].qty).toBe(3);
  });

  test('REGRA #0: nunca fica negativo; avisa discrepância quando estoque estoura', async () => {
    const { svc, state, discs } = setup({ items: { 3: { id: 3, name: 'Envelope A', qty: 0, min_qty: 0 } }, map: { A: { supply_item_id: 3, qty_per: 1 } }, movements: [] });
    const r = await svc.consumeForSize({ size: 'A', source_ref: 'x1' });
    expect(r.applied).toBe(0);
    expect(state.items[3].qty).toBe(0);          // não foi pra -1
    expect(discs.some((d) => /insuficiente/.test(d.note))).toBe(true);
  });

  test('tamanho sem supply mapeado → não deduz, avisa unmapped', async () => {
    const { svc, discs } = setup();
    const r = await svc.consumeForSize({ size: 'ZZZ', source_ref: 'q' });
    expect(r.unmapped).toBe(true);
    expect(r.applied).toBe(0);
    expect(discs.some((d) => /sem supply/.test(d.note))).toBe(true);
  });

  test('restock soma; count seta absoluto', async () => {
    const { svc, state } = setup();
    await svc.change({ supply_item_id: 1, kind: 'restock', qty: 500 });
    expect(state.items[1].qty).toBe(1500);
    await svc.change({ supply_item_id: 1, kind: 'count', qty: 42 });
    expect(state.items[1].qty).toBe(42);
  });
});
