'use strict';
/**
 * Warehouse hub — SKU PARENTING no HTTP (Bruno 08-19, S15).
 *
 *  1. overview: uma linha por produto físico, com children[] e veeqo_total
 *     (base físico, NUNCA base + kits — seria a mesma garrafa duas vezes)
 *  2. overview: busca, filtro, ordenação (nulo por último, estável) e página
 *  3. /sku-suggestions: grupos com motivo em PT-BR, nunca junta sozinho
 *  4. /family/merge: resultado rico; /merge-bulk; /unmerge
 *
 * Express de verdade num socket efêmero, services mockados — sem banco, sem rede.
 * PINs FICTÍCIOS (os reais só existem em env/produção).
 */
const express = require('express');
const { createWarehouseRouter, applyQuery, MERGE_BULK_CAP } = require('../v3/warehouse/router');

const ADMIN_PIN = '111111';    // fictício: manage_stock
const VIEWER_PIN = '222222';   // fictício: só view_stock

function makeDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM v3\.app_logins l/.test(q)) {
        const map = {
          [ADMIN_PIN]: { id: 1, name: 'Henrique', role: 'manager', rank: 50, functions: ['view_stock', 'manage_stock'] },
          [VIEWER_PIN]: { id: 2, name: 'Visitante', role: 'viewer', rank: 20, functions: ['view_stock'] },
        };
        const l = map[params[0]];
        return { rows: l ? [l] : [] };
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) {
        state.audit.push({ action: params[1], target_id: params[2], after: params[3] });
        return { rows: [] };
      }
      if (/COUNT\(\*\)::int AS count/.test(q)) return { rows: [{ count: 0, oldest_age_min: null }] };
      return { rows: [] };
    },
  };
}

/** Row do contrato, com os campos novos da família. */
function row(over = {}) {
  const skus = over.skus || [{ id: 1, sku: 'BEET-2000', channel: 'veeqo', units_per_pack: 1, role: 'base' }];
  return Object.assign({
    product_id: 10, name: 'Beet Root 2000mg', nickname: 'Beet Root 2000mg', bottle_color: null,
    base_sku: 'BEET-2000', base_units_per_pack: 1,
    skus, children: skus.filter((s) => s.role !== 'base'), sku_count: skus.length,
    veeqo_total: null, merged_into_product_id: null, retired: false,
    shelf_qty: 40, box_qty: 100, unplaced_qty: 0, total: 140,
    reserved: 0, pending_out: 0, pending_in: 0, available: 140, separated: 0,
    min_units: null, sold_7d: 0, sold_30d: 0, days_of_stock: null, days_cover: null,
    veeqo: null, veeqo_match: 'unknown', status: ['ok'], bins: [], boxes: [],
  }, over);
}

function makeStock(rows) {
  return {
    // o service REAL já exclui absorvidos; o mock imita isso
    overview: jest.fn(async (o) => rows
      .filter((r) => (o && o.product_id ? r.product_id === o.product_id : !r.retired))
      .map((r) => JSON.parse(JSON.stringify(r)))),
    productDetail: jest.fn(async (id) => ({
      product: JSON.parse(JSON.stringify(rows.find((r) => r.product_id === id))),
      open_orders: [], movements: [], issues: [], requests: [],
    })),
    moveProduct: jest.fn(async () => ({ moved_qty: 0, bins: 0, boxes: 0, unplaced: 0, duplicate: true })),
  };
}

/** FamilyRepo falso: o repo real tem teste próprio (family-parenting.test.js). */
function makeFamily(state) {
  return {
    forProduct: jest.fn(async () => ({ base: null, members: [], children: [], sku_count: 0, absorbed: [] })),
    attach: jest.fn(async (p) => ({ id: 55, ...p })),
    detach: jest.fn(async () => ({ id: 55, sku: 'X', product_id: 10 })),
    merge: jest.fn(async ({ from_product_id, into_product_id }) => {
      if (from_product_id === into_product_id) throw new Error('merge: produtos iguais');
      if (from_product_id === 999) throw new Error('produto não existe: 999');
      state.merges.push({ from_product_id, into_product_id });
      return {
        parent: { product_id: into_product_id, name: 'Beet Root 2000mg', nickname: 'Beet Root 2000mg' },
        moved_skus: [{ id: 2, sku: 'BEET-2000-C3', channel: 'veeqo', units_per_pack: 3 }],
        moved_qty: 47, retired_product_id: from_product_id, already_retired: false,
        stock: { bins: 1, boxes: 1, unplaced: 0, duplicate: false },
        moved: 1, skus: [],
      };
    }),
    unmerge: jest.fn(async ({ product_id }) => ({
      product: { product_id, name: 'Beet Root C3', nickname: 'Beet Root C3' },
      was_merged_into: 10,
      returned_skus: [{ id: 2, sku: 'BEET-2000-C3', channel: 'veeqo', units_per_pack: 3 }],
      moved_qty_back: 0,
    })),
  };
}

const fakeVeeqo = (list) => ({ listSellables: async () => list });

let server, base, state, family;

async function boot(rows, veeqoList) {
  if (server) await new Promise((r) => server.close(r));
  state = { audit: [], merges: [] };
  family = makeFamily(state);
  const { createVeeqoCache } = require('../v3/warehouse/veeqo-cache');
  const veeqoCache = createVeeqoCache({ veeqo: fakeVeeqo(veeqoList || []) });
  await veeqoCache.warm();
  const app = express();
  app.use('/', createWarehouseRouter({
    db: makeDb(state), stock: makeStock(rows), requests: { list: async () => [] },
    veeqoCache, family,
  }));
  server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
}

async function call(method, path, body, pin = ADMIN_PIN) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(pin ? { 'x-admin-pin': pin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
}

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('overview: uma linha por produto físico', () => {
  test('produto absorvido NÃO aparece na lista', async () => {
    await boot([
      row({ product_id: 10 }),
      row({ product_id: 11, name: 'Beet Root C3', nickname: 'Beet Root C3',
        retired: true, merged_into_product_id: 10 }),
    ]);
    const r = await call('GET', '/api/v3/warehouse/overview');
    expect(r.status).toBe(200);
    expect(r.body.data.products.map((p) => p.product_id)).toEqual([10]);
    expect(r.body.data.total).toBe(1);
  });

  test('a linha traz children[] e sku_count com o veeqo_qty de cada filho', async () => {
    await boot([row({
      skus: [
        { id: 1, sku: 'BEET-2000', channel: 'veeqo', units_per_pack: 1, role: 'base' },
        { id: 2, sku: 'BEET-2000-C3', channel: 'veeqo', units_per_pack: 3, role: 'member' },
        { id: 3, sku: 'BEET-2000-C4', channel: 'veeqo', units_per_pack: 4, role: 'member' },
      ],
    })], [
      { sku: 'BEET-2000', type: 'variant', wh: { physical: 140, allocated: 0, available: 140 } },
      { sku: 'BEET-2000-C3', type: 'kit', wh: { physical: 46, allocated: 0, available: 46 } },
      { sku: 'BEET-2000-C4', type: 'kit', wh: { physical: 35, allocated: 0, available: 35 } },
    ]);
    const p = (await call('GET', '/api/v3/warehouse/overview')).body.data.products[0];
    expect(p.sku_count).toBe(3);
    expect(p.children.map((c) => c.sku)).toEqual(['BEET-2000-C3', 'BEET-2000-C4']);
    expect(p.children.map((c) => c.veeqo_qty)).toEqual([46, 35]);
    expect(p.children.map((c) => c.veeqo_type)).toEqual(['kit', 'kit']);
  });

  test('veeqo_total é SÓ o base: nunca soma os kits (a mesma garrafa duas vezes)', async () => {
    await boot([row({
      skus: [
        { id: 1, sku: 'BEET-2000', channel: 'veeqo', units_per_pack: 1, role: 'base' },
        { id: 2, sku: 'BEET-2000-C3', channel: 'veeqo', units_per_pack: 3, role: 'member' },
      ],
    })], [
      { sku: 'BEET-2000', type: 'variant', wh: { physical: 140, allocated: 0, available: 140 } },
      { sku: 'BEET-2000-C3', type: 'kit', wh: { physical: 46, allocated: 0, available: 46 } },
    ]);
    const p = (await call('GET', '/api/v3/warehouse/overview')).body.data.products[0];
    expect(p.veeqo_total).toBe(140);        // NÃO 186
    expect(p.veeqo_match).toBe('ok');       // bate com o total nosso (140)
  });
});

describe('overview: busca, filtro, ordem e página (servidor)', () => {
  const many = () => [
    row({ product_id: 1, name: 'Alpha', nickname: 'Alpha', total: 10, available: 10, days_of_stock: 5, separated: 1 }),
    row({ product_id: 2, name: 'Bravo', nickname: 'Bravo', total: 0, available: 0, days_of_stock: null, status: ['out'] }),
    row({ product_id: 3, name: 'Charlie', nickname: 'Charlie', total: 30, available: 30, days_of_stock: 2 }),
  ];

  test('sem parâmetro nenhum: comportamento de antes (lista inteira, ordem do service)', async () => {
    await boot(many());
    const d = (await call('GET', '/api/v3/warehouse/overview')).body.data;
    expect(d.products.map((p) => p.product_id)).toEqual([1, 2, 3]);
    expect(d.total).toBe(3);
    expect(d.limit).toBeNull();
  });

  test('sort=total&dir=desc ordena de verdade', async () => {
    await boot(many());
    const d = (await call('GET', '/api/v3/warehouse/overview?sort=total&dir=desc')).body.data;
    expect(d.products.map((p) => p.total)).toEqual([30, 10, 0]);
  });

  test('nulo por último NAS DUAS direções (coluna Dias)', async () => {
    await boot(many());
    const asc = (await call('GET', '/api/v3/warehouse/overview?sort=dias&dir=asc')).body.data;
    expect(asc.products.map((p) => p.days_of_stock)).toEqual([2, 5, null]);
    const desc = (await call('GET', '/api/v3/warehouse/overview?sort=dias&dir=desc')).body.data;
    expect(desc.products.map((p) => p.days_of_stock)).toEqual([5, 2, null]);
  });

  test('q busca no nome E nos SKUs filhos', async () => {
    await boot([
      row({ product_id: 1, name: 'Alpha', nickname: 'Alpha',
        skus: [{ id: 1, sku: 'BEET-2000-C3', channel: 'veeqo', units_per_pack: 3, role: 'member' }] }),
      row({ product_id: 2, name: 'Bravo', nickname: 'Bravo',
        skus: [{ id: 2, sku: 'OTHER', channel: 'veeqo', units_per_pack: 1, role: 'base' }] }),
    ]);
    const byName = (await call('GET', '/api/v3/warehouse/overview?q=bravo')).body.data;
    expect(byName.products.map((p) => p.product_id)).toEqual([2]);
    // quem cola o SKU do casepack tem que cair na linha do PAI
    const bySku = (await call('GET', '/api/v3/warehouse/overview?q=beet-2000-c3')).body.data;
    expect(bySku.products.map((p) => p.product_id)).toEqual([1]);
  });

  test('status= e only_with_qty=1 filtram', async () => {
    await boot(many());
    const out = (await call('GET', '/api/v3/warehouse/overview?status=out')).body.data;
    expect(out.products.map((p) => p.product_id)).toEqual([2]);
    const comQty = (await call('GET', '/api/v3/warehouse/overview?only_with_qty=1')).body.data;
    expect(comQty.products.map((p) => p.product_id)).toEqual([1, 3]);
    expect(comQty.total).toBe(2);
  });

  test('limit/offset paginam e total conta ANTES da página', async () => {
    await boot(many());
    const d = (await call('GET', '/api/v3/warehouse/overview?limit=2&offset=1')).body.data;
    expect(d.products.map((p) => p.product_id)).toEqual([2, 3]);
    expect(d.total).toBe(3);
    expect(d.limit).toBe(2); expect(d.offset).toBe(1);
  });

  test('KPIs e "precisa de atenção" são do armazém INTEIRO, não da página', async () => {
    await boot(many());
    const d = (await call('GET', '/api/v3/warehouse/overview?limit=1')).body.data;
    expect(d.products.length).toBe(1);
    expect(d.kpis.total_bottles).toBe(40);                  // 10 + 0 + 30
    // o produto zerado continua na lista de atenção mesmo fora da página
    expect(d.attention.some((a) => a.product_id === 2)).toBe(true);
  });

  test('applyQuery é estável: mesma entrada, mesma saída', () => {
    const rows = many();
    const a = applyQuery(rows, { sort: 'dias', dir: 'asc' }).rows.map((r) => r.product_id);
    const b = applyQuery(rows, { sort: 'dias', dir: 'asc' }).rows.map((r) => r.product_id);
    expect(a).toEqual(b);
  });
});

describe('sugestões de parentesco', () => {
  test('grupos com motivo em PT-BR e confiança; leitura basta', async () => {
    await boot([
      row({ product_id: 1, name: 'Beet Root 2000mg', nickname: 'Beet Root 2000mg', total: 140,
        base_sku: 'BEET-2000',
        skus: [{ id: 1, sku: 'BEET-2000', channel: 'veeqo', units_per_pack: 1, role: 'base' }] }),
      row({ product_id: 2, name: 'Beet Root 2000mg - C4', nickname: 'Beet Root 2000mg - C4',
        total: 0, base_sku: 'BEET-2000-C4',
        skus: [{ id: 2, sku: 'BEET-2000-C4', channel: 'veeqo', units_per_pack: 4, role: 'base' }] }),
    ]);
    const r = await call('GET', '/api/v3/warehouse/sku-suggestions', undefined, VIEWER_PIN);
    expect(r.status).toBe(200);
    const g = r.body.data.groups;
    expect(g.length).toBe(1);
    expect(g[0].suggested_parent.product_id).toBe(1);
    expect(g[0].members.map((m) => m.product_id).sort()).toEqual([1, 2]);
    expect(g[0].members[0]).toHaveProperty('has_stock');
    expect(g[0].confidence).toBe('alta');
    expect(typeof g[0].reason).toBe('string');
    expect(r.body.data.counts.groups).toBe(1);
    // NUNCA junta sozinho: nenhum merge foi chamado
    expect(state.merges.length).toBe(0);
  });
});

describe('merge, merge-bulk e unmerge', () => {
  test('merge devolve resultado rico e a Row do pai', async () => {
    await boot([row({ product_id: 10 }), row({ product_id: 11 })]);
    const r = await call('POST', '/api/v3/warehouse/family/merge',
      { from_product_id: 11, into_product_id: 10 });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.parent.product_id).toBe(10);
    expect(d.moved_skus.length).toBe(1);
    expect(d.moved_qty).toBe(47);
    expect(d.retired_product_id).toBe(11);
    expect(d.product.product_id).toBe(10);
    // o audit guarda os sku_ids: é deles que o unmerge sabe o que devolver
    const a = state.audit.find((x) => x.action === 'warehouse.family_merge');
    expect(JSON.parse(a.after).sku_ids).toEqual([2]);
  });

  test('merge-bulk aplica vários grupos; um grupo que falha não derruba os outros', async () => {
    await boot([row({ product_id: 10 }), row({ product_id: 20 })]);
    const r = await call('POST', '/api/v3/warehouse/family/merge-bulk', {
      groups: [
        { into_product_id: 10, from_product_ids: [11, 12] },
        { into_product_id: 20, from_product_ids: [999] },     // esse falha
      ],
    });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.results.length).toBe(2);
    expect(d.results[0].ok).toBe(true);
    expect(d.results[0].merged.length).toBe(2);
    expect(d.results[1].ok).toBe(false);
    expect(d.results[1].failed[0].error).toMatch(/não existe/);
    expect(d.merged_products).toBe(2);
    expect(d.moved_qty).toBe(94);
  });

  test('merge-bulk acima do teto → 400', async () => {
    await boot([row()]);
    const groups = Array.from({ length: MERGE_BULK_CAP + 1 },
      (_, i) => ({ into_product_id: 10, from_product_ids: [100 + i] }));
    const r = await call('POST', '/api/v3/warehouse/family/merge-bulk', { groups });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(new RegExp(String(MERGE_BULK_CAP)));
  });

  test('unmerge devolve o produto e os SKUs daquele merge', async () => {
    await boot([row({ product_id: 11 })]);
    const r = await call('POST', '/api/v3/warehouse/family/unmerge', { product_id: 11 });
    expect(r.status).toBe(200);
    expect(r.body.data.was_merged_into).toBe(10);
    expect(r.body.data.returned_skus.length).toBe(1);
    expect(r.body.data.moved_qty_back).toBe(0);
  });

  test('escrita exige manage_stock: viewer leva 403 no merge e no bulk', async () => {
    await boot([row()]);
    const m = await call('POST', '/api/v3/warehouse/family/merge',
      { from_product_id: 11, into_product_id: 10 }, VIEWER_PIN);
    expect(m.status).toBe(403);
    const b = await call('POST', '/api/v3/warehouse/family/merge-bulk',
      { groups: [{ into_product_id: 10, from_product_ids: [11] }] }, VIEWER_PIN);
    expect(b.status).toBe(403);
    const u = await call('POST', '/api/v3/warehouse/family/unmerge', { product_id: 11 }, VIEWER_PIN);
    expect(u.status).toBe(403);
  });
});
