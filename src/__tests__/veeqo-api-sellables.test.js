'use strict';
/**
 * veeqo-api.listSellables — campos novos do Warehouse hub (Bruno 08-18, V1):
 *  • type: 'kit' (casepack -C2/-C3/-C4) | 'variant' (a garrafa base) | null
 *  • wh:   {physical, allocated, available} SÓ do HealthFare Warehouse (108841)
 * O outro armazém NUNCA entra na comparação. `stock` (soma de todos) segue igual.
 * Fake de getProductsPage — nenhuma rede é tocada.
 */
const { createVeeqoClient } = require('../v3/services/veeqo-api');

const WH = 108841;
const OTHER = 999999;

function page1() {
  return [{
    id: 1, title: 'L-Carnitine 1500',
    sellables: [
      { id: 11, sku_code: 'HF-LCAR-1500', type: 'ProductVariant', product_title: 'L-Carnitine 1500',
        stock_entries: [
          { warehouse_id: WH, physical_stock_level: 180, allocated_stock_level: 6, available_stock_level: 174 },
          { warehouse_id: OTHER, physical_stock_level: 20, allocated_stock_level: 0, available_stock_level: 20 },
        ] },
      { id: 12, sku_code: 'HF-LCAR-1500-C2', type: 'Kit', product_title: 'L-Carnitine 1500 x2',
        stock_entries: [
          { warehouse_id: WH, physical_stock_level: 90, allocated_stock_level: 0, available_stock_level: 90 },
        ] },
      { id: 13, sku_code: 'HF-SEM-ENTRADA', type: 'ProductVariant', product_title: 'Sem estoque cadastrado' },
      { id: 14, sku_code: 'HF-OUTRO-ARMAZEM', type: 'ProductVariant', product_title: 'Só no outro armazém',
        stock_entries: [{ warehouse_id: OTHER, physical_stock_level: 33 }] },
      { id: 15, sku_code: 'HF-TIPO-ESTRANHO', type: 'Bundle', product_title: 'Tipo desconhecido',
        stock_entries: [{ warehouse_id: WH, physical_stock_level: 5, allocated_stock_level: 1, available_stock_level: 4 }] },
    ],
  }];
}

describe('listSellables — type + estoque do nosso armazém', () => {
  let rows;
  beforeAll(async () => {
    // injeta o fake por dentro do módulo: createVeeqoClient aceita fetchImpl, então
    // simulamos as respostas HTTP de /products (é o único endpoint usado aqui).
    const fetchImpl = async (url) => {
      const p = Number(new URL(url).searchParams.get('page'));
      return { ok: true, status: 200, json: async () => (p === 1 ? page1() : []) };
    };
    const c = createVeeqoClient({ apiKey: 'fake-key-para-teste', warehouseId: WH, fetchImpl });
    rows = await c.listSellables();
  });

  test('base = variant com o físico/alocado/disponível do armazém 108841', () => {
    const base = rows.find((r) => r.sku === 'HF-LCAR-1500');
    expect(base.type).toBe('variant');
    expect(base.wh).toEqual({ physical: 180, allocated: 6, available: 174 });
    expect(base.stock).toBe(200);            // soma dos dois armazéns (campo antigo, intacto)
  });

  test('casepack = kit', () => {
    const kit = rows.find((r) => r.sku === 'HF-LCAR-1500-C2');
    expect(kit.type).toBe('kit');
    expect(kit.wh.physical).toBe(90);
  });

  test('sem stock_entries → wh null', () => {
    const s = rows.find((r) => r.sku === 'HF-SEM-ENTRADA');
    expect(s.wh).toBeNull();
    expect(s.stock).toBeNull();
  });

  test('só no outro armazém → wh null (nunca comparamos com o armazém alheio)', () => {
    const s = rows.find((r) => r.sku === 'HF-OUTRO-ARMAZEM');
    expect(s.wh).toBeNull();
  });

  test('tipo desconhecido → type null, wh mesmo assim', () => {
    const s = rows.find((r) => r.sku === 'HF-TIPO-ESTRANHO');
    expect(s.type).toBeNull();
    expect(s.wh.available).toBe(4);
  });

  test('campos antigos continuam: sku, title, product_title', () => {
    const base = rows.find((r) => r.sku === 'HF-LCAR-1500');
    expect(base.title).toBe('L-Carnitine 1500');
    expect(base.product_title).toBe('L-Carnitine 1500');
  });
});

describe('listSellables — paginação', () => {
  test('página incompleta encerra a varredura e nenhum SKU se repete', async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls++;
      const p = Number(new URL(url).searchParams.get('page'));
      return { ok: true, status: 200, json: async () => (p === 1 ? page1() : []) };
    };
    const c = createVeeqoClient({ apiKey: 'k', warehouseId: WH, fetchImpl });
    const rows = await c.listSellables();
    expect(calls).toBe(1);                 // 1 produto na página 1 (< 100) → para ali
    expect(new Set(rows.map((r) => r.sku)).size).toBe(rows.length);
  });
});
