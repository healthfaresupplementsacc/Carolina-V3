'use strict';
/**
 * Warehouse hub router — /api/v3/warehouse/* (S15 Fase 1, Bruno 08-18).
 *  1. AUTH: sem PIN 401; operador (sem view_stock) 403; escrita exige manage_stock
 *  2. overview: Row completa + KPIs + lista de atenção em PT-BR + coluna Veeqo
 *  3. toda escrita devolve {data:{ok:true, product:Row}} com a Row RECALCULADA
 *  4. fila de aprovação: propor → aprovar aplica pelo StockService
 * Express de verdade num socket efêmero (mesmo padrão do admin.rbac.test.js);
 * services mockados — nenhum banco, nenhuma rede.
 * PINs FICTÍCIOS (os reais só existem em env/produção).
 */
const express = require('express');
const { createWarehouseRouter } = require('../v3/warehouse/router');

const ADMIN_PIN = '111111';    // fictício: manage_stock
const VIEWER_PIN = '222222';   // fictício: só view_stock
const OP_PIN = '333333';       // fictício: sem função de estoque

/** DB só pro auth + audit + repos de local/família. */
function makeDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM v3\.app_logins l/.test(q)) {
        const map = {
          [ADMIN_PIN]: { id: 1, name: 'Henrique', role: 'manager', rank: 50, functions: ['view_stock', 'manage_stock'] },
          [VIEWER_PIN]: { id: 2, name: 'Visitante', role: 'viewer', rank: 20, functions: ['view_stock'] },
          [OP_PIN]: { id: 3, name: 'Simone', role: 'operator', rank: 10, functions: ['do_pnp'] },
        };
        const l = map[params[0]];
        return { rows: l ? [l] : [] };
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push(params[1]); return { rows: [] }; }
      // resumo da fila do overview: quantas pendentes e a idade da mais velha
      if (/COUNT\(\*\)::int AS count/.test(q) && /stock_change_requests/.test(q)) {
        const pend = state.pending || [];
        return { rows: [{ count: pend.length,
          oldest_age_min: pend.length ? Math.max(...pend.map((p) => p.age_min)) : null }] };
      }
      if (/FROM v3\.product_skus WHERE product_id/.test(q)) {
        return { rows: state.skus.filter((s) => s.product_id === params[0]) };
      }
      if (/FROM v3\.stock_bins b/.test(q)) return { rows: state.bins };
      if (/FROM v3\.stock_boxes x/.test(q)) return { rows: state.boxes };
      // cadastro em LOTE: ON CONFLICT DO NOTHING — código repetido não volta linha
      if (q.startsWith('INSERT INTO v3.stock_bins') && /DO NOTHING/.test(q)) {
        if (state.bins.some((b) => b.bin_code === params[0])) return { rows: [] };
        const bin = { id: 100 + state.bins.length, bin_code: params[0], shelf_code: params[1],
          area: params[2], product_id: params[3], capacity: params[4], min_qty: params[5],
          qty: 0, active: true };
        state.bins.push(bin); return { rows: [{ id: bin.id, bin_code: bin.bin_code }] };
      }
      if (q.startsWith('INSERT INTO v3.stock_bins')) {
        const bin = { id: 77, bin_code: params[0], shelf_code: params[1], area: params[2],
          product_id: params[3], min_qty: params[4], qty: 0, active: true };
        state.bins.push(bin); return { rows: [bin] };
      }
      if (q.startsWith('INSERT INTO v3.stock_boxes')) {
        const box = { id: 88, box_number: params[0], area: params[1], product_id: params[2],
          qty: 0, status: 'in_storage' };
        state.boxes.push(box); return { rows: [box] };
      }
      if (q.startsWith('UPDATE v3.stock_bins SET active = false')) {
        const b = state.bins.find((x) => x.id === params[0]);
        if (!b) return { rows: [] };
        b.active = false; return { rows: [b] };
      }
      // SKU parenting (077): produtos existem e nenhum está absorvido
      if (/FROM v3\.products WHERE id = \$1/.test(q)) {
        const id = params[0];
        return { rows: [{ id, canonical_name: 'Produto ' + id, nickname: null,
          merged_into_product_id: null }] };
      }
      if (/FROM v3\.products WHERE merged_into_product_id = \$1/.test(q)) return { rows: [] };
      if (q.startsWith('UPDATE v3.products SET merged_into_product_id')) return { rows: [] };
      if (q.startsWith('UPDATE v3.products') && /merged_into_product_id = \$2/.test(q)) {
        return { rows: [{ id: params[0] }] };
      }
      if (q.startsWith('UPDATE v3.product_skus SET is_base = false')) return { rows: [] };
      if (q.startsWith('UPDATE v3.stock_issues SET product_id')) return { rows: [] };
      if (q.startsWith('INSERT INTO v3.product_skus')) {
        const sku = { id: 55, product_id: params[0], sku: params[1], channel: params[2],
          units_per_pack: params[3], is_base: params[4], confirmed_at: 'now' };
        state.skus.push(sku); return { rows: [sku] };
      }
      if (q.startsWith('DELETE FROM v3.product_skus')) {
        const i = state.skus.findIndex((s) => s.id === params[0]);
        if (i < 0) return { rows: [] };
        return { rows: state.skus.splice(i, 1) };
      }
      if (q.startsWith('UPDATE v3.product_skus SET product_id')) {
        const moved = state.skus.filter((s) => s.product_id === params[0]);
        moved.forEach((s) => { s.product_id = params[1]; });
        return { rows: moved };
      }
      return { rows: [] };
    },
  };
}

/** Row base do contrato (o service real devolve exatamente estes campos). */
function baseRow(over = {}) {
  return {
    product_id: 10, name: 'Benfotiamine 300 mg', nickname: 'BENF-300', bottle_color: 'black',
    base_sku: 'HF-BENF-300',
    skus: [{ id: 1, sku: 'HF-BENF-300', channel: 'veeqo', units_per_pack: 1, role: 'base', veeqo_type: null, confirmed: true }],
    shelf_qty: 46, box_qty: 180, unplaced_qty: 0, total: 226,
    reserved: 12, pending_out: 0, pending_in: 0, available: 214, separated: 2,
    min_units: null, days_cover: null, veeqo: null, veeqo_match: 'unknown',
    status: ['ok'],
    bins: [{ id: 1, bin_code: 'A03', shelf_code: 'S2', area: 'A', qty: 46, min_qty: 10, needs_restock: false }],
    boxes: [{ id: 5, box_number: 'BOX-004', area: 'P1', qty: 180 }],
    ...over,
  };
}

function makeStock(rows) {
  const calls = [];
  const op = (name) => jest.fn(async (p) => {
    calls.push({ name, p });
    return { movement: { id: 900 }, duplicate: false, applied: p.qty || 0,
      issue: { id: 44, product_id: 10 } };
  });
  return {
    calls,
    overview: jest.fn(async (o) => (o && o.product_id
      ? rows.filter((r) => r.product_id === o.product_id).map((r) => JSON.parse(JSON.stringify(r)))
      : rows.map((r) => JSON.parse(JSON.stringify(r))))),
    productDetail: jest.fn(async (id) => ({
      product: JSON.parse(JSON.stringify(rows.find((r) => r.product_id === id) || rows[0])),
      open_orders: [{ order_number: '12-345', channel: 'eBay', sku: 'HF-BENF-300', qty: 1, bottles: 1, status: 'pending', order_date: '2026-08-18', age_min: 30 }],
      movements: [{ id: 1, kind: 'store_in', qty: 10 }],
      issues: [{ id: 44, qty: 2, reason: 'label', status: 'separated' }],
      requests: [],
    })),
    storeIn: op('storeIn'), place: op('place'), move: op('move'), adjust: op('adjust'),
    separate: op('separate'), pick: op('pick'), count: op('count'),
    resolveIssue: jest.fn(async (p) => { calls.push({ name: 'resolveIssue', p });
      return { issue: { id: p.issue_id, product_id: 10, status: p.action }, applied: 2 }; }),
  };
}

function makeRequests() {
  const rows = [];
  return {
    rows,
    list: jest.fn(async (o) => rows.filter((r) => !o.status || r.status === o.status)),
    propose: jest.fn(async (p) => { const r = { id: rows.length + 1, status: 'pending', ...p }; rows.push(r); return r; }),
    approve: jest.fn(async (p) => { const r = rows.find((x) => x.id === p.id); r.status = 'approved'; r.decided_by_login = p.login; return r; }),
    reject: jest.fn(async (p) => { const r = rows.find((x) => x.id === p.id); r.status = 'rejected'; return r; }),
    pendingByProduct: jest.fn(async () => ({})),
  };
}

/** Veeqo falso: base 226 (bate) — mudar pra ver drift. */
const fakeVeeqo = (physical = 226) => ({
  listSellables: async () => ([
    { sku: 'HF-BENF-300', type: 'variant', wh: { physical, allocated: 12, available: physical - 12 } },
  ]),
});

let server, base, state, stock, requests, veeqoCache;

async function boot(rows, veeqo) {
  if (server) await new Promise((r) => server.close(r));
  state = { audit: [], bins: [], boxes: [], pending: [],
    skus: [{ id: 1, product_id: 10, sku: 'HF-BENF-300', channel: 'veeqo', units_per_pack: 1, confirmed_at: 'x' }] };
  stock = makeStock(rows);
  requests = makeRequests();
  const { createVeeqoCache } = require('../v3/warehouse/veeqo-cache');
  veeqoCache = createVeeqoCache({ veeqo: veeqo || fakeVeeqo() });
  await veeqoCache.warm();          // no teste esperamos o 1º refresh (produção é SWR)
  const app = express();
  app.use('/', createWarehouseRouter({ db: makeDb(state), stock, requests, veeqoCache }));
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

describe('Warehouse hub — auth', () => {
  test('sem PIN → 401 unauthorized', async () => {
    const r = await call('GET', '/api/v3/warehouse/overview');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthorized');
  });

  test('PIN errado → 401', async () => {
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, '000000');
    expect(r.status).toBe(401);
  });

  test('operador sem view_stock → 403 na leitura', async () => {
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, OP_PIN);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('forbidden');
  });

  test('view_stock lê mas NÃO escreve (403)', async () => {
    const read = await call('GET', '/api/v3/warehouse/overview', undefined, VIEWER_PIN);
    expect(read.status).toBe(200);
    const write = await call('POST', '/api/v3/warehouse/product/10/entrada', { qty: 5 }, VIEWER_PIN);
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('forbidden');
    expect(stock.storeIn).not.toHaveBeenCalled();
  });

  test('manage_stock escreve → 200', async () => {
    const r = await call('POST', '/api/v3/warehouse/product/10/entrada', { qty: 5 }, ADMIN_PIN);
    expect(r.status).toBe(200);
  });
});

describe('Warehouse hub — overview', () => {
  test('shape do contrato: products/kpis/attention/veeqo_checked_at/generated_at', async () => {
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, ADMIN_PIN);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(Array.isArray(d.products)).toBe(true);
    expect(Object.keys(d.kpis).sort()).toEqual(
      ['available', 'bins_to_restock', 'drift_products', 'pending_requests', 'reserved', 'separated', 'total_bottles', 'unplaced'].sort());
    expect(d.kpis.total_bottles).toBe(226);
    expect(d.kpis.reserved).toBe(12);
    expect(d.kpis.separated).toBe(2);
    expect(Array.isArray(d.attention)).toBe(true);
    expect(d.generated_at).toBeTruthy();
    expect(d.veeqo_checked_at).toBeTruthy();
  });

  test('Veeqo batendo com o total → veeqo_match ok, sem drift', async () => {
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, ADMIN_PIN);
    const p = r.body.data.products[0];
    expect(p.veeqo).toEqual({ physical: 226, allocated: 12, available: 214 });
    expect(p.veeqo_match).toBe('ok');
    expect(p.status).toContain('ok');
    expect(r.body.data.kpis.drift_products).toBe(0);
  });

  test('Veeqo divergente → drift no status, KPI e lista de atenção em PT-BR', async () => {
    await boot([baseRow()], fakeVeeqo(214));
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, ADMIN_PIN);
    const p = r.body.data.products[0];
    expect(p.veeqo_match).toBe('drift');
    expect(p.status).toContain('drift');
    expect(p.status).not.toContain('ok');
    expect(r.body.data.kpis.drift_products).toBe(1);
    const item = r.body.data.attention.find((a) => a.kind === 'drift');
    expect(item.text).toBe('BENF-300 · Veeqo 214, aqui 226, diferença de -12');
    expect(item.action.type).toBe('ver');
  });

  test('SKU sem Veeqo → veeqo null e match unknown', async () => {
    await boot([baseRow({ base_sku: 'HF-NAO-EXISTE' })]);
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, ADMIN_PIN);
    expect(r.body.data.products[0].veeqo).toBeNull();
    expect(r.body.data.products[0].veeqo_match).toBe('unknown');
  });

  test('atenção: zerado aponta a caixa; a organizar e pendência aparecem com ação', async () => {
    await boot([baseRow({
      shelf_qty: 0, box_qty: 110, unplaced_qty: 80, total: 190, available: 100,
      pending_out: 3, status: ['out', 'organizar', 'pendente'],
      bins: [], boxes: [{ id: 5, box_number: 'BOX-012', area: 'P1', qty: 110 }],
    })], fakeVeeqo(190));
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, ADMIN_PIN);
    const kinds = r.body.data.attention.map((a) => a.kind);
    expect(kinds).toContain('out');
    expect(kinds).toContain('organizar');
    expect(kinds).toContain('pending');
    const out = r.body.data.attention.find((a) => a.kind === 'out');
    expect(out.text).toBe('BENF-300 · zerado na prateleira, caixa BOX-012 tem 110');
    expect(out.action).toEqual({ type: 'repor', box_id: 5 });
    const org = r.body.data.attention.find((a) => a.kind === 'organizar');
    expect(org.text).toBe('BENF-300 · 80 garrafas a organizar, ainda sem prateleira ou caixa');
    expect(r.body.data.kpis.unplaced).toBe(80);
    // sem em dash em nenhum texto da lista (regra de estilo)
    for (const a of r.body.data.attention) expect(a.text).not.toMatch(/—/);
  });

  test('prateleira no mínimo entra na lista e no KPI bins_to_restock', async () => {
    await boot([baseRow({
      bins: [{ id: 1, bin_code: 'A03', shelf_code: 'S2', area: 'A', qty: 4, min_qty: 10, needs_restock: true }],
      status: ['repor'],
    })]);
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, ADMIN_PIN);
    expect(r.body.data.kpis.bins_to_restock).toBe(1);
    const item = r.body.data.attention.find((a) => a.text.includes('precisa repor'));
    expect(item.text).toBe('BENF-300 · prateleira A03 com 4, mínimo 10, precisa repor');
    expect(item.action).toEqual({ type: 'repor', bin_id: 1 });
  });
});

describe('Warehouse hub — ficha do produto', () => {
  test('product/:id devolve Row + pedidos + movimentos + separadas + família', async () => {
    const r = await call('GET', '/api/v3/warehouse/product/10', undefined, ADMIN_PIN);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.product.product_id).toBe(10);
    expect(d.product.veeqo_match).toBe('ok');
    expect(d.open_orders[0].order_number).toBe('12-345');
    expect(d.movements.length).toBe(1);
    expect(d.issues[0].status).toBe('separated');
    // base agora carrega units_per_pack (077: família que só tem kit precisa dizer isso)
    expect(d.family.base).toEqual({ sku: 'HF-BENF-300', channel: 'veeqo', units_per_pack: 1 });
    expect(d.family.members[0].derived_packs).toBe(214);   // floor(214 ÷ 1)
  });

  test('id inválido → 400 bad_request', async () => {
    const r = await call('GET', '/api/v3/warehouse/product/abc', undefined, ADMIN_PIN);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_request');
  });
});

describe('Warehouse hub — escritas devolvem a Row fresca', () => {
  test('entrada sem local chama storeIn sem bin/caixa e devolve product', async () => {
    const r = await call('POST', '/api/v3/warehouse/product/10/entrada', { qty: 80, note: 'lote novo' }, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.ok).toBe(true);
    expect(r.body.data.product.product_id).toBe(10);
    const p = stock.storeIn.mock.calls[0][0];
    expect(p.qty).toBe(80);
    expect(p.bin_id).toBeNull();
    expect(p.box_id).toBeNull();
    expect(p.source).toBe('warehouse_hub');
    expect(p.actor_type).toBe('admin');
    expect(p.note).toMatch(/^\[Henrique\]/);
  });

  test('qty inválido → 400 sem chamar o service', async () => {
    const r = await call('POST', '/api/v3/warehouse/product/10/entrada', { qty: 0 }, ADMIN_PIN);
    expect(r.status).toBe(400);
    expect(stock.storeIn).not.toHaveBeenCalled();
  });

  test('place chama stock.place com o destino', async () => {
    const r = await call('POST', '/api/v3/warehouse/product/10/place', { qty: 48, bin_id: 1 }, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(stock.place.mock.calls[0][0]).toMatchObject({ product_id: 10, qty: 48, bin_id: 1 });
  });

  test('move repassa from/to', async () => {
    const r = await call('POST', '/api/v3/warehouse/product/10/move',
      { qty: 40, from: { box_id: 5 }, to: { bin_id: 1 } }, ADMIN_PIN);
    expect(r.status).toBe(200);
    const p = stock.move.mock.calls[0][0];
    expect(p.from).toEqual({ bin_id: null, box_id: 5 });
    expect(p.to).toEqual({ bin_id: 1, box_id: null });
  });

  test('adjust exige motivo', async () => {
    const bad = await call('POST', '/api/v3/warehouse/product/10/adjust', { qty: -3 }, ADMIN_PIN);
    expect(bad.status).toBe(400);
    const good = await call('POST', '/api/v3/warehouse/product/10/adjust',
      { qty: -3, reason: 'quebrou no chão', bin_id: 1 }, ADMIN_PIN);
    expect(good.status).toBe(200);
    expect(stock.adjust.mock.calls[0][0].note).toMatch(/quebrou no chão/);
  });

  test('separate return repassa reason e order_number', async () => {
    const r = await call('POST', '/api/v3/warehouse/product/10/separate',
      { qty: 2, reason: 'return', order_number: '12-345' }, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(stock.separate.mock.calls[0][0]).toMatchObject({ reason: 'return', order_number: '12-345' });
  });

  test('resolver separada devolve a Row do produto da issue', async () => {
    const r = await call('POST', '/api/v3/warehouse/issues/44/resolve',
      { action: 'restocked', bin_id: 1 }, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(stock.resolveIssue.mock.calls[0][0]).toMatchObject({ issue_id: 44, action: 'restocked' });
    expect(r.body.data.product.product_id).toBe(10);
  });
});

describe('Warehouse hub — fila de aprovação', () => {
  test('propor → listar → aprovar, e a resposta traz a Row', async () => {
    const prop = await call('POST', '/api/v3/warehouse/requests',
      { product_id: 10, kind: 'take', direction: 'out', qty: 3, reason: 'extra pro pedido' }, ADMIN_PIN);
    expect(prop.status).toBe(200);
    expect(prop.body.data.request.status).toBe('pending');
    expect(prop.body.data.request.login).toBe('Henrique');

    const list = await call('GET', '/api/v3/warehouse/requests?status=pending', undefined, ADMIN_PIN);
    expect(list.body.data.requests.length).toBe(1);

    const id = prop.body.data.request.id;
    const appr = await call('POST', `/api/v3/warehouse/requests/${id}/approve`, { note: 'ok' }, ADMIN_PIN);
    expect(appr.status).toBe(200);
    expect(appr.body.data.request.status).toBe('approved');
    expect(appr.body.data.request.decided_by_login).toBe('Henrique');
    expect(appr.body.data.product.product_id).toBe(10);
    expect(requests.approve).toHaveBeenCalledWith(expect.objectContaining({ id, login: 'Henrique' }));
  });

  test('recusar fecha a proposta', async () => {
    const prop = await call('POST', '/api/v3/warehouse/requests',
      { product_id: 10, kind: 'take', direction: 'out', qty: 3 }, ADMIN_PIN);
    const id = prop.body.data.request.id;
    const rej = await call('POST', `/api/v3/warehouse/requests/${id}/reject`, { note: 'não confere' }, ADMIN_PIN);
    expect(rej.body.data.request.status).toBe('rejected');
  });

  test('operador não aprova nada (403)', async () => {
    const r = await call('POST', '/api/v3/warehouse/requests/1/approve', {}, OP_PIN);
    expect(r.status).toBe(403);
    expect(requests.approve).not.toHaveBeenCalled();
  });
});

describe('Warehouse hub — locais e família', () => {
  test('cadastrar bin e caixa; caixa com qty inicial vira entrada de verdade', async () => {
    const bin = await call('POST', '/api/v3/warehouse/locations/bin',
      { bin_code: 'A03', shelf_code: 'S2', area: 'A', product_id: 10, min_qty: 10 }, ADMIN_PIN);
    expect(bin.status).toBe(200);
    expect(bin.body.data.bin.bin_code).toBe('A03');

    const box = await call('POST', '/api/v3/warehouse/locations/box',
      { box_number: 'BOX-045', area: 'P1', product_id: 10, qty: 110 }, ADMIN_PIN);
    expect(box.status).toBe(200);
    // a quantidade inicial NÃO é escrita pelo repo: passa pelo StockService
    expect(stock.storeIn).toHaveBeenCalledTimes(1);
    expect(stock.storeIn.mock.calls[0][0]).toMatchObject({ product_id: 10, qty: 110, box_id: 88 });
  });

  test('listar locais e desativar bin (nunca deleta)', async () => {
    await call('POST', '/api/v3/warehouse/locations/bin', { bin_code: 'A03', product_id: 10 }, ADMIN_PIN);
    const list = await call('GET', '/api/v3/warehouse/locations', undefined, ADMIN_PIN);
    expect(list.body.data.bins.length).toBe(1);
    const off = await call('POST', '/api/v3/warehouse/locations/bin/77/deactivate', {}, ADMIN_PIN);
    expect(off.status).toBe(200);
    expect(off.body.data.bin.active).toBe(false);
    expect(state.bins.length).toBe(1);      // continua existindo
  });

  test('família: attach com units_per_pack, detach e merge', async () => {
    const att = await call('POST', '/api/v3/warehouse/family/10/attach',
      { sku: 'HF-BENF-300-C2', channel: 'veeqo', units_per_pack: 2, role: 'member' }, ADMIN_PIN);
    expect(att.status).toBe(200);
    expect(att.body.data.sku.units_per_pack).toBe(2);

    const fam = await call('GET', '/api/v3/warehouse/family/10', undefined, ADMIN_PIN);
    expect(fam.body.data.base.sku).toBe('HF-BENF-300');
    const c2 = fam.body.data.members.find((m) => m.units_per_pack === 2);
    expect(c2.derived_packs).toBe(107);     // floor(214 ÷ 2)

    const det = await call('POST', '/api/v3/warehouse/family/detach', { sku_id: 55 }, ADMIN_PIN);
    expect(det.status).toBe(200);

    const merge = await call('POST', '/api/v3/warehouse/family/merge',
      { from_product_id: 11, into_product_id: 10 }, ADMIN_PIN);
    expect(merge.status).toBe(200);
    expect(merge.body.data.ok).toBe(true);
  });

  test('merge com produtos iguais → 400', async () => {
    const r = await call('POST', '/api/v3/warehouse/family/merge',
      { from_product_id: 10, into_product_id: 10 }, ADMIN_PIN);
    expect(r.status).toBe(400);
  });
});

/* ── CADASTRO EM LOTE de prateleiras (Bruno 08-19) ────────────────────────
   Blocker #1 do S15: existem 0 bins e a picklist imprime "LOCAL A DEFINIR".
   Um corredor inteiro por chamada, e colar a lista de novo nunca sobrescreve
   o que alguém já ajustou na mão. */
describe('Warehouse hub — prateleiras em lote', () => {
  const BULK = '/api/v3/warehouse/locations/bins/bulk';

  test('cria a lista inteira, sem tocar em quantidade', async () => {
    const r = await call('POST', BULK, { bins: [
      { bin_code: 'A01A1', shelf: 'S1', area: 'Corredor A', product_id: 10, capacity: 48 },
      { bin_code: 'A01A2', shelf: 'S1', area: 'Corredor A' },
      { bin_code: 'A01A3' },
    ] }, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ created: 3, skipped: [] });
    expect(state.bins.map((b) => b.bin_code)).toEqual(['A01A1', 'A01A2', 'A01A3']);
    expect(state.bins.every((b) => b.qty === 0)).toBe(true);
    // `shelf` da tela chega em shelf_code (a coluna); nada de recusar pelo nome do campo
    expect(state.bins[0].shelf_code).toBe('S1');
    expect(stock.calls).toHaveLength(0);          // nenhuma escrita de estoque
  });

  test('código repetido é PULADO, nunca sobrescrito', async () => {
    await call('POST', BULK, { bins: [{ bin_code: 'A01A1', product_id: 10 }] }, ADMIN_PIN);
    const again = await call('POST', BULK, { bins: [
      { bin_code: 'A01A1', product_id: 99 },      // tentativa de reescrever o produto
      { bin_code: 'A01B1' },
    ] }, ADMIN_PIN);
    expect(again.body.data.created).toBe(1);
    expect(again.body.data.skipped).toEqual(['A01A1']);
    expect(state.bins.find((b) => b.bin_code === 'A01A1').product_id).toBe(10);   // intacto
  });

  test('normaliza pra maiúscula e recusa código comprido, sem derrubar o resto', async () => {
    const r = await call('POST', BULK, { bins: [
      { bin_code: ' a02b1 ' },
      { bin_code: 'ESTE-CODIGO-E-GRANDE-DEMAIS' },
      { bin_code: '' },
    ] }, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.created).toBe(1);
    expect(state.bins[0].bin_code).toBe('A02B1');
    expect(r.body.data.skipped).toContain('ESTE-CODIGO-E-GRANDE-DEMAIS');
  });

  test('lista vazia, ausente ou acima do teto → 400 com mensagem em PT-BR', async () => {
    expect((await call('POST', BULK, {}, ADMIN_PIN)).status).toBe(400);
    expect((await call('POST', BULK, { bins: [] }, ADMIN_PIN)).status).toBe(400);
    const many = Array.from({ length: 301 }, (_, i) => ({ bin_code: 'Z' + i }));
    const big = await call('POST', BULK, { bins: many }, ADMIN_PIN);
    expect(big.status).toBe(400);
    expect(big.body.error.message).toMatch(/300/);
    expect(big.body.error.message).not.toMatch(/—/);
    expect(state.bins).toHaveLength(0);
  });

  test('só nomes vazios na lista → 400, nada criado', async () => {
    const r = await call('POST', BULK, { bins: [{ bin_code: '  ' }, { bin_code: null }] }, ADMIN_PIN);
    expect(r.status).toBe(400);
    expect(state.bins).toHaveLength(0);
  });

  test('exige manage_stock e audita uma linha só', async () => {
    const viewer = await call('POST', BULK, { bins: [{ bin_code: 'A09A9' }] }, VIEWER_PIN);
    expect(viewer.status).toBe(403);
    expect(state.bins).toHaveLength(0);
    await call('POST', BULK, { bins: [{ bin_code: 'A09A9' }, { bin_code: 'A09B9' }] }, ADMIN_PIN);
    expect(state.audit.filter((a) => a === 'warehouse.bins_bulk')).toHaveLength(1);
  });
});

/* ── RESUMO DA FILA no overview (contrato 3) ──────────────────────────────
   Uma frase: quantas propostas esperam e há quanto tempo a mais velha espera.
   É o que decide se alguém para tudo pra ir aprovar agora. */
describe('Warehouse hub — pending_summary do overview', () => {
  test('fila vazia: zero e idade null (nunca 0 minutos, que pareceria uma proposta nova)', async () => {
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, ADMIN_PIN);
    expect(r.body.data.pending_summary).toEqual({ count: 0, oldest_age_min: null });
  });

  test('conta as pendentes e leva a idade da MAIS VELHA', async () => {
    state.pending = [{ age_min: 12 }, { age_min: 240 }, { age_min: 3 }];
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, ADMIN_PIN);
    expect(r.body.data.pending_summary).toEqual({ count: 3, oldest_age_min: 240 });
  });

  test('vem junto dos produtos e dos KPIs, numa chamada só', async () => {
    state.pending = [{ age_min: 5 }];
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, ADMIN_PIN);
    expect(r.body.data.products).toHaveLength(1);
    expect(r.body.data.kpis).toBeTruthy();
    expect(r.body.data.pending_summary.count).toBe(1);
  });
});
