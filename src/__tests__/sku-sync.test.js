'use strict';
/**
 * VEEQO SKU SYNC (S15.39, Bruno 08-19) — "pq q ele nao ta mapeado se ta tudo la
 * no Veeqo? Veeqo tem tudo SKU, Titulo, Quantidade".
 *
 * Fixtures são os casos REAIS medidos na varredura de 08-19, não invenção:
 *   HF-NAC-1300 / -C4 · HF-BERB-5000 (base é casepack de verdade) · HF-PANT-500
 *   · units gravado errado · raiz em dois produtos · SKUs de serviço 9999.
 *
 * O que se garante aqui:
 *   1. plan() é PURO: sem banco, sem rede, determinístico
 *   2. casepack liga no pai da raiz; -C2-C4 = 8
 *   3. units_per_pack vem do CÓDIGO, nunca da linha
 *   4. serviço/plano/insumo fica fora
 *   5. raiz em dois produtos vira CONFLITO, nunca merge automático
 *   6. base_is_casepack é SINALIZADO, nunca "consertado"
 *   7. produto novo só nasce com create_missing
 *   8. rodar duas vezes não muda nada na segunda
 *   9. worker: dedupe, desligado por default, nunca toca quantidade
 */
const { plan, createSkuSync, unitsOf, rootOf, isService, cleanName } =
  require('../v3/warehouse/sku-sync');
const { VeeqoSkuSync } = require('../workers/veeqo-sku-sync');

// ── fixtures reais ──────────────────────────────────────────────────────────

/** Um sellable da Veeqo, no formato que listSellables() devolve. */
const sell = (sku, title, over = {}) => Object.assign(
  { sku, title, product_title: title, type: /-C\d+$/.test(sku) ? 'kit' : 'variant',
    wh: { physical: 100, allocated: 0, available: 100 }, upc_code: null }, over);

/** Catálogo pequeno mas com todos os casos que doeram de verdade. */
const CATALOG = [
  sell('HF-NAC-1300', 'Healthfare NAC 1300mg | 120 Capsules'),
  sell('HF-NAC-1300-C4', 'Healthfare NAC 1300mg | 120 Capsules | 4 Bottles'),
  sell('HF-NAC-1300-C2-C4', 'Healthfare NAC 1300mg | 8 Bottles'),
  sell('HF-BERB-5000', 'Healthfare Berberine 5000mg | 60 Capsules | 2 Bottles'),
  sell('HF-PANT-500', 'Healthfare Pantothenic Acid 500mg | 2 Bottles'),
  sell('HF-PLN-MONTHLY', 'HealthFare Monthly Plan', { wh: { physical: 9999, allocated: 0, available: 9999 } }),
  sell('HC-CONSULT', 'Clinic Consultation', { wh: { physical: 9999, allocated: 0, available: 9999 } }),
  sell('HF-MED-SEMA', 'Semaglutide', { wh: { physical: 9999, allocated: 0, available: 9999 } }),
  sell('HF-SYR-1ML', 'Syringe 1ml'),
  sell('SHOPIFY-GIFT', 'Gift card'),
  sell('SILIN-01', 'Silicone insert'),
  sell('RUBBER-04', 'Rubber band'),
  sell('70', 'HairLux clinic service', { wh: { physical: 9999, allocated: 0, available: 9999 } }),
];

/** Mapeamento de hoje: só a avulsa do NAC existe (o -C4 é o órfão do Bruno). */
function currentBase() {
  return {
    skus: [
      { id: 1, product_id: 10, sku: 'HF-NAC-1300', channel: 'veeqo', units_per_pack: 1, is_base: true },
    ],
    products: [
      { id: 10, canonical_name: 'Nac 1300mg', nickname: 'NAC 1300', merged_into_product_id: null },
    ],
  };
}

const bySkuOf = (list) => Object.fromEntries(list.map((x) => [x.sku, x]));

// ── 1. o vocabulário do SKU ────────────────────────────────────────────────

describe('o código do SKU é a verdade (regras a e b)', () => {
  test('-C<n> é pacote de n; sem sufixo é 1', () => {
    expect(unitsOf('HF-NAC-1300')).toBe(1);
    expect(unitsOf('HF-NAC-1300-C4')).toBe(4);
    expect(unitsOf('HF-NAC-1300-C3')).toBe(3);
  });

  test('-C<a>-C<b> é pacote de pacote: units = a x b', () => {
    expect(unitsOf('HF-NAC-1300-C2-C4')).toBe(8);
    expect(unitsOf('HF-X-C3-C3')).toBe(9);
  });

  test('a raiz é o código sem nenhum sufixo de pacote', () => {
    expect(rootOf('HF-NAC-1300-C4')).toBe('HF-NAC-1300');
    expect(rootOf('HF-NAC-1300-C2-C4')).toBe('HF-NAC-1300');
    expect(rootOf('HF-NAC-1300')).toBe('HF-NAC-1300');
  });

  test('C colado no nome NÃO é sufixo de pacote', () => {
    expect(unitsOf('HFC4')).toBe(1);
    expect(rootOf('HFC4')).toBe('HFC4');
  });

  test('C0 e C1 não são pacote de verdade', () => {
    expect(unitsOf('HF-X-C1')).toBe(1);
    expect(unitsOf('HF-X-C0')).toBe(1);
  });
});

describe('serviço, plano e insumo não são garrafa (regra e)', () => {
  test.each(['HF-PLN-MONTHLY', 'HC-CONSULT', 'HF-MED-SEMA', 'HF-SYR-1ML',
    'SHOPIFY-GIFT', 'SILIN-01', 'RUBBER-04', '70'])('%s fica fora', (sku) => {
    expect(isService(sku)).toBe(true);
  });

  test('SKU de suplemento não é confundido com serviço', () => {
    expect(isService('HF-NAC-1300')).toBe(false);
    expect(isService('HF-BERB-5000-C4')).toBe(false);
  });
});

describe('nome limpo a partir do título da Veeqo', () => {
  test('tira Healthfare e tudo depois da primeira barra', () => {
    expect(cleanName('Healthfare NAC 1300mg | 120 Capsules | 4 Bottles', 'HF-NAC-1300'))
      .toBe('NAC 1300mg');
  });

  test('a DOSE fica (Berberine 1000 nunca vira Berberine)', () => {
    expect(cleanName('Healthfare Berberine 1000mg | 60 Capsules', 'X')).toBe('Berberine 1000mg');
  });

  test('título vazio cai pro SKU em vez de virar nome em branco', () => {
    expect(cleanName('', 'HF-XPTO-100')).toBe('HF-XPTO-100');
    expect(cleanName('Healthfare', 'HF-XPTO-100')).toBe('HF-XPTO-100');
  });
});

// ── 2. o plano ─────────────────────────────────────────────────────────────

describe('plan(): o caso que quebrou o pedido do eBay', () => {
  test('HF-NAC-1300-C4 liga no produto do HF-NAC-1300, pacote de 4', () => {
    const p = plan(CATALOG, currentBase());
    const l = p.link.find((x) => x.sku === 'HF-NAC-1300-C4');
    expect(l).toBeTruthy();
    expect(l.product_id).toBe(10);
    expect(l.units_per_pack).toBe(4);
    expect(l.parent_sku).toBe('HF-NAC-1300');
    expect(l.reason).toBe('casepack_of_root');
  });

  test('HF-NAC-1300-C2-C4 liga no mesmo pai com 8 unidades', () => {
    const p = plan(CATALOG, currentBase());
    const l = p.link.find((x) => x.sku === 'HF-NAC-1300-C2-C4');
    expect(l.product_id).toBe(10);
    expect(l.units_per_pack).toBe(8);
  });

  test('os SKUs de serviço vão pra ignored, nunca pra link nem create', () => {
    const p = plan(CATALOG, currentBase());
    const ignoredSkus = p.ignored.map((x) => x.sku);
    for (const s of ['HF-PLN-MONTHLY', 'HC-CONSULT', 'HF-MED-SEMA', 'HF-SYR-1ML',
      'SHOPIFY-GIFT', 'SILIN-01', 'RUBBER-04', '70']) {
      expect(ignoredSkus).toContain(s);
      expect(p.link.some((l) => l.sku === s)).toBe(false);
      expect(p.create.some((c) => c.sku === s)).toBe(false);
    }
    expect(p.ignored.every((x) => x.why === 'service_sku')).toBe(true);
  });

  test('é PURO: mesma entrada, saída idêntica, e nada mutado', () => {
    const cur = currentBase();
    const snapshot = JSON.stringify({ CATALOG, cur });
    const a = plan(CATALOG, cur);
    const b = plan(CATALOG, cur);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify({ CATALOG, cur })).toBe(snapshot);
  });

  test('sem banco nenhum: plan() é chamado com objetos e ponto', () => {
    expect(() => plan([], {})).not.toThrow();
    expect(plan([], {}).stats.sellables).toBe(0);
  });
});

describe('plan(): units_per_pack errado na linha (regra b, 9 casos reais)', () => {
  const cur = () => ({
    skus: [
      { id: 1, product_id: 10, sku: 'HF-NAC-1300', channel: 'veeqo', units_per_pack: 1, is_base: true },
      // o erro real: -C4 gravado como pacote de 1
      { id: 2, product_id: 10, sku: 'HF-NAC-1300-C4', channel: 'veeqo', units_per_pack: 1, is_base: false },
    ],
    products: [{ id: 10, canonical_name: 'Nac 1300mg', nickname: 'NAC 1300', merged_into_product_id: null }],
  });

  test('o plano corrige pro que o código diz e reporta o desencontro', () => {
    const p = plan(CATALOG, cur());
    const fix = p.link.find((x) => x.sku === 'HF-NAC-1300-C4');
    expect(fix.reason).toBe('units_fix');
    expect(fix.units_per_pack).toBe(4);
    expect(fix.product_id).toBe(10);

    const c = p.conflicts.find((x) => x.kind === 'units_mismatch' && x.sku === 'HF-NAC-1300-C4');
    expect(c.detail).toMatchObject({ stored: 1, from_code: 4 });
  });

  test('units já certo não gera trabalho nenhum', () => {
    const c = cur();
    c.skus[1].units_per_pack = 4;
    const p = plan(CATALOG, c);
    expect(p.link.some((x) => x.sku === 'HF-NAC-1300-C4')).toBe(false);
    expect(p.conflicts.some((x) => x.kind === 'units_mismatch')).toBe(false);
  });
});

describe('plan(): raiz em DOIS produtos = conflito, nunca merge (regra c)', () => {
  const cur = () => ({
    skus: [
      { id: 1, product_id: 10, sku: 'HF-NAC-1300', channel: 'veeqo', units_per_pack: 1, is_base: true },
      { id: 2, product_id: 11, sku: 'HF-NAC-1300-C4', channel: 'veeqo', units_per_pack: 4, is_base: true },
    ],
    products: [
      { id: 10, canonical_name: 'Nac 1300mg', nickname: 'NAC 1300', merged_into_product_id: null },
      { id: 11, canonical_name: 'NAC 1300 4 Bottles', nickname: 'NAC x4', merged_into_product_id: null },
    ],
  });

  test('reporta a raiz disputada com os dois donos', () => {
    const p = plan(CATALOG, cur());
    const c = p.conflicts.find((x) => x.kind === 'root_taken_by_two_products');
    expect(c.sku).toBe('HF-NAC-1300');
    expect(c.detail.product_ids).toEqual([10, 11]);
    expect(c.message).toMatch(/junte no hub/);
  });

  test('NÃO junta nada sozinho: nenhum link muda produto de dono', () => {
    const p = plan(CATALOG, cur());
    // nada no plano reaponta o SKU 2 (produto 11) pro produto 10
    expect(p.link.some((l) => l.sku === 'HF-NAC-1300-C4' && l.product_id === 10)).toBe(false);
  });

  test('enquanto a raiz está disputada, SKU novo dela fica de fora', () => {
    const p = plan(CATALOG, cur());
    const c2c4 = p.link.find((x) => x.sku === 'HF-NAC-1300-C2-C4');
    expect(c2c4).toBeUndefined();
    expect(p.ignored.some((x) => x.sku === 'HF-NAC-1300-C2-C4' && x.why === 'root_contested')).toBe(true);
  });
});

describe('plan(): base que já é casepack (regra d)', () => {
  /** HF-BERB-5000 real: a Veeqo NÃO tem avulsa, então é legítimo. */
  const cur = () => ({
    skus: [
      { id: 1, product_id: 20, sku: 'HF-BERB-5000-C2', channel: 'veeqo', units_per_pack: 2, is_base: true },
    ],
    products: [{ id: 20, canonical_name: 'Berberine 5000mg', nickname: 'BERB 5000', merged_into_product_id: null }],
  });

  test('sinaliza HF-BERB-5000-C2 como base de casepack', () => {
    const p = plan(CATALOG, cur());
    const c = p.conflicts.find((x) => x.kind === 'base_is_casepack');
    expect(c.detail).toMatchObject({ product_id: 20, base_sku: 'HF-BERB-5000-C2', base_units_per_pack: 2 });
  });

  test('NUNCA conserta: nenhum link mexe na base sinalizada', () => {
    const p = plan(CATALOG, cur());
    expect(p.link.some((l) => l.sku === 'HF-BERB-5000-C2')).toBe(false);
  });

  test('base avulsa normal NÃO é sinalizada', () => {
    const p = plan(CATALOG, currentBase());
    expect(p.conflicts.some((x) => x.kind === 'base_is_casepack')).toBe(false);
  });
});

describe('plan(): SKU base novo de verdade', () => {
  test('HF-BERB-5000 e HF-PANT-500 aparecem em create (ninguém tem a raiz)', () => {
    const p = plan(CATALOG, currentBase());
    const skus = p.create.map((c) => c.sku);
    expect(skus).toContain('HF-BERB-5000');
    expect(skus).toContain('HF-PANT-500');
    const berb = p.create.find((c) => c.sku === 'HF-BERB-5000');
    expect(berb.units).toBe(1);
    expect(berb.suggested_name).toBe('Berberine 5000mg');
  });

  test('dois filhos da mesma raiz nova pedem UM produto, não dois', () => {
    const cat = [sell('HF-XPTO-100-C4', 'Healthfare Xpto 100mg | 4 Bottles'),
      sell('HF-XPTO-100-C2', 'Healthfare Xpto 100mg | 2 Bottles')];
    const p = plan(cat, { skus: [], products: [] });
    expect(p.create.length).toBe(1);
    expect(p.create[0].sku).toBe('HF-XPTO-100');
    expect(p.create[0].children.map((c) => c.sku).sort())
      .toEqual(['HF-XPTO-100-C2', 'HF-XPTO-100-C4']);
    expect(p.create[0].root_not_in_catalog).toBe(true);
  });

  test('produto absorvido por merge nunca vira pai: o link sobe pra raiz', () => {
    const cur = {
      skus: [{ id: 1, product_id: 11, sku: 'HF-NAC-1300', channel: 'veeqo', units_per_pack: 1, is_base: true }],
      products: [
        { id: 10, canonical_name: 'Nac 1300mg', nickname: 'NAC', merged_into_product_id: null },
        { id: 11, canonical_name: 'NAC velho', nickname: 'NAC velho', merged_into_product_id: 10 },
      ],
    };
    const p = plan(CATALOG, cur);
    expect(p.link.find((l) => l.sku === 'HF-NAC-1300-C4').product_id).toBe(10);
  });
});

// ── 3. o applier ───────────────────────────────────────────────────────────

/** Banco falso com o que product_skus/products precisam pro applier. */
function makeDb(seed = {}) {
  const state = {
    skus: (seed.skus || []).map((s) => ({ ...s })),
    products: (seed.products || []).map((p) => ({ ...p })),
    writes: [], queries: [], nextSkuId: 100, nextProductId: 200,
  };
  const db = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      state.queries.push({ q, params });
      if (/^SELECT id, product_id, sku, channel/.test(q)) {
        return { rows: state.skus.filter((s) => s.channel === params[0]).map((s) => ({ ...s })) };
      }
      if (/^SELECT id, canonical_name, nickname, merged_into_product_id/.test(q)) {
        return { rows: state.products.map((p) => ({ ...p })) };
      }
      if (/^SELECT id FROM v3\.products WHERE canonical_name/.test(q)) {
        const p = state.products.find((x) => x.canonical_name === params[0]);
        return { rows: p ? [{ id: p.id }] : [] };
      }
      if (/^INSERT INTO v3\.products/.test(q)) {
        if (state.products.some((x) => x.canonical_name === params[0])) return { rows: [] };
        const row = { id: state.nextProductId++, canonical_name: params[0],
          nickname: null, merged_into_product_id: null };
        state.products.push(row);
        state.writes.push({ kind: 'product_insert', name: params[0] });
        return { rows: [{ id: row.id }] };
      }
      if (/^INSERT INTO v3\.product_skus/.test(q)) {
        const [productId, sku, channel, units, isBase] = params;
        if (state.skus.some((s) => s.channel === channel && s.sku === sku)) return { rows: [] };
        const row = { id: state.nextSkuId++, product_id: productId, sku, channel,
          units_per_pack: units, is_base: isBase };
        state.skus.push(row);
        state.writes.push({ kind: 'sku_insert', sku, product_id: productId, units_per_pack: units });
        return { rows: [{ id: row.id }] };
      }
      if (/^UPDATE v3\.product_skus SET units_per_pack/.test(q)) {
        const [channel, sku, units] = params;
        const row = state.skus.find((s) => s.channel === channel
          && String(s.sku).toUpperCase() === sku && Number(s.units_per_pack) !== Number(units));
        if (!row) return { rows: [] };
        row.units_per_pack = units;
        state.writes.push({ kind: 'units_update', sku, units_per_pack: units });
        return { rows: [{ id: row.id }] };
      }
      return { rows: [] };
    },
  };
  return { db, state };
}

const boot = (seed, veeqoRows = CATALOG) => {
  const { db, state } = makeDb(seed);
  const sync = createSkuSync({ db, veeqo: { listSellables: async () => veeqoRows } });
  return { db, state, sync };
};

describe('apply(): a parte segura', () => {
  test('liga o -C4 órfão no pai e grava units 4', async () => {
    const { state, sync } = boot(currentBase());
    const p = await sync.preview();
    const out = await sync.apply(p, { create_missing: false });
    expect(out.linked).toBeGreaterThanOrEqual(2);
    const nac4 = state.skus.find((s) => s.sku === 'HF-NAC-1300-C4');
    expect(nac4).toMatchObject({ product_id: 10, units_per_pack: 4, is_base: false });
    expect(state.skus.find((s) => s.sku === 'HF-NAC-1300-C2-C4').units_per_pack).toBe(8);
  });

  test('corrige units_per_pack errado sem trocar o produto', async () => {
    const seed = currentBase();
    seed.skus.push({ id: 2, product_id: 10, sku: 'HF-NAC-1300-C4', channel: 'veeqo',
      units_per_pack: 1, is_base: false });
    const { state, sync } = boot(seed);
    const out = await sync.run({ create_missing: false });
    expect(out.applied.units_fixed).toBe(1);
    const row = state.skus.find((s) => s.sku === 'HF-NAC-1300-C4');
    expect(row.units_per_pack).toBe(4);
    expect(row.product_id).toBe(10);
  });

  test('NÃO cria produto quando create_missing é false', async () => {
    const { state, sync } = boot(currentBase());
    const p = await sync.preview();
    const out = await sync.apply(p, { create_missing: false });
    expect(out.created).toBe(0);
    expect(state.writes.some((w) => w.kind === 'product_insert')).toBe(false);
    expect(state.products.length).toBe(1);
  });

  test('cria produto novo quando create_missing é true, com a raiz como base', async () => {
    const { state, sync } = boot(currentBase());
    const p = await sync.preview();
    const out = await sync.apply(p, { create_missing: true });
    expect(out.created).toBeGreaterThanOrEqual(2);
    const berb = state.products.find((x) => x.canonical_name === 'Berberine 5000mg');
    expect(berb).toBeTruthy();
    const baseSku = state.skus.find((s) => s.sku === 'HF-BERB-5000');
    expect(baseSku).toMatchObject({ product_id: berb.id, units_per_pack: 1, is_base: true });
  });

  test('nome já existente reaproveita o produto em vez de duplicar', async () => {
    const seed = currentBase();
    seed.products.push({ id: 30, canonical_name: 'Berberine 5000mg', nickname: 'BERB',
      merged_into_product_id: null });
    const { state, sync } = boot(seed);
    const p = await sync.preview();
    const out = await sync.apply(p, { create_missing: true });
    expect(state.products.filter((x) => x.canonical_name === 'Berberine 5000mg').length).toBe(1);
    expect(state.skus.find((s) => s.sku === 'HF-BERB-5000').product_id).toBe(30);
    expect(out.created).toBeLessThan(3);
  });

  test('NUNCA escreve quantidade: nenhuma query toca movimento, bin ou caixa', async () => {
    const { state, sync } = boot(currentBase());
    await sync.run({ create_missing: true });
    const bad = state.queries.filter((x) =>
      /stock_movements|stock_bins|stock_boxes|stock_unplaced|stock_issues/i.test(x.q));
    expect(bad).toEqual([]);
  });

  test('NUNCA junta produtos: nenhum UPDATE reaponta product_id de SKU', async () => {
    const seed = {
      skus: [
        { id: 1, product_id: 10, sku: 'HF-NAC-1300', channel: 'veeqo', units_per_pack: 1, is_base: true },
        { id: 2, product_id: 11, sku: 'HF-NAC-1300-C4', channel: 'veeqo', units_per_pack: 4, is_base: true },
      ],
      products: [
        { id: 10, canonical_name: 'Nac 1300mg', nickname: 'NAC', merged_into_product_id: null },
        { id: 11, canonical_name: 'NAC x4', nickname: 'NAC x4', merged_into_product_id: null },
      ],
    };
    const { state, sync } = boot(seed);
    await sync.run({ create_missing: true });
    expect(state.queries.some((x) => /UPDATE v3\.product_skus SET product_id/i.test(x.q))).toBe(false);
    expect(state.queries.some((x) => /merged_into_product_id\s*=/i.test(x.q))).toBe(false);
    expect(state.skus.find((s) => s.sku === 'HF-NAC-1300-C4').product_id).toBe(11);
  });
});

describe('idempotência: a segunda rodada não muda nada', () => {
  test('link + units fix: nada escrito na segunda passada', async () => {
    const seed = currentBase();
    seed.skus.push({ id: 2, product_id: 10, sku: 'HF-NAC-1300-C4', channel: 'veeqo',
      units_per_pack: 1, is_base: false });
    const { state, sync } = boot(seed);
    const first = await sync.run({ create_missing: true });
    const writesAfterFirst = state.writes.length;
    expect(writesAfterFirst).toBeGreaterThan(0);

    const second = await sync.run({ create_missing: true });
    expect(state.writes.length).toBe(writesAfterFirst);
    expect(second.applied.linked).toBe(0);
    expect(second.applied.units_fixed).toBe(0);
    expect(second.applied.created).toBe(0);
    expect(second.plan.link.length).toBe(0);
    expect(first.applied.linked).toBeGreaterThan(0);
  });

  test('o plano da segunda rodada só tem os conflitos que dependem de gente', async () => {
    const seed = {
      skus: [{ id: 1, product_id: 20, sku: 'HF-BERB-5000-C2', channel: 'veeqo',
        units_per_pack: 2, is_base: true }],
      products: [{ id: 20, canonical_name: 'Berberine 5000mg', nickname: 'BERB',
        merged_into_product_id: null }],
    };
    const { sync } = boot(seed);
    await sync.run({ create_missing: true });
    const second = await sync.preview();
    // base_is_casepack continua lá de propósito: é fato do mundo, não pendência
    expect(second.conflicts.some((c) => c.kind === 'base_is_casepack')).toBe(true);
    expect(second.link.length).toBe(0);
  });
});

// ── 4. o worker ────────────────────────────────────────────────────────────

function makeWorkerDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      state.queries.push({ q, params });
      if (/action = 'sku_sync'/.test(q) && q.startsWith('SELECT')) {
        const hit = state.marks.some((m) => m.ny_date === params[0] && m.sig === params[1]);
        return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 };
      }
      if (/INSERT INTO v3\.audit_log/.test(q)) {
        state.marks.push(JSON.parse(params[0]));
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const atNy = (dateStr, hour = 10) => () => new Date(Date.UTC(
  Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1,
  Number(dateStr.slice(8, 10)), hour + 4, 30, 0));

function bootWorker({ planOut, applied, date = '2026-08-19', enabled = true, createProducts = false } = {}) {
  const state = { queries: [], marks: [], posts: [] };
  const worker = new VeeqoSkuSync({
    db: makeWorkerDb(state),
    sync: {
      preview: jest.fn(async () => planOut),
      apply: jest.fn(async () => applied),
    },
    slack: { postAs: jest.fn(async (m) => { state.posts.push(m); }) },
    channelId: 'C_ADMIN',
    enabled, createProducts,
    now: atNy(date),
  });
  return { state, worker };
}

const PLAN_QUIET = { link: [], create: [], conflicts: [], ignored: [],
  stats: { sellables: 483, link: 0, create: 0, conflicts: 0 } };
const APPLIED_QUIET = { linked: 0, units_fixed: 0, created: 0, skipped: 0, conflicts: 0, links: [] };

describe('worker veeqo-sku-sync', () => {
  test('desligado (opt-in) não faz nada', async () => {
    const { state, worker } = bootWorker({ planOut: PLAN_QUIET, applied: APPLIED_QUIET, enabled: false });
    expect(await worker.tick()).toEqual({ skipped: true });
    expect(state.posts.length).toBe(0);
    expect(worker.sync.preview).not.toHaveBeenCalled();
  });

  test('default é OFF quando o env não está setado', () => {
    const prev = process.env.WORKER_VEEQO_SKU_SYNC_ENABLED;
    delete process.env.WORKER_VEEQO_SKU_SYNC_ENABLED;
    const w = new VeeqoSkuSync({ db: null });
    expect(w.enabled).toBe(false);
    expect(w.createProducts).toBe(false);
    if (prev !== undefined) process.env.WORKER_VEEQO_SKU_SYNC_ENABLED = prev;
  });

  test('nada mudou e nada pendente → silêncio', async () => {
    const { state, worker } = bootWorker({ planOut: PLAN_QUIET, applied: APPLIED_QUIET });
    const out = await worker.tick();
    expect(out.posted).toBe(false);
    expect(state.posts.length).toBe(0);
  });

  test('SKU ligado → aviso curto em PT-BR no canal admin', async () => {
    const planOut = { ...PLAN_QUIET, create: [{ sku: 'HF-XPTO-100' }, { sku: 'HF-ZZZ-1' }] };
    const applied = { linked: 1, units_fixed: 0, created: 0, skipped: 0, conflicts: 0,
      links: [{ sku: 'HF-NAC-1300-C4', product_id: 10, units_per_pack: 4, reason: 'casepack_of_root' }] };
    const { state, worker } = bootWorker({ planOut, applied });
    const out = await worker.tick();
    expect(out.posted).toBe(true);
    const post = state.posts[0];
    expect(post.channel).toBe('C_ADMIN');
    expect(post.text).toContain('SKUs novos da Veeqo');
    expect(post.text).toContain('HF-NAC-1300-C4 ligado no produto 10 (pacote de 4)');
    expect(post.text).toContain('2 SKUs sem pai: conferir no Estoque');
  });

  test('conflito de raiz disputada aparece como "juntar no hub"', async () => {
    const planOut = { ...PLAN_QUIET,
      conflicts: [{ sku: 'HF-NAC-1300', kind: 'root_taken_by_two_products', detail: {} }] };
    const { state, worker } = bootWorker({ planOut, applied: APPLIED_QUIET });
    await worker.tick();
    expect(state.posts[0].text).toContain('1 raiz em dois produtos: juntar no hub');
  });

  test('dedupe: mesmo resultado no mesmo dia NY não repete a mensagem', async () => {
    const applied = { ...APPLIED_QUIET, linked: 1,
      links: [{ sku: 'HF-A-C2', product_id: 5, units_per_pack: 2, reason: 'casepack_of_root' }] };
    const { state, worker } = bootWorker({ planOut: PLAN_QUIET, applied });
    await worker.tick();
    const again = await worker.tick();
    expect(again.posted).toBe(false);
    expect(state.posts.length).toBe(1);
  });

  test('dia novo em NY → fala de novo', async () => {
    const applied = { ...APPLIED_QUIET, linked: 1,
      links: [{ sku: 'HF-A-C2', product_id: 5, units_per_pack: 2, reason: 'casepack_of_root' }] };
    const { state, worker } = bootWorker({ planOut: PLAN_QUIET, applied });
    await worker.tick();
    worker.now = atNy('2026-08-20');
    await worker.tick();
    expect(state.posts.length).toBe(2);
  });

  test('createProducts OFF por default → apply chamado com create_missing false', async () => {
    const { worker } = bootWorker({ planOut: PLAN_QUIET, applied: APPLIED_QUIET });
    await worker.tick();
    expect(worker.sync.apply).toHaveBeenCalledWith(PLAN_QUIET, { create_missing: false });
  });

  test('SKU_SYNC_CREATE_PRODUCTS ligado → create_missing true', async () => {
    const { worker } = bootWorker({ planOut: PLAN_QUIET, applied: APPLIED_QUIET, createProducts: true });
    await worker.tick();
    expect(worker.sync.apply).toHaveBeenCalledWith(PLAN_QUIET, { create_missing: true });
  });

  test('NUNCA escreve quantidade: nenhuma query do worker toca estoque', async () => {
    const applied = { ...APPLIED_QUIET, linked: 1,
      links: [{ sku: 'HF-A-C2', product_id: 5, units_per_pack: 2, reason: 'casepack_of_root' }] };
    const { state, worker } = bootWorker({ planOut: PLAN_QUIET, applied });
    await worker.tick();
    expect(state.queries.filter((x) =>
      /stock_movements|stock_bins|stock_boxes|stock_unplaced/i.test(x.q))).toEqual([]);
  });

  test('estilo: sem em dash e no máximo 1 emoji', async () => {
    const planOut = { ...PLAN_QUIET, create: [{ sku: 'A' }],
      conflicts: [{ kind: 'root_taken_by_two_products' }, { kind: 'base_is_casepack' }] };
    const applied = { ...APPLIED_QUIET, linked: 2,
      links: [{ sku: 'HF-A-C2', product_id: 5, units_per_pack: 2, reason: 'casepack_of_root' },
        { sku: 'HF-B-C4', product_id: 6, units_per_pack: 4, reason: 'units_fix' }] };
    const { state, worker } = bootWorker({ planOut, applied });
    await worker.tick();
    for (const p of state.posts) {
      expect(p.text).not.toMatch(/—/);
      expect((p.text.match(/:[a-z_]+:/g) || []).length).toBeLessThanOrEqual(1);
    }
  });

  test('lista longa é cortada com "e mais N"', async () => {
    const links = Array.from({ length: 25 }, (_, i) => ({ sku: 'HF-X' + i + '-C2',
      product_id: i, units_per_pack: 2, reason: 'casepack_of_root' }));
    const { state, worker } = bootWorker({ planOut: PLAN_QUIET,
      applied: { ...APPLIED_QUIET, linked: 25, links } });
    await worker.tick();
    expect(state.posts[0].text).toContain('e mais 15');
  });

  test('Slack fora do ar não derruba o tick', async () => {
    const applied = { ...APPLIED_QUIET, linked: 1,
      links: [{ sku: 'HF-A-C2', product_id: 5, units_per_pack: 2, reason: 'casepack_of_root' }] };
    const { worker } = bootWorker({ planOut: PLAN_QUIET, applied });
    worker.slack = { postAs: async () => { throw new Error('slack down'); } };
    const out = await worker.tick();
    expect(out.linked).toBe(1);
    expect(out.posted).toBe(true);
  });

  test('start/stop não deixam timer pendurado', () => {
    const { worker } = bootWorker({ planOut: PLAN_QUIET, applied: APPLIED_QUIET });
    worker.start(1000);
    expect(worker._t).not.toBeNull();
    worker.stop();
    expect(worker._t).toBeNull();
    expect(worker._kick).toBeNull();
  });
});

// ── 5. as rotas do hub ─────────────────────────────────────────────────────
// Express de verdade num socket efêmero. PINs FICTÍCIOS (os reais só existem em
// env/produção).

const express = require('express');
const { createWarehouseRouter } = require('../v3/warehouse/router');

const ADMIN_PIN = '111111';    // fictício: manage_stock
const VIEWER_PIN = '222222';   // fictício: só view_stock

function makeRouterDb(rstate) {
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
        rstate.audit.push({ action: params[1], after: params[3] });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

let server; let baseUrl; let rstate; let routerSync;

async function bootRouter(syncOver = {}) {
  if (server) await new Promise((r) => server.close(r));
  rstate = { audit: [] };
  routerSync = Object.assign({
    preview: jest.fn(async () => plan(CATALOG, currentBase())),
    apply: jest.fn(async () => ({ linked: 3, units_fixed: 1, created: 0, skipped: 2,
      conflicts: 0, products: [], links: [] })),
  }, syncOver);
  const app = express();
  app.use('/', createWarehouseRouter({
    db: makeRouterDb(rstate),
    stock: { overview: async () => [], productDetail: async () => null },
    requests: { list: async () => [] },
    veeqo: { listSellables: async () => CATALOG },
    skuSync: routerSync,
  }));
  server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function call(method, path, body, pin = ADMIN_PIN) {
  const r = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', ...(pin ? { 'x-admin-pin': pin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
}

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('GET /sku-sync/preview', () => {
  test('devolve o plano inteiro e NÃO escreve nada', async () => {
    await bootRouter();
    const r = await call('GET', '/api/v3/warehouse/sku-sync/preview');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.link.some((l) => l.sku === 'HF-NAC-1300-C4')).toBe(true);
    expect(d.create.some((c) => c.sku === 'HF-BERB-5000')).toBe(true);
    expect(Array.isArray(d.conflicts)).toBe(true);
    expect(d.ignored.some((i) => i.sku === 'HF-PLN-MONTHLY')).toBe(true);
    expect(d.stats.sellables).toBe(13);
    expect(routerSync.apply).not.toHaveBeenCalled();
    expect(rstate.audit).toEqual([]);
  });

  test('quem só vê estoque também pode olhar a prévia', async () => {
    await bootRouter();
    const r = await call('GET', '/api/v3/warehouse/sku-sync/preview', undefined, VIEWER_PIN);
    expect(r.status).toBe(200);
  });

  test('sem PIN é 401', async () => {
    await bootRouter();
    const r = await call('GET', '/api/v3/warehouse/sku-sync/preview', undefined, null);
    expect(r.status).toBe(401);
  });
});

describe('POST /sku-sync/apply', () => {
  test('aplica e devolve o que mudou + o plano de conflitos', async () => {
    await bootRouter();
    const r = await call('POST', '/api/v3/warehouse/sku-sync/apply', {});
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ linked: 3, units_fixed: 1, created: 0 });
    expect(r.body.data.plan.stats).toBeTruthy();
    expect(rstate.audit.some((a) => a.action === 'warehouse.sku_sync_apply')).toBe(true);
  });

  test('create_missing é FALSE por default (typo da Veeqo não vira produto)', async () => {
    await bootRouter();
    await call('POST', '/api/v3/warehouse/sku-sync/apply', {});
    expect(routerSync.apply.mock.calls[0][1].create_missing).toBe(false);
  });

  test('create_missing:true passa adiante', async () => {
    await bootRouter();
    await call('POST', '/api/v3/warehouse/sku-sync/apply', { create_missing: true });
    expect(routerSync.apply.mock.calls[0][1].create_missing).toBe(true);
  });

  test('"true" em texto NÃO liga a criação (só o booleano)', async () => {
    await bootRouter();
    await call('POST', '/api/v3/warehouse/sku-sync/apply', { create_missing: 'true' });
    expect(routerSync.apply.mock.calls[0][1].create_missing).toBe(false);
  });

  test('quem só vê estoque não pode aplicar', async () => {
    await bootRouter();
    const r = await call('POST', '/api/v3/warehouse/sku-sync/apply', {}, VIEWER_PIN);
    expect(r.status).toBe(403);
    expect(routerSync.apply).not.toHaveBeenCalled();
  });
});
