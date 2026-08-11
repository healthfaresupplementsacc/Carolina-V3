'use strict';
/* Veeqo client (read-only, Fase ① Bruno 07-08): agrega pedidos ENVIADOS do dia NY
   por canal + suplemento, pagina, e a chave nunca vaza no erro. */
const { createVeeqoClient } = require('../v3/services/veeqo-api');

const order = (over) => Object.assign({
  status: 'shipped', shipped_at: '2026-07-08T15:00:00Z', channel: { name: 'Amazon' },
  line_items: [{ quantity: 2, sellable: { product_title: 'Urolithin A', sku_code: 'HF-URO' } }],
}, over);

function mockFetch(pagesByPage) {
  return async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    const rows = pagesByPage[page] || [];
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => rows };
  };
}

describe('Veeqo — shippedByDay', () => {
  test('agrega por canal + suplemento, soma unidades, e só conta o dia NY', async () => {
    const v = createVeeqoClient({ apiKey: 'k', fetchImpl: mockFetch({
      1: [
        order({ channel: { name: 'Amazon' }, line_items: [{ quantity: 2, sellable: { product_title: 'Urolithin A', sku_code: 'HF-URO' } }] }),
        order({ channel: { name: 'Ebay' }, line_items: [{ quantity: 1, sellable: { product_title: 'Urolithin A', sku_code: 'HF-URO' } }, { quantity: 3, sellable: { product_title: 'Melatonin', sku_code: 'HF-MEL' } }] }),
        order({ shipped_at: '2026-07-07T15:00:00Z' }), // OUTRO dia NY → não conta
      ],
    }) });
    const out = await v.shippedByDay('2026-07-08');
    expect(out.total_orders).toBe(2);              // o de 07-07 fora
    expect(out.total_units).toBe(6);               // 2 + 1 + 3
    const uro = out.by_product.find((p) => p.sku === 'HF-URO');
    expect(uro.units).toBe(3);                     // 2 (amazon) + 1 (ebay)
    expect(out.by_product[0].units).toBe(3);       // ordenado desc (empate 3 e 3)
    expect(out.by_channel.map((c) => c.channel).sort()).toEqual(['Amazon', 'Ebay']);
  });

  test('pagina até esvaziar (2 páginas)', async () => {
    const full = Array.from({ length: 100 }, () => order({ line_items: [{ quantity: 1, sellable: { product_title: 'X', sku_code: 'X' } }] }));
    const v = createVeeqoClient({ apiKey: 'k', fetchImpl: mockFetch({ 1: full, 2: [order({ line_items: [{ quantity: 5, sellable: { product_title: 'X', sku_code: 'X' } }] })] }) });
    const out = await v.shippedByDay('2026-07-08');
    expect(out.total_orders).toBe(101);
    expect(out.total_units).toBe(105);
    expect(out.pages).toBe(2);
  });

  test('401 → erro claro, SEM a chave no texto', async () => {
    const v = createVeeqoClient({ apiKey: 'super-secret-key', fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) }) });
    await expect(v.shippedByDay('2026-07-08')).rejects.toMatchObject({ code: 'unauthorized' });
    try { await v.shippedByDay('2026-07-08'); } catch (e) { expect(e.message).not.toContain('super-secret-key'); }
  });

  test('sem chave → não configurado', () => {
    expect(createVeeqoClient({ apiKey: null }).configured()).toBe(false);
  });
});
