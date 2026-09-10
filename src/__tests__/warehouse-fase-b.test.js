'use strict';
/**
 * FASE B do controle de estoque (Bruno 09-10: fabrica, "toda acao anotada", Desfazer).
 *  - StockService.takeOut: saida sem venda / transferencia, com motivo, floor em 0
 *  - StockService.reverse: inverso ligado ao original, 24 h, uma vez, kinds certos
 *  - rotas: /reasons, /product/:id/take, /transfer, /movements/:id/reverse, /movements, /batches
 *  - entrada/count carregam reason_code + referencia (lote / pedido)
 * Mini-DB em memoria pro service; router com services mockados. PINs FICTICIOS.
 */
const express = require('express');
const { StockService } = require('../v3/services/StockService');
const { createWarehouseRouter } = require('../v3/warehouse/router');
const { createVeeqoCache } = require('../v3/warehouse/veeqo-cache');

/* ── mini-DB pro StockService (bins, boxes, unplaced, movements, audit) ── */
function miniDb(seed = {}) {
  const st = {
    bins: new Map((seed.bins || []).map((b) => [b.id, { ...b }])),
    boxes: new Map((seed.boxes || []).map((b) => [b.id, { ...b }])),
    unplaced: new Map(), movements: [], audit: [], nextId: 1,
  };
  const api = {
    st,
    async connect() { return api; }, release() {},
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(q)) return {};
      if (q.startsWith('SELECT * FROM v3.stock_movements WHERE source')) {
        const m = st.movements.find((x) => x.source === params[0] && x.source_ref === params[1]);
        return { rows: m ? [{ ...m }] : [] };
      }
      if (q.startsWith('SELECT * FROM v3.stock_movements WHERE id')) {
        const m = st.movements.find((x) => x.id === params[0]); return { rows: m ? [{ ...m }] : [] };
      }
      if (q.startsWith('SELECT id FROM v3.stock_movements WHERE reverses_movement_id')) {
        const m = st.movements.find((x) => x.reverses_movement_id === params[0]); return { rows: m ? [{ id: m.id }] : [] };
      }
      if (q.startsWith('INSERT INTO v3.stock_movements')) {
        const [kind, product_id, qty, bin_id, box_id, person_id, source, source_ref, , note, is_test, actor_login_id, actor_name, reason_code, ref_type, ref_id, reverses_movement_id] = params;
        if (source_ref && st.movements.some((m) => m.source === source && m.source_ref === source_ref)) return { rows: [] };
        const row = { id: st.nextId++, kind, product_id, qty, bin_id, box_id, person_id, source, source_ref, note, is_test,
          actor_login_id, actor_name, reason_code, ref_type, ref_id, reverses_movement_id, created_at: seed.now ? seed.now() : new Date() };
        st.movements.push(row); return { rows: [{ ...row }] };
      }
      if (q.startsWith('SELECT * FROM v3.stock_bins WHERE id')) { const b = st.bins.get(params[0]); return { rows: b ? [{ ...b }] : [] }; }
      if (q.startsWith('SELECT * FROM v3.stock_boxes WHERE id')) { const b = st.boxes.get(params[0]); return { rows: b ? [{ ...b }] : [] }; }
      if (q.startsWith('SELECT * FROM v3.stock_bins WHERE product_id')) {
        const c = [...st.bins.values()].filter((b) => b.product_id === params[0] && b.active !== false && b.qty > 0).sort((a, b) => b.qty - a.qty);
        return { rows: c.slice(0, 1) };
      }
      if (q.startsWith('SELECT * FROM v3.stock_boxes WHERE product_id')) {
        const c = [...st.boxes.values()].filter((b) => b.product_id === params[0] && b.status === 'in_storage' && b.qty > 0).sort((a, b) => b.qty - a.qty);
        return { rows: c.slice(0, 1) };
      }
      if (q.startsWith('UPDATE v3.stock_bins SET qty')) { st.bins.get(params[0]).qty = params[1]; return {}; }
      if (q.startsWith('UPDATE v3.stock_boxes SET qty')) { const b = st.boxes.get(params[0]); b.qty = params[1]; b.status = params[2]; return {}; }
      if (q.startsWith('SELECT * FROM v3.stock_unplaced')) { const u = st.unplaced.get(params[0]); return { rows: u != null ? [{ product_id: params[0], qty: u }] : [] }; }
      if (q.startsWith('INSERT INTO v3.stock_unplaced')) { st.unplaced.set(params[0], params[1]); return {}; }
      if (q.startsWith('INSERT INTO v3.audit_log')) { st.audit.push(params[2]); return {}; }
      throw new Error('mini-db: query desconhecida: ' + q.slice(0, 80));
    },
  };
  return api;
}

describe('StockService.takeOut — saída sem venda e transferência', () => {
  test('take deduz da prateleira com mais, exige motivo, grava ator/motivo/referência', async () => {
    const db = miniDb({ bins: [{ id: 4, product_id: 10, qty: 30, active: true }, { id: 5, product_id: 10, qty: 5, active: true }] });
    const s = new StockService({ db });
    const out = await s.takeOut({ product_id: 10, qty: 3, kind: 'take', reason_code: 'amostra', source: 'warehouse_hub',
      actor_login_id: 1, actor_name: 'Henrique', ref_type: 'order', ref_id: '12-345', note: 'pro cliente' });
    expect(out.applied).toBe(3);
    expect(db.st.bins.get(4).qty).toBe(27);
    const m = db.st.movements[0];
    expect(m).toMatchObject({ kind: 'take', qty: -3, bin_id: 4, reason_code: 'amostra', ref_type: 'order', ref_id: '12-345', actor_name: 'Henrique', actor_login_id: 1 });
    expect(db.st.audit).toContain('stock.take');
  });
  test('sem motivo → erro, nada muda', async () => {
    const db = miniDb({ bins: [{ id: 4, product_id: 10, qty: 30, active: true }] });
    await expect(new StockService({ db }).takeOut({ product_id: 10, qty: 1, source: 'x' })).rejects.toThrow(/motivo/);
    expect(db.st.movements).toHaveLength(0);
  });
  test('transfer: floor em 0 + discrepância quando a caixa não tem tudo', async () => {
    const db = miniDb({ boxes: [{ id: 9, product_id: 10, qty: 4, status: 'in_storage' }] });
    const disc = [];
    const s = new StockService({ db, onDiscrepancy: async (d) => disc.push(d) });
    const out = await s.takeOut({ product_id: 10, qty: 10, kind: 'transfer', reason_code: 'transferencia', box_id: 9, source: 'warehouse_hub', ref_type: 'shipment', ref_id: 'FBA-77' });
    expect(out.applied).toBe(4);
    expect(db.st.boxes.get(9).qty).toBe(0);
    expect(db.st.boxes.get(9).status).toBe('empty');
    expect(db.st.movements[0]).toMatchObject({ kind: 'transfer', qty: -4, box_id: 9, ref_id: 'FBA-77' });
    expect(disc[0].kind).toBe('insufficient_stock');
  });
  test('idempotente por source_ref', async () => {
    const db = miniDb({ bins: [{ id: 4, product_id: 10, qty: 30, active: true }] });
    const s = new StockService({ db });
    await s.takeOut({ product_id: 10, qty: 2, reason_code: 'uso_interno', source: 'warehouse_hub', source_ref: 'take:abc' });
    const again = await s.takeOut({ product_id: 10, qty: 2, reason_code: 'uso_interno', source: 'warehouse_hub', source_ref: 'take:abc' });
    expect(again.duplicate).toBe(true);
    expect(db.st.bins.get(4).qty).toBe(28);
  });
});

describe('StockService.reverse — Desfazer 24 h', () => {
  test('desfaz uma saída: devolve ao mesmo local, liga ao original, uma vez só', async () => {
    const db = miniDb({ bins: [{ id: 4, product_id: 10, qty: 30, active: true }] });
    const s = new StockService({ db });
    const t = await s.takeOut({ product_id: 10, qty: 3, reason_code: 'amostra', source: 'warehouse_hub' });
    const r = await s.reverse({ movement_id: t.movement.id, source: 'warehouse_hub', actor_name: 'Admin', actor_login_id: 1 });
    expect(r.applied).toBe(3);
    expect(db.st.bins.get(4).qty).toBe(30);
    expect(r.movement).toMatchObject({ kind: 'take', qty: 3, bin_id: 4, reverses_movement_id: t.movement.id, reason_code: 'amostra', actor_name: 'Admin' });
    await expect(s.reverse({ movement_id: t.movement.id, source: 'warehouse_hub' })).rejects.toThrow(/já foi desfeito/);
    await expect(s.reverse({ movement_id: r.movement.id, source: 'warehouse_hub' })).rejects.toThrow(/já é um desfazer/);
  });
  test('desfaz uma entrada em A organizar (sem local)', async () => {
    const db = miniDb({});
    const s = new StockService({ db });
    const e = await s.storeIn({ product_id: 10, qty: 12, source: 'warehouse_hub', reason_code: 'producao', ref_type: 'batch', ref_id: 'BR-2026-0431' });
    expect(db.st.unplaced.get(10)).toBe(12);
    const r = await s.reverse({ movement_id: e.movement.id, source: 'warehouse_hub' });
    expect(r.applied).toBe(-12);
    expect(db.st.unplaced.get(10)).toBe(0);
  });
  test('place desfeito volta pro A organizar', async () => {
    const db = miniDb({ bins: [{ id: 4, product_id: 10, qty: 0, active: true }] });
    const s = new StockService({ db });
    await s.storeIn({ product_id: 10, qty: 10, source: 'warehouse_hub' });
    const pl = await s.place({ product_id: 10, qty: 10, bin_id: 4, source: 'warehouse_hub' });
    expect(db.st.bins.get(4).qty).toBe(10); expect(db.st.unplaced.get(10)).toBe(0);
    await s.reverse({ movement_id: pl.movement.id, source: 'warehouse_hub' });
    expect(db.st.bins.get(4).qty).toBe(0); expect(db.st.unplaced.get(10)).toBe(10);
  });
  test('mais de 24 h → recusa; venda da Veeqo → recusa; kind não reversível → recusa', async () => {
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    const db = miniDb({ bins: [{ id: 4, product_id: 10, qty: 30, active: true }], now: () => old });
    const s = new StockService({ db });
    const t = await s.takeOut({ product_id: 10, qty: 1, reason_code: 'amostra', source: 'warehouse_hub' });
    await expect(s.reverse({ movement_id: t.movement.id, source: 'warehouse_hub' })).rejects.toThrow(/24 h/);
    const db2 = miniDb({ bins: [{ id: 4, product_id: 10, qty: 30, active: true }] });
    const s2 = new StockService({ db: db2 });
    const sale = await s2.pick({ product_id: 10, qty: 1, bin_id: 4, source: 'veeqo_ship', source_ref: 'o1:l1' });
    await expect(s2.reverse({ movement_id: sale.movement.id, source: 'warehouse_hub' })).rejects.toThrow(/não pode ser desfeito|Veeqo/);
  });
});

/* ── router ── */
const ADMIN_PIN = '111111';
function baseRow() {
  return { product_id: 10, name: 'Benfotiamine 300mg', nickname: 'BENF-300', base_sku: 'HF-BENF-300',
    skus: [{ id: 1, sku: 'HF-BENF-300', channel: 'veeqo', units_per_pack: 1, confirmed: true, role: 'base' }],
    shelf_qty: 46, box_qty: 180, unplaced_qty: 0, total: 226, reserved: 12, available: 214, separated: 0,
    veeqo: { physical: 226 }, veeqo_total: 226, status: ['ok'], bins: [{ id: 4, bin_code: 'A03', qty: 46 }], boxes: [] };
}
let server, base, stock, movements, state;
async function boot() {
  if (server) await new Promise((r) => server.close(r));
  state = { audit: [] };
  const rows = [baseRow()];
  const op = (name) => jest.fn(async (p) => ({ movement: { id: 900, kind: name }, duplicate: false, applied: p.qty || 0, bin: null, box: null, original: { product_id: 10 } }));
  stock = { overview: async (o) => rows.map((r) => ({ ...r })), productDetail: async () => ({ product: rows[0], open_orders: [], movements: [], issues: [], requests: [] }),
    storeIn: op('store_in'), count: op('count'), takeOut: op('take'), reverse: op('reverse'), place: op('place'), move: op('move'), adjust: op('adjust'), separate: op('separate') };
  const REASONS = { amostra: { code: 'amostra', label_pt: 'Amostra', direction: 'out' }, venda: { code: 'venda', label_pt: 'Venda', direction: 'out' },
    producao: { code: 'producao', label_pt: 'Produção', direction: 'in' }, contagem: { code: 'contagem', label_pt: 'Contagem', direction: 'count' } };
  movements = {
    reasons: async () => Object.values(REASONS),
    requireReason: async (code, dirs) => {
      const bad = (m) => { const e = new Error(m); e.status = 400; e.code = 'bad_reason'; return e; };
      if (!code) throw bad('motivo obrigatório');
      const r = REASONS[code]; if (!r) throw bad('motivo inválido: ' + code);
      if (dirs && !dirs.includes(r.direction)) throw bad(`motivo "${r.label_pt}" não vale pra esta ação`);
      return r;
    },
    list: jest.fn(async (o) => ({ rows: [{ id: 1, kind: 'take', qty: -3, product: 'BENF-300' }], total: 1, limit: 100, offset: 0, opts: o })),
    csv: jest.fn(async () => 'quando;produto\n2026-09-10;BENF-300'),
    batches: jest.fn(async () => [{ id: 5, batch_number: 'BR-2026-0431', produced: 480, received: 0 }]),
  };
  const db = { async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/FROM v3\.app_logins l/.test(q)) return params[0] === ADMIN_PIN ? { rows: [{ id: 1, name: 'Henrique', role: 'manager', rank: 50, functions: ['view_stock', 'manage_stock'] }] } : { rows: [] };
    if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push(params[1]); return { rows: [] }; }
    if (/COUNT\(\*\)::int AS count/.test(q)) return { rows: [{ count: 0, oldest_age_min: null }] };
    return { rows: [] };
  } };
  const veeqoCache = createVeeqoCache({ veeqo: { listSellables: async () => [{ sku: 'HF-BENF-300', type: 'variant', wh: { physical: 226 } }] } });
  await veeqoCache.warm();
  const app = express();
  app.use('/', createWarehouseRouter({ db, stock, requests: { list: async () => [] }, veeqoCache, movements }));
  server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
}
async function call(method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-admin-pin': ADMIN_PIN }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (_) { j = null; }
  return { status: r.status, body: j, text, type: r.headers.get('content-type') || '' };
}
beforeEach(boot);
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('rotas da Fase B', () => {
  test('GET /reasons lista os motivos', async () => {
    const r = await call('GET', '/api/v3/warehouse/reasons');
    expect(r.status).toBe(200); expect(r.body.data.reasons.map((x) => x.code)).toContain('amostra');
  });
  test('POST take: motivo obrigatório e de saída; venda/transferência recusadas', async () => {
    let r = await call('POST', '/api/v3/warehouse/product/10/take', { qty: 3 });
    expect(r.status).toBe(400); expect(r.body.error.message).toMatch(/motivo/);
    r = await call('POST', '/api/v3/warehouse/product/10/take', { qty: 3, reason_code: 'venda' });
    expect(r.status).toBe(400);
    r = await call('POST', '/api/v3/warehouse/product/10/take', { qty: 3, reason_code: 'producao' });
    expect(r.status).toBe(400);
    r = await call('POST', '/api/v3/warehouse/product/10/take', { qty: 3, reason_code: 'amostra', order_number: '12-345', client_ref: 'X1', note: 'cliente' });
    expect(r.status).toBe(200);
    expect(stock.takeOut.mock.calls[0][0]).toMatchObject({ product_id: 10, qty: 3, kind: 'take', reason_code: 'amostra', ref_type: 'order', ref_id: '12-345', source_ref: 'take:x1', actor_name: 'Henrique' });
    expect(state.audit).toContain('warehouse.take');
  });
  test('POST transfer: destino válido, remessa como referência, kind transfer', async () => {
    let r = await call('POST', '/api/v3/warehouse/product/10/transfer', { qty: 50, destination: 'marte' });
    expect(r.status).toBe(400);
    r = await call('POST', '/api/v3/warehouse/product/10/transfer', { qty: 50, destination: 'fba', shipment_ref: 'FBA15ABC', bin_id: 4 });
    expect(r.status).toBe(200);
    expect(stock.takeOut.mock.calls[0][0]).toMatchObject({ kind: 'transfer', reason_code: 'transferencia', ref_type: 'shipment', ref_id: 'FBA15ABC', bin_id: 4 });
    expect(stock.takeOut.mock.calls[0][0].note).toMatch(/FBA \(Amazon\)/);
  });
  test('POST movements/:id/reverse chama o desfazer com o ator', async () => {
    const r = await call('POST', '/api/v3/warehouse/movements/77/reverse', { note: 'digitei errado' });
    expect(r.status).toBe(200);
    expect(stock.reverse.mock.calls[0][0]).toMatchObject({ movement_id: 77, actor_name: 'Henrique', source: 'warehouse_hub' });
    expect(state.audit).toContain('warehouse.reverse');
  });
  test('GET /movements filtra e pagina; format=csv devolve CSV', async () => {
    let r = await call('GET', '/api/v3/warehouse/movements?product_id=10&reason=amostra&from=2026-09-01&limit=50');
    expect(r.status).toBe(200); expect(r.body.data.total).toBe(1);
    expect(movements.list.mock.calls[0][0]).toMatchObject({ product_id: '10', reason: 'amostra', from: '2026-09-01', limit: '50' });
    r = await call('GET', '/api/v3/warehouse/movements?format=csv');
    expect(r.status).toBe(200); expect(r.type).toMatch(/text\/csv/); expect(r.text).toMatch(/quando;produto/);
  });
  test('GET /product/:id/batches devolve lotes com produzido/recebido', async () => {
    const r = await call('GET', '/api/v3/warehouse/product/10/batches');
    expect(r.status).toBe(200); expect(r.body.data.batches[0]).toMatchObject({ batch_number: 'BR-2026-0431', produced: 480 });
  });
  test('entrada com motivo de produção e lote vira referência no storeIn', async () => {
    const r = await call('POST', '/api/v3/warehouse/product/10/entrada', { qty: 20, reason_code: 'producao', batch_number: 'BR-2026-0431' });
    expect(r.status).toBe(200);
    expect(stock.storeIn.mock.calls[0][0]).toMatchObject({ qty: 20, reason_code: 'producao', ref_type: 'batch', ref_id: 'BR-2026-0431' });
    const bad = await call('POST', '/api/v3/warehouse/product/10/entrada', { qty: 20, reason_code: 'amostra' });
    expect(bad.status).toBe(400);
  });
});
