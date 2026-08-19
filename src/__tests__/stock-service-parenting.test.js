'use strict';
/**
 * StockService — SKU PARENTING (Bruno 08-19, S15):
 *  1. moveProduct: todo o estoque do fantasma passa pro pai, como PAR de
 *     movimentos (soma zero: nada é criado nem sumido), idempotente por source_ref
 *  2. overview: produto absorvido não aparece; a linha traz children/sku_count
 *  3. base da família: is_base > avulsa da Veeqo > menor pacote que existir
 *     (o caso 'Apple Cider Vinegar', que só tem "x4 kit", do print do Bruno)
 *
 * Mini-DB em memória com o shape REAL das tabelas (058/060/071/077)
 * ([[smoke-must-match-real-backend]]).
 */
const { StockService } = require('../v3/services/StockService');

function makeDb(seed = {}) {
  const state = {
    products: seed.products || [],
    skus: seed.skus || [],
    bins: seed.bins || [],
    boxes: seed.boxes || [],
    unplaced: new Map(Object.entries(seed.unplaced || {}).map(([k, v]) => [Number(k), v])),
    issues: seed.issues || [],
    movements: [], audit: [], nextId: 1,
  };
  const clone = (o) => (o ? { ...o } : o);
  const api = {
    state,
    async connect() { return api; },
    release() {},
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(q)) return { rows: [] };

      // ── movimentos ─────────────────────────────────────────
      if (q.startsWith('SELECT * FROM v3.stock_movements WHERE source')) {
        const f = state.movements.find((m) => m.source === params[0] && m.source_ref === params[1]);
        return { rows: f ? [clone(f)] : [] };
      }
      if (q.startsWith('INSERT INTO v3.stock_movements')) {
        const [kind, product_id, qty, bin_id, box_id, person_id, source, source_ref] = params;
        if (source_ref && state.movements.some((m) => m.source === source && m.source_ref === source_ref)) {
          return { rows: [] };
        }
        const row = { id: state.nextId++, kind, product_id, qty, bin_id, box_id,
          person_id, source, source_ref, note: params[9] };
        state.movements.push(row);
        return { rows: [clone(row)] };
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) {
        state.audit.push({ action: params[2], target_id: params[3] });
        return { rows: [] };
      }

      // ── moveProduct ────────────────────────────────────────
      if (/FROM v3\.stock_bins WHERE product_id = \$1/.test(q)) {
        return { rows: state.bins.filter((b) => b.product_id === params[0]).map(clone) };
      }
      if (/FROM v3\.stock_boxes WHERE product_id = \$1/.test(q)) {
        return { rows: state.boxes.filter((b) => b.product_id === params[0]).map(clone) };
      }
      if (/UPDATE v3\.stock_bins SET product_id = \$2/.test(q)) {
        const b = state.bins.find((x) => x.id === params[0]); if (b) b.product_id = params[1];
        return { rows: [] };
      }
      if (/UPDATE v3\.stock_boxes SET product_id = \$2/.test(q)) {
        const b = state.boxes.find((x) => x.id === params[0]); if (b) b.product_id = params[1];
        return { rows: [] };
      }
      if (/FROM v3\.stock_unplaced WHERE product_id/.test(q)) {
        const v = state.unplaced.get(params[0]);
        return { rows: v == null ? [] : [{ product_id: params[0], qty: v }] };
      }
      if (/INSERT INTO v3\.stock_unplaced/.test(q)) {
        state.unplaced.set(params[0], Math.max(0, params[1]));
        return { rows: [] };
      }
      if (/UPDATE v3\.stock_issues SET product_id = \$2/.test(q)) {
        state.issues.filter((i) => i.product_id === params[0])
          .forEach((i) => { i.product_id = params[1]; });
        return { rows: [] };
      }

      // ── overview ───────────────────────────────────────────
      if (/FROM v3\.products p/.test(q)) {
        // o filtro do fantasma é o que este teste checa: a query real leva
        // "p.merged_into_product_id IS NULL" no WHERE quando não pedem 1 produto.
        const excludeRetired = /merged_into_product_id IS NULL/.test(q);
        const only = /p\.id = \$1/.test(q) ? params[0] : null;
        const sum = (l, f) => l.reduce((n, x) => n + (Number(f(x)) || 0), 0);
        const rows = state.products
          .filter((p) => (only ? p.id === only : true))
          .filter((p) => (excludeRetired ? p.merged_into_product_id == null : true))
          .map((p) => ({
            product_id: p.id, canonical_name: p.canonical_name, nickname: p.nickname,
            bottle_color: null, merged_into_product_id: p.merged_into_product_id || null,
            shelf_qty: sum(state.bins.filter((b) => b.product_id === p.id && b.active !== false), (b) => b.qty),
            box_qty: sum(state.boxes.filter((b) => b.product_id === p.id && b.status === 'in_storage'), (b) => b.qty),
            unplaced_qty: state.unplaced.get(p.id) || 0,
            reserved: 0, separated: 0, pending_out: 0, pending_in: 0,
            min_units: null, restock_bins: 0, sold_7d: 0, sold_30d: 0,
          }));
        return { rows };
      }
      if (/FROM v3\.stock_bins WHERE active AND product_id IS NOT NULL/.test(q)) {
        return { rows: state.bins.filter((b) => b.active !== false && b.product_id).map(clone) };
      }
      if (/FROM v3\.stock_boxes WHERE status = 'in_storage' AND product_id IS NOT NULL/.test(q)) {
        return { rows: state.boxes.filter((b) => b.status === 'in_storage' && b.product_id).map(clone) };
      }
      if (/FROM v3\.product_skus ORDER BY/.test(q)) return { rows: state.skus.map(clone) };
      throw new Error('query não mapeada no mock: ' + q.slice(0, 110));
    },
  };
  return api;
}

const svc = (db) => new StockService({ db });

/** Fantasma (2) com estoque em bin + caixa + a organizar; pai (1) limpo. */
function seed() {
  return makeDb({
    products: [
      { id: 1, canonical_name: 'AKKERM-INULIN', nickname: 'Akkermansia', merged_into_product_id: null },
      { id: 2, canonical_name: 'AKKERM-INULIN dup', nickname: null, merged_into_product_id: null },
    ],
    skus: [
      { id: 10, product_id: 1, sku: 'AKKERM-INULIN', channel: 'veeqo', units_per_pack: 1, is_base: false },
      { id: 11, product_id: 1, sku: 'AKKERM-INULIN-C3', channel: 'veeqo', units_per_pack: 3, is_base: false },
    ],
    bins: [{ id: 50, product_id: 2, bin_code: 'A01', qty: 40, min_qty: 0, active: true }],
    boxes: [{ id: 60, product_id: 2, box_number: 'BOX-9', qty: 100, status: 'in_storage' }],
    unplaced: { 2: 7 },
    issues: [{ id: 70, product_id: 2, qty: 2, status: 'separated' }],
  });
}

describe('moveProduct: o estoque do fantasma vai pro pai', () => {
  test('bins, caixas, a organizar e Separadas trocam de dono', async () => {
    const db = seed();
    const out = await svc(db).moveProduct({
      from_product_id: 2, to_product_id: 1, source: 'sku_merge', source_ref: 'sku_merge:2:1' });

    expect(out.moved_qty).toBe(147);          // 40 + 100 + 7
    expect(out.bins).toBe(1); expect(out.boxes).toBe(1); expect(out.unplaced).toBe(7);
    expect(db.state.bins[0].product_id).toBe(1);
    expect(db.state.boxes[0].product_id).toBe(1);
    expect(db.state.unplaced.get(1)).toBe(7);
    expect(db.state.unplaced.get(2)).toBe(0);
    expect(db.state.issues[0].product_id).toBe(1);
  });

  test('nada é criado nem sumido: a soma dos movimentos é ZERO', async () => {
    const db = seed();
    await svc(db).moveProduct({ from_product_id: 2, to_product_id: 1,
      source: 'sku_merge', source_ref: 'sku_merge:2:1' });
    expect(db.state.movements.reduce((n, m) => n + m.qty, 0)).toBe(0);
    expect(db.state.movements.length).toBe(6);      // 3 peças × (−origem, +destino)
    expect(db.state.movements.every((m) => m.kind === 'move')).toBe(true);
    // cada peça mantém o lugar físico no movimento (bin/caixa não somem do rastro)
    expect(db.state.movements.filter((m) => m.bin_id === 50).length).toBe(2);
    expect(db.state.movements.filter((m) => m.box_id === 60).length).toBe(2);
  });

  test('idempotente: mesmo source_ref não move de novo', async () => {
    const db = seed();
    const a = await svc(db).moveProduct({ from_product_id: 2, to_product_id: 1,
      source: 'sku_merge', source_ref: 'sku_merge:2:1' });
    const b = await svc(db).moveProduct({ from_product_id: 2, to_product_id: 1,
      source: 'sku_merge', source_ref: 'sku_merge:2:1' });
    expect(a.moved_qty).toBe(147);
    expect(b.moved_qty).toBe(0);
    expect(b.duplicate).toBe(true);
    expect(db.state.movements.length).toBe(6);
    expect(db.state.unplaced.get(1)).toBe(7);       // não dobrou
  });

  test('gera audit e exige source_ref (a idempotência não é opcional)', async () => {
    const db = seed();
    await svc(db).moveProduct({ from_product_id: 2, to_product_id: 1,
      source: 'sku_merge', source_ref: 'sku_merge:2:1' });
    expect(db.state.audit.some((a) => a.action === 'stock.move_product')).toBe(true);
    await expect(svc(db).moveProduct({ from_product_id: 2, to_product_id: 1, source: 'x' }))
      .rejects.toThrow(/source_ref/);
    await expect(svc(db).moveProduct({ from_product_id: 1, to_product_id: 1,
      source: 'x', source_ref: 'y' })).rejects.toThrow(/iguais/);
  });
});

describe('overview: uma linha por produto físico', () => {
  test('produto absorvido não aparece na lista', async () => {
    const db = seed();
    db.state.products[1].merged_into_product_id = 1;
    const rows = await svc(db).overview();
    expect(rows.map((r) => r.product_id)).toEqual([1]);
  });

  test('pedindo o produto por id, o absorvido vem (a ficha existe)', async () => {
    const db = seed();
    db.state.products[1].merged_into_product_id = 1;
    const rows = await svc(db).overview({ product_id: 2 });
    expect(rows.length).toBe(1);
    expect(rows[0].retired).toBe(true);
    expect(rows[0].merged_into_product_id).toBe(1);
  });

  test('a linha traz base, children e sku_count', async () => {
    const db = seed();
    const r = (await svc(db).overview({ product_id: 1 }))[0];
    expect(r.base_sku).toBe('AKKERM-INULIN');
    expect(r.base_units_per_pack).toBe(1);
    expect(r.sku_count).toBe(2);
    expect(r.children.map((c) => c.sku)).toEqual(['AKKERM-INULIN-C3']);
    expect(r.children[0].units_per_pack).toBe(3);
    expect(r.retired).toBe(false);
    expect(r.veeqo_total).toBeNull();      // quem preenche é o router (cache Veeqo)
  });

  test('família SÓ com kit: a base é o menor pacote (Apple Cider Vinegar do print)', async () => {
    const db = makeDb({
      products: [{ id: 5, canonical_name: 'Apple Cider Vinegar', nickname: null,
        merged_into_product_id: null }],
      skus: [{ id: 20, product_id: 5, sku: 'ACV-X4', channel: 'veeqo', units_per_pack: 4, is_base: false }],
    });
    const r = (await svc(db).overview())[0];
    expect(r.base_sku).toBe('ACV-X4');
    expect(r.base_units_per_pack).toBe(4);    // avisa que não existe avulsa
    expect(r.children).toEqual([]);
  });

  test('is_base marcado por humano ganha da dedução', async () => {
    const db = makeDb({
      products: [{ id: 6, canonical_name: 'Beet Root 2000mg', nickname: null,
        merged_into_product_id: null }],
      skus: [
        { id: 30, product_id: 6, sku: 'BEET-2000', channel: 'veeqo', units_per_pack: 1, is_base: false },
        { id: 31, product_id: 6, sku: 'BEET-ALT', channel: 'veeqo', units_per_pack: 1, is_base: true },
      ],
    });
    const r = (await svc(db).overview())[0];
    expect(r.base_sku).toBe('BEET-ALT');
    expect(r.children.map((c) => c.sku)).toEqual(['BEET-2000']);
  });

  test('produto sem SKU nenhum não quebra (Banaba Leaf 3000mg do print)', async () => {
    const db = makeDb({
      products: [{ id: 7, canonical_name: 'Banaba Leaf 3000mg', nickname: null,
        merged_into_product_id: null }],
    });
    const r = (await svc(db).overview())[0];
    expect(r.base_sku).toBeNull();
    expect(r.sku_count).toBe(0);
    expect(r.children).toEqual([]);
    expect(r.status).toContain('sku_nao_mapeado');
  });
});
