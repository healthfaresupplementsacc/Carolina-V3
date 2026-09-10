'use strict';
/**
 * FASE A do controle de estoque (Bruno 09-10: "nunca duplicar", "toda ação anotada").
 * Trava os seis itens que fecharam a auditoria S15-ADMIN-CONTROL-AUDIT:
 *  R1  cache Veeqo nasce SEMEADO pelo snapshot do banco (a coluna nunca fica vazia)
 *  R3  código de barras igual sozinho = "média · conferir", nunca "alta"
 *  D16 movimento do dashboard leva actor_login_id/actor_name (quem fez)
 *  5   POST /load (que SOMAVA) não existe mais; POST /product/:id/count DEFINE o local
 *  6   guarda de tamanho: acima do alvo da Veeqo → 409 over_target; com confirm passa
 *  6   drift: "aqui > Veeqo" vem marcado como o lado perigoso
 * Express real em socket efêmero, services mockados. PINs FICTÍCIOS.
 */
const express = require('express');
const { createWarehouseRouter } = require('../v3/warehouse/router');
const { createVeeqoCache } = require('../v3/warehouse/veeqo-cache');
const { suggest } = require('../v3/warehouse/sku-suggest');
const { StockDriftAlert } = require('../workers/stock-drift-alert');

const ADMIN_PIN = '111111';

function baseRow(over = {}) {
  return {
    product_id: 10, name: 'Benfotiamine 300mg', nickname: 'BENF-300', bottle_color: 'white',
    base_sku: 'HF-BENF-300', skus: [{ id: 1, sku: 'HF-BENF-300', channel: 'veeqo', units_per_pack: 1, confirmed: true, role: 'base' }],
    shelf_qty: 46, box_qty: 180, unplaced_qty: 0, total: 226,
    reserved: 12, pending_out: 0, pending_in: 0, available: 214, separated: 0,
    veeqo: { physical: 226 }, veeqo_total: 226, veeqo_match: 'ok',
    status: ['ok'], bins: [{ id: 4, bin_code: 'A03', qty: 46 }], boxes: [{ id: 9, box_number: 'BX-0001', qty: 180 }],
    ...over,
  };
}

function makeDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM v3\.app_logins l/.test(q)) {
        return params[0] === ADMIN_PIN
          ? { rows: [{ id: 1, name: 'Henrique', role: 'manager', rank: 50, functions: ['view_stock', 'manage_stock'] }] }
          : { rows: [] };
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push(params[1]); return { rows: [] }; }
      if (/FROM v3\.veeqo_snapshots/.test(q)) return { rows: state.snapshot ? [state.snapshot] : [] };
      if (/SELECT qty, product_id FROM v3\.stock_bins WHERE id = \$1/.test(q)) {
        const b = state.bins.find((x) => x.id === params[0]); return { rows: b ? [b] : [] };
      }
      if (/SELECT qty, product_id FROM v3\.stock_boxes WHERE id = \$1/.test(q)) {
        const b = state.boxes.find((x) => x.id === params[0]); return { rows: b ? [b] : [] };
      }
      if (/COUNT\(\*\)::int AS count/.test(q)) return { rows: [{ count: 0, oldest_age_min: null }] };
      if (/AS products_total/.test(q)) return { rows: [{ products_total: 1, products_with_weight: 0, bins_count: 1, box_types_count: 0, boxes_count: 1 }] };
      return { rows: [] };
    },
  };
}

function makeStock(rows) {
  const calls = [];
  const op = (name) => jest.fn(async (p) => { calls.push({ name, p }); return { movement: { id: 900 }, duplicate: false, applied: p.qty || p.found || 0 }; });
  return {
    calls,
    overview: jest.fn(async (o) => (o && o.product_id
      ? rows.filter((r) => r.product_id === o.product_id).map((r) => JSON.parse(JSON.stringify(r)))
      : rows.map((r) => JSON.parse(JSON.stringify(r))))),
    productDetail: jest.fn(async () => ({ product: rows[0], open_orders: [], movements: [], issues: [], requests: [] })),
    storeIn: op('storeIn'), place: op('place'), move: op('move'), adjust: op('adjust'),
    separate: op('separate'), pick: op('pick'), count: op('count'),
  };
}

let server, base, state, stock;
async function boot(rows) {
  if (server) await new Promise((r) => server.close(r));
  state = { audit: [], bins: [{ id: 4, qty: 46, product_id: 10 }], boxes: [{ id: 9, qty: 180, product_id: 10 }], snapshot: null };
  stock = makeStock(rows);
  const veeqo = { listSellables: async () => [{ sku: 'HF-BENF-300', type: 'variant', wh: { physical: 226, allocated: 0, available: 226 } }] };
  const veeqoCache = createVeeqoCache({ veeqo });
  await veeqoCache.warm();
  const app = express();
  app.use('/', createWarehouseRouter({ db: makeDb(state), stock, requests: { list: async () => [] }, veeqoCache }));
  server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
}
async function call(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', 'x-admin-pin': ADMIN_PIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
}
beforeEach(async () => { await boot([baseRow()]); });
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('R1 · cache Veeqo semeado pelo snapshot', () => {
  test('sem db: comportamento antigo (mapa vazio até o refresh)', async () => {
    const c = createVeeqoCache({ veeqo: { listSellables: async () => [] } });
    expect(c.source()).toBe('none');
    expect(await c.bySku()).toEqual({});
  });
  test('com snapshot no banco: a coluna nasce preenchida, com a idade do snapshot', async () => {
    const taken = new Date('2026-09-09T22:20:43Z');
    const db = { query: async () => ({ rows: [{ taken_at: taken, sellables: [{ sku: 'hf-beet-2000', type: 'variant', wh: { physical: 110 }, upc_code: '850054045393' }] }] }) };
    let live = null;   // API nunca responde neste teste
    const c = createVeeqoCache({ veeqo: { listSellables: () => new Promise((r) => { live = r; }) }, db });
    const m = await c.bySku();
    expect(m['HF-BEET-2000']).toEqual({ type: 'variant', wh: { physical: 110 }, upc: '850054045393' });
    expect(c.source()).toBe('snapshot');
    expect(c.checkedAt()).toBe(taken.toISOString());
    live([{ sku: 'HF-BEET-2000', type: 'variant', wh: { physical: 111 } }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(c.source()).toBe('live');
    expect((await c.bySku())['HF-BEET-2000'].wh.physical).toBe(111);
  });
  test('snapshot quebrado não derruba: cai no comportamento antigo', async () => {
    const db = { query: async () => { throw new Error('boom'); } };
    const c = createVeeqoCache({ veeqo: { listSellables: async () => [] }, db });
    expect(await c.bySku()).toEqual({});
    expect(c.source()).toBe('none');
  });
});

describe('R3 · Juntar SKUs: código de barras igual não é prova', () => {
  const row = (id, name, sku, upc) => ({ product_id: id, name, nickname: sku.replace(/^HF-/, ''), total: 0,
    skus: [{ sku, units_per_pack: 1, barcode: upc }], bins: [], boxes: [] });
  test('mesmo UPC e nomes DIFERENTES → média, "CONFERIR" (caso Lithium × Melatonin)', () => {
    const out = suggest([row(1, 'Lithium Orotate', 'HF-LITH-5', '850054045478'), row(2, 'Melatonin Berry Flavor 5mg', 'HF-MELA-5', '850054045478')], {});
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].confidence).toBe('média');
    expect(out.groups[0].reason).toMatch(/CONFERIR/);
  });
  test('mesmo UPC e mesmo nome → alta', () => {
    const out = suggest([row(1, 'Beet Root 2000mg', 'HF-BEET-2000', '850054045393'), row(2, 'Beet Root 2000mg', 'HF-BEET-2000-C3', '850054045393')], {});
    expect(out.groups[0].confidence).toBe('alta');
  });
});

describe('6 · drift: "aqui tem MAIS que a Veeqo" é o lado perigoso', () => {
  const w = new StockDriftAlert({ db: { query: async () => ({ rows: [] }) }, enabled: false });
  test('nosso > Veeqo vem marcado', () => {
    expect(w._line({ nickname: 'BENF-300', veeqo: 214, ours: 226, delta: -12 })).toMatch(/^ATENCAO, aqui tem MAIS que a Veeqo/);
  });
  test('nosso < Veeqo é a linha normal', () => {
    expect(w._line({ nickname: 'BENF-300', veeqo: 226, ours: 214, delta: 12 })).toBe('BENF-300: Veeqo 226, aqui 214, diferença de +12');
  });
});

describe('5 · uma porta: /load some, /product/:id/count DEFINE o local', () => {
  test('POST /load não existe mais', async () => {
    const r = await call('POST', '/api/v3/warehouse/load', { product_id: 10, qty: 5 });
    expect(r.status).toBe(404);
  });
  test('GET /load/progress continua (cabeçalho da página Montar)', async () => {
    const r = await call('GET', '/api/v3/warehouse/load/progress');
    expect(r.status).toBe(200);
  });
  test('count na prateleira: found ABSOLUTO, ator do dashboard no movimento, idempotência pelo client_ref', async () => {
    const r = await call('POST', '/api/v3/warehouse/product/10/count', { bin_id: 4, found: 40, client_ref: 'ABC-1', note: 'contagem na mão' });
    expect(r.status).toBe(200);
    expect(stock.count).toHaveBeenCalledTimes(1);
    const p = stock.count.mock.calls[0][0];
    expect(p).toMatchObject({ bin_id: 4, box_id: null, found: 40, actor_name: 'Henrique', actor_login_id: 1, source: 'warehouse_hub', source_ref: 'count:abc-1' });
    expect(r.body.data.product.product_id).toBe(10);
  });
  test('local de outro produto → 400, nada gravado', async () => {
    state.bins.push({ id: 5, qty: 3, product_id: 99 });
    const r = await call('POST', '/api/v3/warehouse/product/10/count', { bin_id: 5, found: 1 });
    expect(r.status).toBe(400);
    expect(stock.count).not.toHaveBeenCalled();
  });
});

describe('6 · guarda de tamanho: acima do alvo da Veeqo pede confirmação', () => {
  test('count que levaria o total a 300 (Veeqo 226, teto 271) → 409 over_target com os números', async () => {
    const r = await call('POST', '/api/v3/warehouse/product/10/count', { bin_id: 4, found: 120 }); // 226 - 46 + 120 = 300
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('over_target');
    expect(r.body.error.message).toMatch(/300 garrafas/);
    expect(r.body.error.message).toMatch(/Veeqo tem 226/);
    expect(stock.count).not.toHaveBeenCalled();
  });
  test('com confirm: true passa e grava', async () => {
    const r = await call('POST', '/api/v3/warehouse/product/10/count', { bin_id: 4, found: 120, confirm: true });
    expect(r.status).toBe(200);
    expect(stock.count).toHaveBeenCalledTimes(1);
  });
  test('dentro do teto não pergunta nada (contagem normal)', async () => {
    const r = await call('POST', '/api/v3/warehouse/product/10/count', { bin_id: 4, found: 60 }); // 240 <= 271
    expect(r.status).toBe(200);
  });
  test('entrada acima do teto → 409; confirmada → storeIn com o ator', async () => {
    let r = await call('POST', '/api/v3/warehouse/product/10/entrada', { qty: 100 });      // 326 > 271
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('over_target');
    expect(stock.storeIn).not.toHaveBeenCalled();
    r = await call('POST', '/api/v3/warehouse/product/10/entrada', { qty: 100, confirm: true });
    expect(r.status).toBe(200);
    expect(stock.storeIn.mock.calls[0][0]).toMatchObject({ qty: 100, actor_name: 'Henrique', actor_login_id: 1 });
  });
  test('produto sem alvo na Veeqo: nunca bloqueia (carga do zero)', async () => {
    // SKU que a Veeqo não conhece: o overview não acha alvo no cache → sem guarda
    await boot([baseRow({ base_sku: 'HF-NOVO-1', skus: [{ id: 2, sku: 'HF-NOVO-1', channel: 'veeqo', units_per_pack: 1, confirmed: true, role: 'base' }],
      veeqo_total: null, veeqo: null, veeqo_match: 'unknown' })]);
    const r = await call('POST', '/api/v3/warehouse/product/10/entrada', { qty: 5000 });
    expect(r.status).toBe(200);
  });
});
