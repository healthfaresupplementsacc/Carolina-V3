'use strict';
/**
 * A porta da carga (S15.44, Bruno 08-22): POST /api/v3/warehouse/load é a ÚNICA
 * porta da página Montar — a carga inicial do estoque, que começa hoje.
 *  1. valida tudo em PT-BR (product_id, qty 1..20000, dest, source, client_ref uuid)
 *  2. compõe SÓ verbos do StockService: storeIn no "a organizar" e, com destino
 *     bin/caixa, place — nunca SQL cru de quantidade
 *  3. idempotente por client_ref: clique duplo não duplica, retry completa
 *  4. toda resposta volta com o check da Veeqo (alvo da carga = total da Veeqo;
 *     diferença é AVISO, nunca bloqueio)
 *  5. GET /load/progress: o cabeçalho da página em uma consulta barata
 * DB/StockService mockados; nenhum banco, nenhuma rede. PINs FICTÍCIOS.
 */
const express = require('express');
const { createLoad, SOURCES, QTY_MAX } = require('../v3/warehouse/load');
const { createWarehouseRouter } = require('../v3/warehouse/router');

const ADMIN_PIN = '111111';   // fictício: manage_stock
const VIEWER_PIN = '222222';  // fictício: só view_stock
const REF = '3f1c2a34-9d2b-4e64-8a11-0c9d6b7e5f10';

function baseRow(over = {}) {
  return {
    product_id: 10, name: 'Benfotiamine 300 mg', nickname: 'BENF-300',
    base_sku: 'HF-BENF-300', skus: [],
    shelf_qty: 46, box_qty: 180, unplaced_qty: 0, total: 226,
    reserved: 12, pending_out: 0, pending_in: 0, available: 214, separated: 0,
    veeqo: { physical: 226 }, veeqo_total: 226, veeqo_match: 'ok',
    status: ['ok'], bins: [], boxes: [],
    ...over,
  };
}

function makeStock() {
  return {
    storeIn: jest.fn(async (p) => ({ movement: { id: 900 }, duplicate: false, applied: p.qty })),
    place: jest.fn(async (p) => ({ movement: { id: 901 }, duplicate: false, applied: p.qty })),
  };
}

function makeDeps(rows) {
  const stock = makeStock();
  const db = { queries: [], async query(sql) {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    this.queries.push(q);
    if (/AS products_total/.test(q)) {
      return { rows: [{ products_total: 21, products_with_weight: 8,
        bins_count: 40, box_types_count: 3, boxes_count: 12 }] };
    }
    return { rows: [] };
  } };
  const boxTypes = { recalibrationWarnings: jest.fn(async () => [
    { box_type_id: 7, name: '20x20x20', last_calibrated_at: null }]) };
  const rowsWithVeeqo = jest.fn(async (pid) =>
    (pid ? rows.filter((r) => r.product_id === pid) : rows));
  return { db, stock, boxTypes, rowsWithVeeqo,
    door: createLoad({ db, stock, boxTypes, rowsWithVeeqo }) };
}

const CTX = { person_id: 7, login: 'Henrique' };

describe('load — validação', () => {
  test.each([
    [{}, /product_id/],
    [{ product_id: 10 }, /qty/],
    [{ product_id: 10, qty: 0 }, /qty/],
    [{ product_id: 10, qty: QTY_MAX + 1 }, /qty/],
    [{ product_id: 10, qty: 5 }, /dest\.kind/],
    [{ product_id: 10, qty: 5, dest: { kind: 'palete' } }, /dest\.kind/],
    [{ product_id: 10, qty: 5, dest: { kind: 'bin' } }, /dest\.id/],
    [{ product_id: 10, qty: 5, dest: { kind: 'unplaced' } }, /source/],
    [{ product_id: 10, qty: 5, dest: { kind: 'unplaced' }, source: 'chute' }, /source/],
    [{ product_id: 10, qty: 5, dest: { kind: 'unplaced' }, source: 'count_manual' }, /client_ref/],
    [{ product_id: 10, qty: 5, dest: { kind: 'unplaced' }, source: 'count_manual', client_ref: 'abc' }, /client_ref/],
  ])('corpo ruim %# → erro em PT-BR, nada escrito', async (body, re) => {
    const { door, stock } = makeDeps([baseRow()]);
    await expect(door.load(body, CTX)).rejects.toThrow(re);
    expect(stock.storeIn).not.toHaveBeenCalled();
    expect(stock.place).not.toHaveBeenCalled();
  });

  test('as 4 origens valem: contou, pesou, direto da produção, soltas consertadas', () => {
    expect(SOURCES).toEqual(['count_manual', 'count_weigh', 'production_direct', 'loose_fixed']);
  });
});

describe('load — composição pelo StockService (porta única)', () => {
  test('destino unplaced: só storeIn, sem bin nem caixa, ref do client_ref', async () => {
    const { door, stock } = makeDeps([baseRow()]);
    const out = await door.load({ product_id: 10, qty: 30,
      dest: { kind: 'unplaced' }, source: 'count_manual', client_ref: REF }, CTX);
    expect(stock.storeIn).toHaveBeenCalledTimes(1);
    const p = stock.storeIn.mock.calls[0][0];
    expect(p).toMatchObject({ product_id: 10, qty: 30, person_id: 7,
      actor_type: 'admin', source: 'warehouse_load', source_ref: 'load:' + REF });
    expect(p.bin_id).toBeUndefined();
    expect(p.box_id).toBeUndefined();
    expect(p.note).toContain('contagem na mão');
    expect(stock.place).not.toHaveBeenCalled();
    expect(out.applied).toBe(30);
  });

  test('destino bin: storeIn + place no bin, com ref próprio do place', async () => {
    const { door, stock } = makeDeps([baseRow()]);
    await door.load({ product_id: 10, qty: 12, dest: { kind: 'bin', id: 4 },
      source: 'production_direct', client_ref: REF }, CTX);
    expect(stock.storeIn.mock.calls[0][0].source_ref).toBe('load:' + REF);
    const pl = stock.place.mock.calls[0][0];
    expect(pl).toMatchObject({ product_id: 10, qty: 12, bin_id: 4, box_id: null,
      source: 'warehouse_load', source_ref: 'load:' + REF + ':place' });
    expect(pl.note).toContain('direto da produção');
  });

  test('destino caixa: place com box_id', async () => {
    const { door, stock } = makeDeps([baseRow()]);
    await door.load({ product_id: 10, qty: 12, dest: { kind: 'box', id: 5 },
      source: 'loose_fixed', client_ref: REF }, CTX);
    expect(stock.place.mock.calls[0][0]).toMatchObject({ bin_id: null, box_id: 5 });
  });

  test('pesagem: o meta entra na nota (bruto e tara na frente de quem aprova)', async () => {
    const { door, stock } = makeDeps([baseRow()]);
    await door.load({ product_id: 10, qty: 48, dest: { kind: 'box', id: 5 },
      source: 'count_weigh', client_ref: REF,
      meta: { gross_g: 21900, tare_g: 780, qty_min: 48, qty_max: 49 } }, CTX);
    expect(stock.storeIn.mock.calls[0][0].note)
      .toBe('[Henrique] carga: contagem por peso (bruto 21900g, tara 780g)');
  });

  test('clique duplo: storeIn devolve duplicado → applied 0, place ainda roda (retry completa)', async () => {
    const { door, stock } = makeDeps([baseRow()]);
    stock.storeIn.mockResolvedValueOnce({ movement: { id: 900 }, duplicate: true, applied: 0 });
    const out = await door.load({ product_id: 10, qty: 12, dest: { kind: 'bin', id: 4 },
      source: 'count_manual', client_ref: REF }, CTX);
    expect(out.applied).toBe(0);
    expect(out.duplicate).toBe(true);
    expect(stock.place).toHaveBeenCalledTimes(1);   // o place tem ref próprio: completa o que faltou
  });
});

describe('load — o check da Veeqo em toda resposta', () => {
  test('bateu: veeqo_match true (o check verde da página)', async () => {
    const { door } = makeDeps([baseRow({ total: 226, veeqo_total: 226 })]);
    const out = await door.load({ product_id: 10, qty: 1,
      dest: { kind: 'unplaced' }, source: 'count_manual', client_ref: REF }, CTX);
    expect(out.product).toEqual({ product_id: 10, total: 226, shelf_qty: 46,
      box_qty: 180, unplaced_qty: 0, veeqo_total: 226, veeqo_match: true });
  });

  test('não bateu: veeqo_match false, MAS a carga passou (aviso, nunca bloqueio)', async () => {
    const { door } = makeDeps([baseRow({ total: 200, veeqo_total: 226 })]);
    const out = await door.load({ product_id: 10, qty: 1,
      dest: { kind: 'unplaced' }, source: 'count_manual', client_ref: REF }, CTX);
    expect(out.applied).toBe(1);
    expect(out.product.veeqo_match).toBe(false);
  });

  test('sem número da Veeqo: veeqo_total null e match false (não inventa)', async () => {
    const { door } = makeDeps([baseRow({ veeqo_total: null, veeqo: null })]);
    const out = await door.load({ product_id: 10, qty: 1,
      dest: { kind: 'unplaced' }, source: 'count_manual', client_ref: REF }, CTX);
    expect(out.product.veeqo_total).toBeNull();
    expect(out.product.veeqo_match).toBe(false);
  });
});

describe('load/progress', () => {
  test('o cabeçalho da página em um objeto: contadores + avisos de re-pesagem', async () => {
    const { door } = makeDeps([
      baseRow({ product_id: 10, total: 226, veeqo_total: 226 }),
      baseRow({ product_id: 11, total: 50, veeqo_total: 60 }),
      baseRow({ product_id: 12, total: 0, veeqo_total: null, veeqo: null }),
    ]);
    const out = await door.progress();
    expect(out).toEqual({
      products_total: 21, products_with_weight: 8,
      bins_count: 40, box_types_count: 3, boxes_count: 12,
      bottles_loaded: 276,
      products_matching_veeqo: 1,
      products_with_any_stock: 2,
      recalibration_warnings: [{ box_type_id: 7, name: '20x20x20', last_calibrated_at: null }],
    });
  });
});

// ── rotas ──────────────────────────────────────────────────────
function makeDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      state.queries.push({ q, params });
      if (/FROM v3\.app_logins l/.test(q)) {
        const map = {
          [ADMIN_PIN]: { id: 1, name: 'Henrique', role: 'manager', rank: 50, functions: ['view_stock', 'manage_stock'] },
          [VIEWER_PIN]: { id: 2, name: 'Visitante', role: 'viewer', rank: 20, functions: ['view_stock'] },
        };
        const l = map[params[0]];
        return { rows: l ? [l] : [] };
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push({ action: params[1] }); return { rows: [] }; }
      if (/AS products_total/.test(q)) {
        return { rows: [{ products_total: 21, products_with_weight: 8,
          bins_count: 40, box_types_count: 3, boxes_count: 12 }] };
      }
      if (/FROM v3\.box_types WHERE active/.test(q)) return { rows: [] };
      if (/FROM v3\.box_types t LEFT JOIN/.test(q)) return { rows: [] };
      return { rows: [] };
    },
  };
}

let server, base, state, stock;

async function bootServer(rows) {
  if (server) await new Promise((r) => server.close(r));
  state = { queries: [], audit: [] };
  stock = {
    ...makeStock(),
    overview: jest.fn(async (o) => {
      const list = rows || [baseRow()];
      return o && o.product_id ? list.filter((r) => r.product_id === o.product_id) : list;
    }),
    productDetail: async () => null,
  };
  const { createVeeqoCache } = require('../v3/warehouse/veeqo-cache');
  const veeqoCache = createVeeqoCache({ veeqo: { listSellables: async () => [
    { sku: 'HF-BENF-300', type: 'variant', wh: { physical: 226, allocated: 12, available: 214 } }] } });
  await veeqoCache.warm();
  const app = express();
  app.use('/', createWarehouseRouter({ db: makeDb(state), stock,
    requests: { list: async () => [], propose: async () => ({}) }, veeqoCache }));
  server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
}

async function call(method, path, body, pin) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(pin ? { 'x-admin-pin': pin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
}

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('rotas /load e /load/progress', () => {
  test('POST /load com manage_stock: aplica, audita e devolve o check da Veeqo', async () => {
    await bootServer();
    const r = await call('POST', '/api/v3/warehouse/load',
      { product_id: 10, qty: 30, dest: { kind: 'unplaced' },
        source: 'count_manual', client_ref: REF }, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.applied).toBe(30);
    expect(r.body.data.product).toMatchObject({ product_id: 10, veeqo_total: 226, veeqo_match: true });
    expect(state.audit.map((a) => a.action)).toContain('warehouse.load');
    expect(stock.storeIn.mock.calls[0][0].source_ref).toBe('load:' + REF);
  });

  test('view_stock não carrega (403); corpo ruim → 400 em PT-BR', async () => {
    await bootServer();
    expect((await call('POST', '/api/v3/warehouse/load',
      { product_id: 10, qty: 1, dest: { kind: 'unplaced' }, source: 'count_manual', client_ref: REF },
      VIEWER_PIN)).status).toBe(403);
    const bad = await call('POST', '/api/v3/warehouse/load',
      { product_id: 10, qty: 1, dest: { kind: 'bin' }, source: 'count_manual', client_ref: REF },
      ADMIN_PIN);
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/dest\.id/);
    expect(stock.storeIn).not.toHaveBeenCalled();
  });

  test('GET /load/progress lê com view_stock (é o cabeçalho da página)', async () => {
    await bootServer();
    const r = await call('GET', '/api/v3/warehouse/load/progress', undefined, VIEWER_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ products_total: 21, bins_count: 40,
      bottles_loaded: 226, products_matching_veeqo: 1, products_with_any_stock: 1,
      recalibration_warnings: [] });
  });
});
