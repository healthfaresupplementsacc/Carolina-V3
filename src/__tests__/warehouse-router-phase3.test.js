'use strict';
/**
 * Warehouse hub — S15 Fase 3 (Bruno 08-18): import da Veeqo, pesos, contagem por
 * peso, etiquetas, UPC e drift.
 *  1. import-veeqo: delta > 0 entra (kind 'import', a organizar); delta < 0 NUNCA
 *     deduz sozinho (volta em `negative`); delta 0 pula; idempotente por dia
 *  2. weights: calibração e taras gravam sem tocar qty
 *  3. count/compute: qty + resíduo + confiança
 *  4. labels: dados das etiquetas de bin e caixa + carimbo de impressa
 *  5. drift: mesma conta do overview, exportada pro worker
 * Express de verdade num socket efêmero; services mockados — sem banco, sem rede.
 * PINs FICTÍCIOS.
 */
const express = require('express');
const { createWarehouseRouter, computeDrift, importVeeqo } = require('../v3/warehouse/router');

const ADMIN_PIN = '111111';   // fictício: manage_stock
const VIEWER_PIN = '222222';  // fictício: só view_stock

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
      if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push(params[1]); return { rows: [] }; }
      // weights
      if (/SELECT unit_weight_g FROM v3\.products/.test(q)) {
        const p = state.products.find((x) => x.id === params[0]);
        return { rows: p ? [{ unit_weight_g: p.unit_weight_g }] : [] };
      }
      if (q.startsWith('UPDATE v3.products SET unit_weight_g')) {
        const p = state.products.find((x) => x.id === params[0]);
        if (!p) return { rows: [] };
        p.unit_weight_g = params[1]; p.unit_weight_samples = params[2];
        return { rows: [{ product_id: p.id, name: p.name, nickname: p.nickname,
          unit_weight_g: p.unit_weight_g, samples: p.unit_weight_samples, updated_at: 'now' }] };
      }
      if (/FROM v3\.products p WHERE p\.active/.test(q)) {
        return { rows: state.products.map((p) => ({ product_id: p.id, name: p.name, nickname: p.nickname,
          unit_weight_g: p.unit_weight_g, samples: p.unit_weight_samples, updated_at: null })) };
      }
      if (/FROM v3\.tare_presets/.test(q)) return { rows: state.tares };
      if (q.startsWith('INSERT INTO v3.tare_presets')) {
        const row = { id: 9, name: params[0], kind: params[1], tare_g: params[2], active: params[3] };
        state.tares.push(row); return { rows: [row] };
      }
      if (/SELECT id, bin_code, tare_g, capacity FROM v3\.stock_bins/.test(q)) return { rows: state.bins };
      if (/SELECT id, box_number, tare_g, batch_number, sealed FROM v3\.stock_boxes/.test(q)) return { rows: state.boxes };
      if (/SELECT tare_g FROM v3\.stock_bins/.test(q)) {
        const b = state.bins.find((x) => x.id === params[0]);
        return { rows: b ? [{ tare_g: b.tare_g }] : [] };
      }
      if (/SELECT tare_g FROM v3\.stock_boxes/.test(q)) {
        const b = state.boxes.find((x) => x.id === params[0]);
        return { rows: b ? [{ tare_g: b.tare_g }] : [] };
      }
      // tara da caixa com o TIPO junto (S15.43: resolveTareInfo faz LEFT JOIN box_types)
      if (/SELECT x\.tare_g, t\.tare_g AS type_tare_g/.test(q)) {
        const b = state.boxes.find((x) => x.id === params[0]);
        return { rows: b ? [{ tare_g: b.tare_g, type_tare_g: b.type_tare_g || null,
          tare_min_g: b.tare_min_g || null, tare_max_g: b.tare_max_g || null }] : [] };
      }
      if (q.startsWith('UPDATE v3.stock_bins SET tare_g')) {
        const b = state.bins.find((x) => x.id === params[0]);
        if (!b) return { rows: [] };
        if (params[1] != null) b.tare_g = params[1];
        if (params[2] != null) b.capacity = params[2];
        return { rows: [b] };
      }
      if (q.startsWith('UPDATE v3.stock_boxes SET tare_g')) {
        const b = state.boxes.find((x) => x.id === params[0]);
        if (!b) return { rows: [] };
        if (params[1] != null) b.tare_g = params[1];
        if (params[2] != null) b.batch_number = params[2];
        if (params[3] != null) b.sealed = params[3];
        return { rows: [b] };
      }
      // labels
      if (/FROM v3\.stock_bins b LEFT JOIN v3\.products p ON p\.id = b\.product_id WHERE b\.id = ANY/.test(q)) {
        return { rows: state.bins.filter((b) => params[0].includes(b.id))
          .map((b) => ({ ...b, shelf_code: 'S2', area: 'A', product: 'BENF-300' })) };
      }
      if (/FROM v3\.stock_boxes x LEFT JOIN v3\.products p ON p\.id = x\.product_id WHERE x\.id = ANY/.test(q)) {
        return { rows: state.boxes.filter((b) => params[0].includes(b.id))
          .map((b) => ({ ...b, area: 'P1', product: 'BENF-300' })) };
      }
      if (q.startsWith('UPDATE v3.stock_boxes SET label_printed_at')) {
        const b = state.boxes.find((x) => x.id === params[0]);
        if (!b) return { rows: [] };
        b.label_printed_at = 'now';
        return { rows: [{ id: b.id, box_number: b.box_number, label_printed_at: 'now' }] };
      }
      if (/FROM v3\.box_types WHERE id/.test(q)) {
        const t = (state.boxTypes || []).find((x) => x.id === params[0]);
        return { rows: t ? [t] : [] };
      }
      // UPC
      if (/SELECT id, sku, barcode FROM v3\.product_skus/.test(q)) return { rows: state.skus };
      if (q.startsWith('UPDATE v3.product_skus SET barcode')) {
        const s = state.skus.find((x) => x.id === params[0]);
        if (s) s.barcode = params[1];
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

function baseRow(over = {}) {
  return {
    product_id: 10, name: 'Benfotiamine 300 mg', nickname: 'BENF-300', bottle_color: 'black',
    base_sku: 'HF-BENF-300',
    skus: [{ id: 1, sku: 'HF-BENF-300', channel: 'veeqo', units_per_pack: 1, role: 'base', veeqo_type: null, confirmed: true }],
    shelf_qty: 46, box_qty: 180, unplaced_qty: 0, total: 226,
    reserved: 12, pending_out: 0, pending_in: 0, available: 214, separated: 0,
    min_units: null, days_cover: null, veeqo: null, veeqo_match: 'unknown',
    status: ['ok'], bins: [], boxes: [],
    ...over,
  };
}

function makeStock(rows) {
  return {
    storeIn: jest.fn(async (p) => ({ movement: { id: 900 }, duplicate: false, applied: p.qty })),
    overview: jest.fn(async (o) => (o && o.product_id
      ? rows.filter((r) => r.product_id === o.product_id).map((r) => JSON.parse(JSON.stringify(r)))
      : rows.map((r) => JSON.parse(JSON.stringify(r))))),
    productDetail: jest.fn(async () => null),
    place: jest.fn(), move: jest.fn(), adjust: jest.fn(), separate: jest.fn(),
    pick: jest.fn(), count: jest.fn(), resolveIssue: jest.fn(),
  };
}

const fakeVeeqo = (list) => ({
  listSellables: async () => list,
});

let server, base, state, stock, veeqoCache;

async function boot(rows, veeqoList) {
  if (server) await new Promise((r) => server.close(r));
  state = {
    queries: [], audit: [],
    products: [{ id: 10, name: 'Benfotiamine 300 mg', nickname: 'BENF-300', unit_weight_g: 440, unit_weight_samples: 10 }],
    tares: [],
    bins: [{ id: 1, bin_code: 'A03B2', tare_g: 120, capacity: 48 }],
    boxes: [{ id: 5, box_number: 'BX-0451', tare_g: 780, batch_number: 'L-77', sealed: false, qty: 180 },
      { id: 6, box_number: 'BX-0452', tare_g: null, batch_number: null, sealed: false, qty: 0,
        type_tare_g: 800, tare_min_g: 700, tare_max_g: 1000 }],
    boxTypes: [{ id: 3, name: '20x20x20', tare_g: 800, tare_min_g: 700, tare_max_g: 1000,
      tare_samples: 10, last_calibrated_at: new Date().toISOString(), active: true }],
    skus: [{ id: 1, sku: 'HF-BENF-300', barcode: null }],
  };
  stock = makeStock(rows);
  const { createVeeqoCache } = require('../v3/warehouse/veeqo-cache');
  veeqoCache = createVeeqoCache({
    veeqo: fakeVeeqo(veeqoList || [{ sku: 'HF-BENF-300', type: 'variant', upc_code: '850012345678',
      wh: { physical: 226, allocated: 12, available: 214 } }]),
  });
  await veeqoCache.warm();
  const app = express();
  app.use('/', createWarehouseRouter({ db: makeDb(state), stock,
    requests: { list: async () => [], propose: async () => ({}), pendingByProduct: async () => ({}) },
    veeqoCache }));
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

beforeEach(async () => { await boot([baseRow()]); });
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('Fase 3 — import da Veeqo', () => {
  test('Veeqo maior que o nosso: entra a diferença, kind import, a organizar', async () => {
    await boot([baseRow({ total: 200 })]);   // Veeqo 226, aqui 200 → +26
    const r = await call('POST', '/api/v3/warehouse/import-veeqo', {}, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.imported).toEqual([expect.objectContaining({ product_id: 10, delta: 26 })]);
    expect(r.body.data.negative).toEqual([]);
    const p = stock.storeIn.mock.calls[0][0];
    expect(p.qty).toBe(26);
    expect(p.kind).toBe('import');
    expect(p.bin_id).toBeUndefined();          // a organizar: sem bin e sem caixa
    expect(p.box_id).toBeUndefined();
    expect(p.source).toBe('veeqo_import');
    expect(p.source_ref).toMatch(/^veeqo_import:HF-BENF-300:\d{4}-\d{2}-\d{2}$/);
  });

  test('Veeqo MENOR: nunca deduz sozinho, volta pra revisão manual', async () => {
    await boot([baseRow({ total: 300 })]);   // Veeqo 226, aqui 300 → -74
    const r = await call('POST', '/api/v3/warehouse/import-veeqo', {}, ADMIN_PIN);
    expect(r.body.data.imported).toEqual([]);
    expect(r.body.data.negative[0]).toMatchObject({ product_id: 10, delta: -74, ours: 300, veeqo: 226 });
    expect(stock.storeIn).not.toHaveBeenCalled();
  });

  test('bateu certinho → skipped, nenhuma escrita', async () => {
    const r = await call('POST', '/api/v3/warehouse/import-veeqo', {}, ADMIN_PIN);
    expect(r.body.data.imported).toEqual([]);
    expect(r.body.data.skipped).toBe(1);
    expect(stock.storeIn).not.toHaveBeenCalled();
  });

  test('produto sem SKU na Veeqo é pulado (nunca importa por palpite)', async () => {
    await boot([baseRow({ base_sku: 'HF-NAO-EXISTE', total: 0 })]);
    const r = await call('POST', '/api/v3/warehouse/import-veeqo', {}, ADMIN_PIN);
    expect(r.body.data.skipped).toBe(1);
    expect(stock.storeIn).not.toHaveBeenCalled();
  });

  test('idempotente por dia: o source_ref carrega a data NY', async () => {
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    await boot([baseRow({ total: 200 })]);
    await call('POST', '/api/v3/warehouse/import-veeqo', {}, ADMIN_PIN);
    await call('POST', '/api/v3/warehouse/import-veeqo', {}, ADMIN_PIN);
    const refs = stock.storeIn.mock.calls.map((c) => c[0].source_ref);
    expect(refs).toEqual(['veeqo_import:HF-BENF-300:' + day, 'veeqo_import:HF-BENF-300:' + day]);
    // mesmo source_ref → o StockService de verdade recusa a 2ª (ON CONFLICT)
    expect(new Set(refs).size).toBe(1);
  });

  test('product_id filtra um produto só', async () => {
    await boot([baseRow({ total: 200 }), baseRow({ product_id: 11, base_sku: 'OUTRO', total: 5 })]);
    await call('POST', '/api/v3/warehouse/import-veeqo', { product_id: 10 }, ADMIN_PIN);
    expect(stock.overview).toHaveBeenCalledWith({ product_id: 10 });
  });

  test('view_stock não importa (403)', async () => {
    const r = await call('POST', '/api/v3/warehouse/import-veeqo', {}, VIEWER_PIN);
    expect(r.status).toBe(403);
    expect(stock.storeIn).not.toHaveBeenCalled();
  });
});

describe('Fase 3 — drift', () => {
  test('GET drift lista produto, nossos números e a diferença', async () => {
    await boot([baseRow({ total: 200 })]);
    const r = await call('GET', '/api/v3/warehouse/drift', undefined, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.drift).toEqual([expect.objectContaining({
      product_id: 10, nickname: 'BENF-300', base_sku: 'HF-BENF-300',
      ours: 200, veeqo: 226, delta: 26 })]);
  });

  test('sem divergência → lista vazia', async () => {
    const r = await call('GET', '/api/v3/warehouse/drift', undefined, ADMIN_PIN);
    expect(r.body.data.drift).toEqual([]);
  });

  test('computeDrift é chamável direto (é o que o worker usa, sem HTTP)', async () => {
    const rows = [baseRow({ total: 200 })];
    const out = await computeDrift({ stock: makeStock(rows), veeqoCache });
    expect(out[0].delta).toBe(26);
  });

  test('importVeeqo é chamável direto com as mesmas regras', async () => {
    const s = makeStock([baseRow({ total: 200 })]);
    const out = await importVeeqo({ stock: s, veeqoCache }, {});
    expect(out.imported[0].delta).toBe(26);
    expect(s.storeIn.mock.calls[0][0].kind).toBe('import');
  });

  test('produto sem número na Veeqo não é drift, é desconhecido', async () => {
    await boot([baseRow({ base_sku: 'HF-NAO-EXISTE', total: 10 })]);
    const r = await call('GET', '/api/v3/warehouse/drift', undefined, ADMIN_PIN);
    expect(r.body.data.drift).toEqual([]);
  });
});

describe('Fase 3 — pesos e taras', () => {
  test('GET weights devolve produtos, taras, bins e caixas', async () => {
    const r = await call('GET', '/api/v3/warehouse/weights', undefined, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.products[0]).toMatchObject({ product_id: 10, unit_weight_g: 440, samples: 10 });
    expect(r.body.data.bins[0]).toMatchObject({ bin_code: 'A03B2', tare_g: 120, capacity: 48 });
    expect(r.body.data.boxes[0]).toMatchObject({ box_number: 'BX-0451', tare_g: 780 });
  });

  test('calibrar pelo peso de uma amostra: (bruto − tara) ÷ garrafas', async () => {
    const r = await call('POST', '/api/v3/warehouse/weights/product/10',
      { sample_gross_g: 5180, sample_count: 10, sample_tare_g: 780 }, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.product.unit_weight_g).toBe(440);
    expect(r.body.data.product.samples).toBe(10);
  });

  test('peso direto também vale', async () => {
    const r = await call('POST', '/api/v3/warehouse/weights/product/10', { unit_weight_g: 455 }, ADMIN_PIN);
    expect(r.body.data.product.unit_weight_g).toBe(455);
  });

  test('amostra sem contagem → 400 em PT-BR, nada gravado', async () => {
    const r = await call('POST', '/api/v3/warehouse/weights/product/10', { sample_gross_g: 5180 }, ADMIN_PIN);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/sample_count/);
  });

  test('tara reusável, tara/capacidade do bin e lote/lacre da caixa', async () => {
    const t = await call('POST', '/api/v3/warehouse/weights/tare',
      { name: 'Caixa grande', kind: 'box', tare_g: 780 }, ADMIN_PIN);
    expect(t.body.data.tare).toMatchObject({ name: 'Caixa grande', kind: 'box', tare_g: 780 });

    const b = await call('POST', '/api/v3/warehouse/weights/bin/1', { tare_g: 130, capacity: 60 }, ADMIN_PIN);
    expect(b.body.data.bin).toMatchObject({ tare_g: 130, capacity: 60 });

    const x = await call('POST', '/api/v3/warehouse/weights/box/5',
      { batch_number: 'L-99', sealed: true }, ADMIN_PIN);
    expect(x.body.data.box).toMatchObject({ batch_number: 'L-99', sealed: true });
  });

  test('nada em /weights escreve qty de bin ou caixa', async () => {
    await call('POST', '/api/v3/warehouse/weights/product/10', { unit_weight_g: 440 }, ADMIN_PIN);
    await call('POST', '/api/v3/warehouse/weights/bin/1', { tare_g: 130 }, ADMIN_PIN);
    await call('POST', '/api/v3/warehouse/weights/box/5', { tare_g: 800 }, ADMIN_PIN);
    expect(state.queries.filter((x) => /SET .*\bqty\b/i.test(x.q))).toEqual([]);
  });

  test('view_stock lê pesos mas não grava', async () => {
    expect((await call('GET', '/api/v3/warehouse/weights', undefined, VIEWER_PIN)).status).toBe(200);
    expect((await call('POST', '/api/v3/warehouse/weights/product/10', { unit_weight_g: 1 }, VIEWER_PIN)).status).toBe(403);
  });
});

describe('Fase 3 — peso vira contagem (regra do ceil, confiança em PT)', () => {
  test('bruto + tara da caixa → qty com resíduo, faixa e confiança alta', async () => {
    const r = await call('POST', '/api/v3/warehouse/count/compute',
      { product_id: 10, gross_g: 48 * 440 + 780, box_id: 5 }, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ qty: 48, tare_g: 780, unit_weight_g: 440,
      residual_g: 0, residual_fraction: 0, confidence: 'alta',
      qty_min: 48, qty_max: 48, tare_spread_g: 0, recount_suggested: false });
  });

  test('tara informada ganha da cadastrada', async () => {
    const r = await call('POST', '/api/v3/warehouse/count/compute',
      { product_id: 10, gross_g: 48 * 440 + 100, tare_g: 100, box_id: 5 }, ADMIN_PIN);
    expect(r.body.data.tare_g).toBe(100);
    expect(r.body.data.qty).toBe(48);
  });

  test('meia garrafa sobe pra garrafa inteira, mas com recontagem sugerida', async () => {
    const r = await call('POST', '/api/v3/warehouse/count/compute',
      { product_id: 10, gross_g: 48 * 440 + 200, tare_g: 0 }, ADMIN_PIN);
    expect(r.body.data.qty).toBe(49);                    // 0,45 de garrafa → nunca subconta
    expect(r.body.data.confidence).toBe('baixa');        // PT pro Montar
    expect(r.body.data.recount_suggested).toBe(true);    // 0,45 > 0,35: conta na mão
  });

  test('caixa sem tara herda a do TIPO e a faixa vem do espalhamento', async () => {
    const r = await call('POST', '/api/v3/warehouse/count/compute',
      { product_id: 10, gross_g: 48 * 440 + 800, box_id: 6 }, ADMIN_PIN);
    expect(r.body.data).toMatchObject({ qty: 48, tare_g: 800, tare_spread_g: 300,
      qty_min: 48, qty_max: 49, recount_suggested: true });
  });

  test('box_type_id direto também resolve a tara (caixa ainda nem cadastrada)', async () => {
    const r = await call('POST', '/api/v3/warehouse/count/compute',
      { product_id: 10, gross_g: 48 * 440 + 800, box_type_id: 3 }, ADMIN_PIN);
    expect(r.body.data.tare_g).toBe(800);
    expect(r.body.data.qty).toBe(48);
  });

  test('product_id inválido → 400', async () => {
    const r = await call('POST', '/api/v3/warehouse/count/compute', { gross_g: 100 }, ADMIN_PIN);
    expect(r.status).toBe(400);
  });
});

describe('Fase 3 — etiquetas', () => {
  test('labels de bin e caixa vêm com código, linha 2, linha 3 e url do QR', async () => {
    const r = await call('GET', '/api/v3/warehouse/labels?bins=1&boxes=5', undefined, ADMIN_PIN);
    expect(r.status).toBe(200);
    const bin = r.body.data.labels.find((l) => l.kind === 'bin');
    expect(bin).toMatchObject({ code: 'A03B2', url: '/scan/?b=A03B2' });
    const box = r.body.data.labels.find((l) => l.kind === 'box');
    expect(box).toMatchObject({ code: 'BX-0451', line2: 'BENF-300', url: '/scan/?x=BX-0451' });
    expect(box.line3).toBe('180 garrafas · lote L-77');
    for (const l of r.body.data.labels) expect(l.line3).not.toMatch(/—/);   // sem em dash
  });

  test('sem ids → lista vazia (não estoura)', async () => {
    const r = await call('GET', '/api/v3/warehouse/labels', undefined, ADMIN_PIN);
    expect(r.body.data.labels).toEqual([]);
  });

  test('carimbo de etiqueta impressa', async () => {
    const r = await call('POST', '/api/v3/warehouse/locations/box/5/label-printed', {}, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.box.label_printed_at).toBe('now');
    const missing = await call('POST', '/api/v3/warehouse/locations/box/999/label-printed', {}, ADMIN_PIN);
    expect(missing.status).toBe(404);
  });
});

describe('Fase 3 — UPC da Veeqo', () => {
  test('copia o upc_code pro barcode dos SKUs mapeados', async () => {
    const r = await call('POST', '/api/v3/warehouse/skus/import-upc', {}, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.updated).toBe(1);
    expect(state.skus[0].barcode).toBe('850012345678');
  });

  test('rodar de novo não conta nada (já está igual)', async () => {
    await call('POST', '/api/v3/warehouse/skus/import-upc', {}, ADMIN_PIN);
    const again = await call('POST', '/api/v3/warehouse/skus/import-upc', {}, ADMIN_PIN);
    expect(again.body.data.updated).toBe(0);
  });

  test('SKU sem UPC na Veeqo não inventa código', async () => {
    await boot([baseRow()], [{ sku: 'HF-BENF-300', type: 'variant', wh: { physical: 226 } }]);
    const r = await call('POST', '/api/v3/warehouse/skus/import-upc', {}, ADMIN_PIN);
    expect(r.body.data.updated).toBe(0);
    expect(state.skus[0].barcode).toBeNull();
  });
});
