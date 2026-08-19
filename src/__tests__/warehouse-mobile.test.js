'use strict';
/**
 * WAREHOUSE MOBILE — /api/v3/warehouse/mobile/* (S15.35, Bruno 08-19).
 *
 *  1. bootstrap: uma chamada abre o app; sem ?full=1 só vem quem precisa de atenção
 *  2. os números do celular são OS MESMOS do dashboard (mesma fonte, sem recálculo)
 *  3. scan/resolve com PIN de admin resolve bin, caixa, produto e desconhecido
 *  4. print/submit resolve as etiquetas AGORA e congela no payload da fila
 *  5. printers: recorte de bolso, só leitura
 *  6. nada aqui escreve quantidade de estoque, nunca
 *
 * Mesmo padrão do warehouse-router.test.js: Express de verdade, services mockados.
 * PINs FICTÍCIOS.
 */
const express = require('express');
const { createWarehouseRouter } = require('../v3/warehouse/router');

const ADMIN_PIN = '111111';    // fictício: manage_stock
const VIEWER_PIN = '222222';   // fictício: só view_stock
const OP_PIN = '333333';       // fictício: sem função de estoque

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
      if (/COUNT\(\*\)::int AS count/.test(q) && /stock_change_requests/.test(q)) {
        const pend = state.pending || [];
        return { rows: [{ count: pend.length,
          oldest_age_min: pend.length ? Math.max(...pend.map((p) => p.age_min)) : null }] };
      }
      // etiquetas: bins e caixas por id
      if (/FROM v3\.stock_bins b/.test(q) && /ANY\(\$1::int\[\]\)/.test(q)) {
        return { rows: state.bins.filter((b) => params[0].includes(b.id)) };
      }
      if (/FROM v3\.stock_boxes x/.test(q) && /ANY\(\$1::int\[\]\)/.test(q)) {
        return { rows: state.boxes.filter((x) => params[0].includes(x.id)) };
      }
      // locais (LocationsRepo.list)
      if (/FROM v3\.stock_bins b/.test(q)) return { rows: state.bins };
      if (/FROM v3\.stock_boxes x/.test(q)) return { rows: state.boxes };
      if (/FROM v3\.product_skus WHERE product_id/.test(q)) return { rows: [] };
      // impressoras
      if (/FROM v3\.printer_status/.test(q)) return { rows: state.printers };
      if (/FROM v3\.print_jobs/.test(q)) return { rows: state.printJobs };
      return { rows: [] };
    },
  };
}

function baseRow(over = {}) {
  return {
    product_id: 10, name: 'Benfotiamine 300 mg', nickname: 'BENF-300', bottle_color: 'black',
    base_sku: 'HF-BENF-300',
    skus: [{ id: 1, sku: 'HF-BENF-300', channel: 'veeqo', units_per_pack: 1, role: 'base' }],
    shelf_qty: 46, box_qty: 180, unplaced_qty: 0, total: 226,
    reserved: 12, pending_out: 0, pending_in: 0, available: 214, separated: 2,
    min_units: null, days_of_stock: 21.4, sold_7d: 70, sold_30d: 280,
    veeqo: null, veeqo_match: 'unknown', status: ['ok'],
    bins: [{ id: 1, bin_code: 'A03', shelf_code: 'S2', area: 'A', qty: 46, min_qty: 10, needs_restock: false }],
    boxes: [{ id: 5, box_number: 'BOX-004', area: 'P1', qty: 180 }],
    ...over,
  };
}

function makeStock(rows) {
  const calls = [];
  const op = (name) => jest.fn(async (p) => { calls.push({ name, p }); return { applied: p.qty || 0 }; });
  return {
    calls,
    overview: jest.fn(async (o) => (o && o.product_id
      ? rows.filter((r) => r.product_id === o.product_id).map((r) => JSON.parse(JSON.stringify(r)))
      : rows.map((r) => JSON.parse(JSON.stringify(r))))),
    productDetail: jest.fn(async () => null),
    storeIn: op('storeIn'), place: op('place'), move: op('move'), adjust: op('adjust'),
    separate: op('separate'), pick: op('pick'), count: op('count'),
    resolveIssue: op('resolveIssue'),
  };
}

function makeRequests(rows) {
  return {
    list: jest.fn(async (o) => rows.filter((r) => !o.status || r.status === o.status)),
    propose: jest.fn(), approve: jest.fn(), reject: jest.fn(),
    pendingByProduct: jest.fn(async () => ({})),
  };
}

/** Fila falsa: guarda o que foi enfileirado (o teste olha o payload congelado). */
function makeQueue(state) {
  return {
    enqueue: jest.fn(async (p) => {
      const job = Object.assign({ id: state.queue.length + 1, status: 'queued' }, p);
      state.queue.push(job);
      return job;
    }),
    queuedCount: jest.fn(async () => state.queue.filter((j) => j.status === 'queued').length),
  };
}

/** op-warehouse falso: só o resolveBarcode importa aqui (o real é testado em op-warehouse.test.js). */
const fakeOpWarehouse = {
  resolveBarcode: jest.fn(async (raw) => {
    if (raw === 'A03') return { kind: 'bin', bin: { id: 1, bin_code: 'A03', product_id: 10 } };
    if (raw === 'BOX-004') return { kind: 'box', box: { id: 5, box_number: 'BOX-004', product_id: 10 } };
    if (raw === '850001234567') return { kind: 'product', product: { product_id: 10, name: 'Benfotiamine 300 mg' } };
    return { kind: 'unknown', raw };
  }),
};

const fakeVeeqo = (physical = 226) => ({
  listSellables: async () => ([
    { sku: 'HF-BENF-300', type: 'variant', wh: { physical, allocated: 12, available: physical - 12 } },
  ]),
});

let server, base, state, stock, requests;

async function boot(rows, opts = {}) {
  if (server) await new Promise((r) => server.close(r));
  state = {
    audit: [], queue: [], pending: opts.pending || [],
    bins: opts.bins || [{ id: 1, bin_code: 'A03', shelf_code: 'S2', area: 'Corredor A',
      product_id: 10, qty: 46, min_qty: 10, capacity: 48, active: true, product: 'BENF-300' }],
    boxes: opts.boxes || [{ id: 5, box_number: 'BOX-004', area: 'P1', product_id: 10, qty: 180,
      status: 'in_storage', batch_number: 'L-77', sealed: true, product: 'BENF-300' }],
    printers: opts.printers || [
      { printer: 'EPSON C6000', status_label: 'Ready', error_label: 'none', updated_at: '2026-08-19T12:00:00Z' },
      { printer: 'Zebra 4x6', status_label: 'Offline', error_label: 'paper out', updated_at: '2026-08-19T11:00:00Z' },
    ],
    printJobs: opts.printJobs || [{ printer: 'EPSON C6000', jobs: 12 }],
  };
  stock = makeStock(rows);
  requests = makeRequests(opts.requestRows || []);
  const { createVeeqoCache } = require('../v3/warehouse/veeqo-cache');
  const veeqoCache = createVeeqoCache({ veeqo: opts.veeqo || fakeVeeqo() });
  await veeqoCache.warm();
  const app = express();
  app.use('/', createWarehouseRouter({
    db: makeDb(state), stock, requests, veeqoCache,
    printQueue: makeQueue(state), opWarehouse: fakeOpWarehouse,
  }));
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

const M = '/api/v3/warehouse/mobile';

beforeEach(async () => { await boot([baseRow()]); });
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('Mobile — auth (a MESMA do hub, nenhuma credencial nova)', () => {
  test('sem PIN → 401', async () => {
    expect((await call('GET', M + '/bootstrap')).status).toBe(401);
  });

  test('operador sem view_stock → 403', async () => {
    const r = await call('GET', M + '/bootstrap', undefined, OP_PIN);
    expect(r.status).toBe(403);
  });

  test('view_stock abre o app mas não manda imprimir (403)', async () => {
    expect((await call('GET', M + '/bootstrap', undefined, VIEWER_PIN)).status).toBe(200);
    const p = await call('POST', M + '/print/submit', { kind: 'box_label', boxes: [5] }, VIEWER_PIN);
    expect(p.status).toBe(403);
    expect(state.queue).toHaveLength(0);
  });
});

describe('Mobile — bootstrap', () => {
  test('shape do contrato: uma chamada traz tudo que a home precisa', async () => {
    const r = await call('GET', M + '/bootstrap', undefined, ADMIN_PIN);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(Object.keys(d).sort()).toEqual([
      'attention', 'generated_at', 'kpis', 'locations', 'me', 'pending_summary',
      'products', 'products_full', 'products_total', 'queue', 'requests',
    ].sort());
    expect(d.me).toEqual({ name: 'Henrique', role: 'manager',
      functions: ['view_stock', 'manage_stock'] });
    expect(d.queue).toEqual({ queued: 0 });
    expect(d.generated_at).toBeTruthy();
  });

  test('sem ?full=1 a lista é SÓ quem precisa de atenção (a home não é catálogo)', async () => {
    await boot([baseRow(), baseRow({ product_id: 11, nickname: 'MAGN-400', status: ['low'] })]);
    const r = await call('GET', M + '/bootstrap', undefined, ADMIN_PIN);
    expect(r.body.data.products.map((p) => p.product_id)).toEqual([11]);
    expect(r.body.data.products_full).toBe(false);
    expect(r.body.data.products_total).toBe(2);          // o celular sabe que tem mais
  });

  test('?full=1 traz o catálogo inteiro', async () => {
    await boot([baseRow(), baseRow({ product_id: 11, nickname: 'MAGN-400', status: ['low'] })]);
    const r = await call('GET', M + '/bootstrap?full=1', undefined, ADMIN_PIN);
    expect(r.body.data.products.map((p) => p.product_id)).toEqual([10, 11]);
    expect(r.body.data.products_full).toBe(true);
  });

  test('o produto vem enxuto: os números que decidem, sem bins/boxes/skus', async () => {
    const r = await call('GET', M + '/bootstrap?full=1', undefined, ADMIN_PIN);
    const p = r.body.data.products[0];
    expect(Object.keys(p).sort()).toEqual([
      'available', 'base_sku', 'box_qty', 'days_of_stock', 'name', 'nickname',
      'product_id', 'reserved', 'shelf_qty', 'status', 'total', 'unplaced_qty', 'veeqo_match',
    ].sort());
    expect(p.total).toBe(226);
    expect(p.available).toBe(214);
    expect(p.days_of_stock).toBe(21.4);
    expect(p.bins).toBeUndefined();
    expect(p.skus).toBeUndefined();
  });

  test('os números do celular são OS MESMOS do dashboard', async () => {
    const mob = await call('GET', M + '/bootstrap?full=1', undefined, ADMIN_PIN);
    const web = await call('GET', '/api/v3/warehouse/overview', undefined, ADMIN_PIN);
    expect(mob.body.data.kpis).toEqual(web.body.data.kpis);
    expect(mob.body.data.pending_summary).toEqual(web.body.data.pending_summary);
    expect(mob.body.data.attention).toEqual(web.body.data.attention);
    expect(mob.body.data.products[0].total).toBe(web.body.data.products[0].total);
  });

  test('a fila de propostas vem junto, com teto de 50', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, status: 'pending', qty: 3 }));
    await boot([baseRow()], { requestRows: many, pending: many.map(() => ({ age_min: 5 })) });
    const r = await call('GET', M + '/bootstrap', undefined, ADMIN_PIN);
    expect(r.body.data.requests).toHaveLength(50);
    expect(r.body.data.pending_summary.count).toBe(80);   // o resumo continua honesto
  });

  test('locais vêm no formato de seletor (id + código + produto + quanto)', async () => {
    const r = await call('GET', M + '/bootstrap', undefined, ADMIN_PIN);
    expect(r.body.data.locations.bins[0]).toEqual({ id: 1, bin_code: 'A03', shelf_code: 'S2',
      area: 'Corredor A', product_id: 10, qty: 46, capacity: 48 });
    expect(r.body.data.locations.boxes[0]).toEqual({ id: 5, box_number: 'BOX-004', area: 'P1',
      product_id: 10, qty: 180, batch_number: 'L-77', sealed: true });
  });

  test('atenção em PT-BR, sem em dash', async () => {
    await boot([baseRow({ shelf_qty: 0, box_qty: 110, total: 110, available: 100,
      status: ['out'], bins: [], boxes: [{ id: 5, box_number: 'BOX-012', area: 'P1', qty: 110 }] })],
    { veeqo: fakeVeeqo(110) });
    const r = await call('GET', M + '/bootstrap', undefined, ADMIN_PIN);
    const out = r.body.data.attention.find((a) => a.kind === 'out');
    expect(out.text).toBe('BENF-300 · zerado na prateleira, caixa BOX-012 tem 110');
    for (const a of r.body.data.attention) expect(a.text).not.toMatch(/—/);
  });

  test('bootstrap não escreve estoque nenhum', async () => {
    await call('GET', M + '/bootstrap?full=1', undefined, ADMIN_PIN);
    expect(stock.calls).toHaveLength(0);
  });
});

describe('Mobile — ler código com a câmera', () => {
  test('bin, caixa e produto resolvem igual ao operador', async () => {
    const bin = await call('GET', M + '/scan/resolve?barcode=A03', undefined, ADMIN_PIN);
    expect(bin.body.data).toEqual({ raw: 'A03', kind: 'bin', bin: { id: 1, bin_code: 'A03', product_id: 10 } });

    const box = await call('GET', M + '/scan/resolve?barcode=BOX-004', undefined, ADMIN_PIN);
    expect(box.body.data.kind).toBe('box');

    const upc = await call('GET', M + '/scan/resolve?barcode=850001234567', undefined, ADMIN_PIN);
    expect(upc.body.data.kind).toBe('product');
    expect(upc.body.data.product.product_id).toBe(10);
  });

  test('código que ninguém conhece volta unknown com o texto lido (nunca erro)', async () => {
    const r = await call('GET', M + '/scan/resolve?barcode=XYZ999', undefined, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.kind).toBe('unknown');
    expect(r.body.data.raw).toBe('XYZ999');
  });

  test('sem barcode → 400', async () => {
    const r = await call('GET', M + '/scan/resolve', undefined, ADMIN_PIN);
    expect(r.status).toBe(400);
  });
});

describe('Mobile — mandar imprimir', () => {
  test('etiqueta de caixa: resolve AGORA e congela no payload da fila', async () => {
    const r = await call('POST', M + '/print/submit',
      { kind: 'box_label', boxes: [5], note: 'pra selar hoje' }, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.job_id).toBe(1);
    expect(r.body.data.queued).toBe(1);
    expect(r.body.data.labels[0]).toEqual({ kind: 'box', id: 5, code: 'BOX-004',
      line2: 'BENF-300', line3: '180 garrafas · lote L-77', url: '/scan/?x=BOX-004' });
    // o que entrou na fila é exatamente o que o admin viu
    expect(state.queue[0].kind).toBe('box_label');
    expect(state.queue[0].payload.labels).toEqual(r.body.data.labels);
    expect(state.queue[0].payload.note).toBe('pra selar hoje');
    expect(state.queue[0].requested_by).toBe('Henrique');
    expect(state.queue[0].requested_login_id).toBe(1);
  });

  test('a etiqueta do celular é IGUAL à do GET /labels (uma montagem só)', async () => {
    const web = await call('GET', '/api/v3/warehouse/labels?boxes=5', undefined, ADMIN_PIN);
    const mob = await call('POST', M + '/print/submit', { kind: 'box_label', boxes: [5] }, ADMIN_PIN);
    expect(mob.body.data.labels).toEqual(web.body.data.labels);
  });

  test('prateleiras em lote entram numa fila só', async () => {
    const r = await call('POST', M + '/print/submit', { kind: 'bin_labels', bins: [1] }, ADMIN_PIN);
    expect(r.body.data.queued).toBe(1);
    expect(r.body.data.labels[0]).toMatchObject({ kind: 'bin', code: 'A03', url: '/scan/?b=A03' });
  });

  test('picklist não tem etiqueta: o payload é a data', async () => {
    const r = await call('POST', M + '/print/submit', { kind: 'picklist', date: '2026-08-19' }, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.queued).toBe(1);
    expect(r.body.data.labels).toEqual([]);
    expect(state.queue[0].payload.date).toBe('2026-08-19');
  });

  test('kind desconhecido e lista vazia → 400 em PT-BR', async () => {
    const kind = await call('POST', M + '/print/submit', { kind: 'shipping' }, ADMIN_PIN);
    expect(kind.status).toBe(400);
    expect(kind.body.error.message).not.toMatch(/—/);
    const vazio = await call('POST', M + '/print/submit', { kind: 'box_label' }, ADMIN_PIN);
    expect(vazio.status).toBe(400);
    expect(vazio.body.error.message).toMatch(/pelo menos uma prateleira ou caixa/);
    expect(state.queue).toHaveLength(0);
  });

  test('caixa que não existe → 404, e nada entra na fila', async () => {
    const ghost = await call('POST', M + '/print/submit', { kind: 'box_label', boxes: [999] }, ADMIN_PIN);
    expect(ghost.status).toBe(404);
    expect(ghost.body.error.code).toBe('not_found');
    expect(ghost.body.error.message).not.toMatch(/—/);
    expect(state.queue).toHaveLength(0);
  });

  test('acima de 60 etiquetas → 400 (papel de verdade, não vale a pena)', async () => {
    const many = Array.from({ length: 61 }, (_, i) => i + 1);
    const r = await call('POST', M + '/print/submit', { kind: 'bin_labels', bins: many }, ADMIN_PIN);
    expect(r.status).toBe(400);
    expect(state.queue).toHaveLength(0);
  });

  test('enfileirar deixa UMA linha de auditoria e não escreve estoque', async () => {
    await call('POST', M + '/print/submit', { kind: 'box_label', boxes: [5] }, ADMIN_PIN);
    expect(state.audit.filter((a) => a === 'warehouse.mobile_print_submit')).toHaveLength(1);
    expect(stock.calls).toHaveLength(0);
  });

  test('a fila enfileirada aparece no bootstrap seguinte', async () => {
    await call('POST', M + '/print/submit', { kind: 'box_label', boxes: [5] }, ADMIN_PIN);
    const r = await call('GET', M + '/bootstrap', undefined, ADMIN_PIN);
    expect(r.body.data.queue.queued).toBe(1);
  });
});

describe('Mobile — impressoras', () => {
  test('recorte de bolso: nome, estado, erro de verdade e jobs de hoje', async () => {
    const r = await call('GET', M + '/printers', undefined, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.printers).toEqual([
      { name: 'EPSON C6000', status_label: 'Ready', error_label: null, jobs_today: 12,
        updated_at: '2026-08-19T12:00:00Z' },
      { name: 'Zebra 4x6', status_label: 'Offline', error_label: 'paper out', jobs_today: 0,
        updated_at: '2026-08-19T11:00:00Z' },
    ]);
  });

  test("'none' não é erro (o celular não pode mostrar alarme falso)", async () => {
    const r = await call('GET', M + '/printers', undefined, ADMIN_PIN);
    expect(r.body.data.printers[0].error_label).toBeNull();
  });
});
