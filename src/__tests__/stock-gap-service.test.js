'use strict';
const { StockGapService, nameMatches } = require('../v3/services/stock-gap-service');

describe('nameMatches (nosso produto <-> nome do EMS)', () => {
  test('casa produto com formula mais descritiva do EMS', () => {
    expect(nameMatches('Berberine 6000mg', 'Berberine HCl 6000mg with Ceylon Cinnamon')).toBe(true);
    expect(nameMatches('Magnesium Citrate 500mg', 'Magnesium Citrate 500mg')).toBe(true);
    expect(nameMatches('Plant Sterols 2000mg', 'Plant Sterols 2000mg')).toBe(true);
  });
  test('ignora HealthFare e mg/caps', () => {
    expect(nameMatches('HealthFare Folic Acid 1000mcg', 'Folic Acid 1000mcg')).toBe(true);
  });
  test('NAO casa produtos diferentes', () => {
    expect(nameMatches('Magnesium Citrate 500mg', 'Magnesium Oxide 500mg')).toBe(false);
    expect(nameMatches('Vitamin B1', 'Vitamin B2')).toBe(false);
    expect(nameMatches('Ginger Root 4000mg', 'Ginkgo Biloba')).toBe(false);
  });
  // REGRA DO BRUNO (08-07): casepack é OUTRO produto. base != C2 != C3 != C4.
  test('CASEPACK nunca casa com o base nem com outro casepack', () => {
    expect(nameMatches('Benfotiamine 300mg - C2', 'Benfotiamine 300mg')).toBe(false);
    expect(nameMatches('Benfotiamine 300mg - C2', 'Benfotiamine 300mg - C4')).toBe(false);
    expect(nameMatches('Chromium Picolinate 1000mcg - C2', 'Chromium Picolinate 1000mcg')).toBe(false);
    expect(nameMatches('Vitamin B2 400mg - C2', 'Vitamin B2 400mg')).toBe(false);
    // mesmo casepack ainda casa
    expect(nameMatches('Benfotiamine 300mg - C2', 'Benfotiamine 300mg C2')).toBe(true);
  });
});

function svcWith(emsRows) {
  const svc = new StockGapService({ db: { query: async () => ({ rows: [] }) }, ems: null });
  svc.emsByProduct = async () => emsRows;
  return svc;
}
const pl = (product, sku, need, stock) => ({ groups: [{
  product, sku, nickname: sku, veeqo_stock: stock,
  orders: [{ bottles: need }],
}] });

describe('StockGapService.analyze', () => {
  test('zerado + capsulas prontas -> sugere fazer na mao hoje', async () => {
    const svc = svcWith([{ kind: 'capsules', product: 'Plant Sterols 2000mg', batch: 'BR-2026-0304', qty: 800 }]);
    const r = await svc.analyze(pl('Plant Sterols 2000mg', 'HF-PLAN-2000', 3, 0));
    expect(r.out_count).toBe(1);
    expect(r.items[0].action).toBe('capsules_ready');
    expect(r.items[0].advice).toMatch(/c[áa]psulas prontas/i);
    expect(r.items[0].advice).toContain('BR-2026-0304');
  });

  test('zerado + na linha -> avisa que esta passando', async () => {
    const svc = svcWith([{ kind: 'line', product: 'Benfotiamine 300mg', batch: 'BR-2026-0321' }]);
    const r = await svc.analyze(pl('Benfotiamine 300mg', 'HF-BENF-300', 2, 0));
    expect(r.items[0].action).toBe('on_line');
  });

  // SKU manda: batch do BASE nao pode virar recomendacao pro CASEPACK
  test('batch do base NAO recomenda pro casepack (-C2)', async () => {
    const svc = svcWith([{ kind: 'capsules', product: 'Benfotiamine 300mg', batch: 'BR-2026-0320', qty: 750 }]);
    const r = await svc.analyze(pl('Benfotiamine 300mg - C2', 'HF-BENF-300-C2', 2, 0));
    expect(r.items[0].action).toBe('no_production');
    expect(r.items[0].advice).toMatch(/ZERADO/);
  });

  test('casa por SKU quando o EMS tem SKU (fonte da verdade)', async () => {
    const svc = svcWith([
      { kind: 'capsules', product: 'Nome Bem Diferente', sku: 'HF-PLAN-2000', batch: 'BR-2026-0304', qty: 800 },
    ]);
    const r = await svc.analyze(pl('Plant Sterols 2000mg', 'HF-PLAN-2000', 3, 0));
    expect(r.items[0].action).toBe('capsules_ready');   // casou pelo SKU, nao pelo nome
  });

  test('zerado + ja passou -> pergunta se temos aqui', async () => {
    const svc = svcWith([{ kind: 'finalized', product: 'Ginger Root 4000mg', batch: 'BR-2026-0290', at: '2026-08-01' }]);
    const r = await svc.analyze(pl('Ginger Root 4000mg', 'HF-GING-4000', 1, 0));
    expect(r.items[0].action).toBe('recently_made');
    expect(r.items[0].advice).toMatch(/j[áa] passou na linha/i);
  });

  test('ZERADO e sem producao -> vermelho (critico)', async () => {
    const svc = svcWith([]);
    const r = await svc.analyze(pl('Saw Palmetto 4000mg', 'HF-SAWP-4000', 2, 0));
    expect(r.items[0].severity).toBe('critical');
    expect(r.items[0].advice).toMatch(/ZERADO/);
  });

  test('BAIXO (nao zerado) sem producao NAO e critico e nao diz "sem estoque"', async () => {
    const svc = svcWith([]);
    const r = await svc.analyze(pl('Saw Palmetto 4000mg', 'HF-SAWP-4000', 2, 14));
    expect(r.items[0].severity).toBe('warn');
    expect(r.items[0].status).toBe('low');
    expect(r.items[0].advice).not.toMatch(/ZERADO/);
    expect(r.items[0].advice).toContain('14');
  });

  test('estoque suficiente -> nao entra na lista', async () => {
    const svc = svcWith([]);
    const r = await svc.analyze(pl('Berberine HCL 5000mg', 'HF-HCL-5000', 1, 508));
    expect(r.items).toHaveLength(0);
  });

  test('estoque menor que o necessario -> entra mesmo acima do limiar', async () => {
    const svc = svcWith([]);
    const r = await svc.analyze(pl('Apple Cider Vinegar', 'HF-APPL-3200', 60, 40));
    expect(r.items).toHaveLength(1);
    expect(r.items[0].status).toBe('low');
  });

  test('sem dado de estoque (null) -> ignora, nao inventa', async () => {
    const svc = svcWith([]);
    const r = await svc.analyze(pl('X', 'HF-X', 5, null));
    expect(r.items).toHaveLength(0);
  });
});
