'use strict';
/**
 * ABSORÇÃO DA VEEQO (S15.41, Bruno 08-19).
 *
 * A pergunta, textual: "vc sabe quem sao todos os skus e seus titulos, as
 * imagens do veeqo vc ja associou ao nossos productos no sistema (...) se a
 * gente fechar nossa conta do veeqo hj vc vai ter tdas as info que precisamos
 * correto?"
 *
 * As fixtures são o formato REAL da /products da Veeqo (main_image_src, brand,
 * description com HTML de marketplace, sellables[] com sku_code/upc_code/type),
 * incluindo um KIT — o caso que mais quebra coisa aqui.
 *
 * O que se garante:
 *   1. o mapper monta o update certo a partir de produto + sellables
 *   2. barcode CONFIRMADO POR GENTE nunca é sobrescrito
 *   3. buraco de barcode é preenchido com o upc_code
 *   4. linha sem mudança não gera update (idempotência: 2ª rodada não escreve)
 *   5. a foto do produto vem do SKU BASE
 *   6. snapshot poda pros 8 mais recentes
 *   7. imagem acima do teto não é gravada
 *   8. NADA aqui escreve estoque (nenhuma query cita stock/bin/box/qty)
 */
const {
  createVeeqoAbsorb, absorbPlan, cleanDescription, IMAGE_MAX_BYTES, SNAPSHOT_KEEP,
} = require('../v3/warehouse/veeqo-absorb');
const { normalizeProduct } = require('../v3/services/veeqo-api');

// ── fixtures: resposta real da /products da Veeqo ───────────────────────────

/** Um produto CRU da Veeqo, com foto, marca, descrição e 4 sellables (1 kit). */
const RAW_PRODUCT = {
  id: 88123,
  title: 'Healthfare NAC 1300mg',
  brand: 'HealthFare',
  description: '<p>N-Acetyl Cysteine <b>1300mg</b>.</p><br>Supports liver &amp; lungs.',
  main_image_src: 'https://veeqo-images.s3.amazonaws.com/nac-main.jpg',
  thumbnail_url: 'https://veeqo-images.s3.amazonaws.com/nac-thumb.jpg',
  total_stock_level: 400,
  origin_country: 'US',
  hs_tariff_number: '2106.90',
  sellables: [
    { id: 1, sku_code: 'HF-NAC-1300', product_title: 'Healthfare NAC 1300mg | 120 Capsules',
      upc_code: '850038267018', type: 'ProductVariant' },
    { id: 2, sku_code: 'HF-NAC-1300-C2', product_title: 'Healthfare NAC 1300mg | 2 Bottles',
      upc_code: null, type: 'Kit' },
    { id: 3, sku_code: 'HF-NAC-1300-C4', product_title: 'Healthfare NAC 1300mg | 4 Bottles',
      upc_code: '850038267025', type: 'Kit' },
    // sellable com foto PRÓPRIA: tem que ganhar da foto do pai
    { id: 4, sku_code: 'HF-NAC-1300-C6', product_title: 'Healthfare NAC 1300mg | 6 Bottles',
      upc_code: null, type: 'Kit', main_image_src: 'https://veeqo-images.s3.amazonaws.com/nac-6.jpg' },
  ],
};

const PRODUCTS = [normalizeProduct(RAW_PRODUCT)];

/** listSellables() — a outra metade da leitura (título de listagem + UPC). */
const SELLABLES = [
  { sku: 'HF-NAC-1300', title: 'Healthfare NAC 1300mg | 120 Capsules',
    product_title: 'Healthfare NAC 1300mg', upc_code: '850038267018', type: 'variant' },
  { sku: 'HF-NAC-1300-C2', title: 'Healthfare NAC 1300mg | 2 Bottles',
    product_title: 'Healthfare NAC 1300mg', upc_code: null, type: 'kit' },
  { sku: 'HF-NAC-1300-C4', title: 'Healthfare NAC 1300mg | 4 Bottles',
    product_title: 'Healthfare NAC 1300mg', upc_code: '850038267025', type: 'kit' },
  { sku: 'HF-NAC-1300-C6', title: 'Healthfare NAC 1300mg | 6 Bottles',
    product_title: 'Healthfare NAC 1300mg', upc_code: null, type: 'kit' },
];

/** Nosso estado ANTES: os 4 SKUs mapeados, sem título, sem foto, sem barcode.
 *  É exatamente o estado medido em produção em 08-19. */
function currentEmpty() {
  return {
    skus: [
      { id: 1, product_id: 10, sku: 'HF-NAC-1300', channel: 'veeqo', is_base: true,
        barcode: null, confirmed_at: null },
      { id: 2, product_id: 10, sku: 'HF-NAC-1300-C2', channel: 'veeqo', is_base: false,
        barcode: null, confirmed_at: null },
      { id: 3, product_id: 10, sku: 'HF-NAC-1300-C4', channel: 'veeqo', is_base: false,
        barcode: null, confirmed_at: null },
      { id: 4, product_id: 10, sku: 'HF-NAC-1300-C6', channel: 'veeqo', is_base: false,
        barcode: null, confirmed_at: null },
    ],
    products: [{ id: 10, image_url: null, brand: null }],
    images: [],
  };
}

/** O estado DEPOIS de uma absorção — pra provar idempotência. */
function currentAbsorbed() {
  const c = currentEmpty();
  const p = absorbPlan(SELLABLES, PRODUCTS, c);
  for (const u of p.updates) {
    const row = c.skus.find((s) => s.sku === u.sku);
    Object.assign(row, u.fields);
    if (u.fields.barcode) row.barcode = u.fields.barcode;
  }
  for (const pi of p.product_images) {
    const row = c.products.find((x) => x.id === pi.product_id);
    row.image_url = pi.image_url; row.brand = pi.brand;
  }
  for (const d of p.downloads) c.images.push({ product_id: d.product_id, source_url: d.source_url });
  return c;
}

// ── db falso que GRAVA as queries (é como o teste 8 prova a regra do estoque) ─
function fakeDb(rowsFor) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      const r = rowsFor ? rowsFor(String(sql), params) : null;
      if (r) return r;
      return { rows: [], rowCount: 0 };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('absorbPlan — o mapper puro', () => {
  test('1. monta o update certo a partir do produto + sellables', () => {
    const p = absorbPlan(SELLABLES, PRODUCTS, currentEmpty());

    expect(p.updates).toHaveLength(4);
    const base = p.updates.find((u) => u.sku === 'HF-NAC-1300');
    expect(base.fields.title).toBe('Healthfare NAC 1300mg | 120 Capsules');
    expect(base.fields.product_title).toBe('Healthfare NAC 1300mg');
    expect(base.fields.brand).toBe('HealthFare');
    expect(base.fields.veeqo_type).toBe('variant');
    expect(base.fields.veeqo_product_id).toBe(88123);
    expect(base.fields.image_url).toBe('https://veeqo-images.s3.amazonaws.com/nac-main.jpg');
    expect(base.fields.thumb_url).toBe('https://veeqo-images.s3.amazonaws.com/nac-thumb.jpg');
    // descrição: HTML de marketplace vira texto (nunca renderizamos HTML de terceiro)
    expect(base.fields.description).toBe('N-Acetyl Cysteine 1300mg.\nSupports liver & lungs.');
    expect(base.fields.description).not.toMatch(/</);

    // o KIT é absorvido igual, e marcado como kit
    const kit = p.updates.find((u) => u.sku === 'HF-NAC-1300-C4');
    expect(kit.fields.veeqo_type).toBe('kit');
    expect(kit.fields.title).toBe('Healthfare NAC 1300mg | 4 Bottles');

    // sellable com foto própria ganha da foto do pai
    const c6 = p.updates.find((u) => u.sku === 'HF-NAC-1300-C6');
    expect(c6.fields.image_url).toBe('https://veeqo-images.s3.amazonaws.com/nac-6.jpg');

    expect(p.stats.sellables).toBe(4);
    expect(p.stats.products).toBe(1);
    expect(p.stats.with_upc).toBe(2);
    expect(p.stats.with_image).toBe(4);
    expect(p.stats.changed).toBe(4);
    expect(p.stats.unchanged).toBe(0);
  });

  test('3. preenche o barcode vazio com o upc_code da Veeqo', () => {
    const p = absorbPlan(SELLABLES, PRODUCTS, currentEmpty());
    const base = p.updates.find((u) => u.sku === 'HF-NAC-1300');
    expect(base.fields.barcode).toBe('850038267018');
    expect(base.barcode_fill).toBe(true);
    // SKU sem upc na Veeqo não ganha barcode inventado
    const c2 = p.updates.find((u) => u.sku === 'HF-NAC-1300-C2');
    expect(c2.fields.barcode).toBeUndefined();
    expect(p.stats.barcode_fills).toBe(2);
  });

  test('2. NUNCA sobrescreve barcode confirmado por uma pessoa', () => {
    const cur = currentEmpty();
    // alguém escaneou a garrafa e gravou um código DIFERENTE do da Veeqo
    cur.skus[0].barcode = '111111111111';
    cur.skus[0].confirmed_at = '2026-08-10T12:00:00Z';
    cur.skus[0].confirmed_by_person_id = 7;

    const p = absorbPlan(SELLABLES, PRODUCTS, cur);
    const base = p.updates.find((u) => u.sku === 'HF-NAC-1300');
    expect(base.fields.barcode).toBeUndefined();       // não entra no UPDATE
    expect(base.barcode_fill).toBe(false);
    expect(p.stats.confirmed_kept).toBe(1);            // e o conflito fica contado
  });

  test('2b. barcode NÃO confirmado também não é sobrescrito quando já existe', () => {
    const cur = currentEmpty();
    cur.skus[0].barcode = '999999999999';   // veio de outro lugar, sem confirmação
    const p = absorbPlan(SELLABLES, PRODUCTS, cur);
    const base = p.updates.find((u) => u.sku === 'HF-NAC-1300');
    expect(base.fields.barcode).toBeUndefined();
  });

  test('4. linha já absorvida não gera update (idempotência)', () => {
    const p = absorbPlan(SELLABLES, PRODUCTS, currentAbsorbed());
    expect(p.updates).toHaveLength(0);
    expect(p.product_images).toHaveLength(0);
    expect(p.downloads).toHaveLength(0);
    expect(p.stats.changed).toBe(0);
    expect(p.stats.unchanged).toBe(4);
  });

  test('5. a foto do produto vem do SKU BASE, não de um kit qualquer', () => {
    const p = absorbPlan(SELLABLES, PRODUCTS, currentEmpty());
    expect(p.product_images).toHaveLength(1);
    expect(p.product_images[0]).toMatchObject({
      product_id: 10,
      image_url: 'https://veeqo-images.s3.amazonaws.com/nac-main.jpg',
      brand: 'HealthFare',
      from_sku: 'HF-NAC-1300',
    });
    // e um download pendente pro mesmo produto
    expect(p.downloads).toEqual([{ product_id: 10,
      source_url: 'https://veeqo-images.s3.amazonaws.com/nac-main.jpg', sku: 'HF-NAC-1300' }]);
  });

  test('5b. sem base com foto, um filho serve (é a mesma garrafa)', () => {
    const cur = currentEmpty();
    cur.skus = cur.skus.filter((s) => s.sku !== 'HF-NAC-1300');   // só os kits mapeados
    const p = absorbPlan(SELLABLES, PRODUCTS, cur);
    expect(p.product_images).toHaveLength(1);
    expect(p.product_images[0].product_id).toBe(10);
    expect(p.product_images[0].image_url).toBeTruthy();
  });

  test('SKU que a Veeqo tem e nós não fica de fora (quem cria linha é o sku-sync)', () => {
    const cur = currentEmpty();
    cur.skus = [cur.skus[0]];
    const p = absorbPlan(SELLABLES, PRODUCTS, cur);
    expect(p.updates.map((u) => u.sku)).toEqual(['HF-NAC-1300']);
  });

  test('conta o que AINDA falta (a resposta ao "e se fechar hoje")', () => {
    const cur = currentEmpty();
    // um SKU nosso que a Veeqo nem lista: sem título, sem foto, sem UPC
    cur.skus.push({ id: 9, product_id: 11, sku: 'HF-ORFAO', channel: 'veeqo',
      is_base: true, barcode: null, confirmed_at: null });
    const p = absorbPlan(SELLABLES, PRODUCTS, cur);
    expect(p.stats.missing.title).toBe(1);
    expect(p.stats.missing.image).toBe(1);
    // 2 dos 4 da Veeqo não têm UPC, mais o órfão = 3
    expect(p.stats.missing.upc).toBe(3);
  });

  test('é PURO: não muda a entrada e repete o resultado', () => {
    const cur = currentEmpty();
    const snap = JSON.stringify({ SELLABLES, PRODUCTS, cur });
    const a = absorbPlan(SELLABLES, PRODUCTS, cur);
    const b = absorbPlan(SELLABLES, PRODUCTS, cur);
    expect(JSON.stringify({ SELLABLES, PRODUCTS, cur })).toBe(snap);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('entrada vazia não estoura e não inventa update', () => {
    const p = absorbPlan([], [], {});
    expect(p.updates).toHaveLength(0);
    expect(p.stats.changed).toBe(0);
  });
});

describe('cleanDescription', () => {
  test('tira HTML e entidades, corta em 4000', () => {
    expect(cleanDescription('<p>a &amp; b</p>')).toBe('a & b');
    expect(cleanDescription('<script>alert(1)</script>x')).toBe('alert(1) x');
    expect(cleanDescription('x'.repeat(5000))).toHaveLength(4000);
    expect(cleanDescription('   ')).toBeNull();
    expect(cleanDescription(null)).toBeNull();
  });
});

describe('apply — a metade que escreve', () => {
  test('escreve só as colunas descritivas + barcode, e conta certo', async () => {
    const db = fakeDb((sql) => (/UPDATE v3\.product_skus/.test(sql)
      ? { rows: [{ id: 1 }], rowCount: 1 } : null));
    const absorb = createVeeqoAbsorb({ db, veeqo: null });
    const p = absorbPlan(SELLABLES, PRODUCTS, currentEmpty());
    const out = await absorb.apply(p);

    expect(out.updated).toBe(4);
    expect(out.barcode_filled).toBe(2);

    const upd = db.queries.filter((q) => /UPDATE v3\.product_skus/.test(q.sql));
    expect(upd).toHaveLength(4);
    for (const q of upd) {
      expect(q.sql).toMatch(/absorbed_at = NOW\(\)/);
      expect(q.sql).toMatch(/WHERE channel = \$1 AND UPPER\(sku\) = \$2/);
    }
  });

  test('8. NADA escreve estoque (nenhuma query cita stock/bin/box/qty)', async () => {
    const db = fakeDb(() => ({ rows: [{ id: 1 }], rowCount: 1 }));
    const absorb = createVeeqoAbsorb({ db, veeqo: null,
      fetchImpl: async () => ({ ok: true, headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new Uint8Array(100).buffer }) });
    const p = absorbPlan(SELLABLES, PRODUCTS, currentEmpty());
    await absorb.apply(p, { seen_skus: SELLABLES.map((s) => s.sku) });
    await absorb.snapshot(SELLABLES, PRODUCTS);
    await absorb.loadCurrent();

    expect(db.queries.length).toBeGreaterThan(0);
    for (const q of db.queries) {
      expect(q.sql).not.toMatch(/stock_movements|stock_bins|stock_boxes|stock_requests/i);
      // 'qty' como coluna escrita; product_skus/products/product_images/snapshots não têm
      expect(q.sql).not.toMatch(/\bqty\b/i);
      expect(q.sql).not.toMatch(/INSERT INTO v3\.stock|UPDATE v3\.stock/i);
    }
  });

  test('grava a foto do produto (url + marca) sem apagar marca existente', async () => {
    const db = fakeDb(() => ({ rows: [{ id: 10 }], rowCount: 1 }));
    const absorb = createVeeqoAbsorb({ db, veeqo: null, fetchImpl: null });
    const p = absorbPlan(SELLABLES, PRODUCTS, currentEmpty());
    const out = await absorb.apply({ product_images: p.product_images });
    expect(out.products_touched).toBe(1);
    const q = db.queries.find((x) => /UPDATE v3\.products/.test(x.sql));
    expect(q.sql).toMatch(/brand = COALESCE\(\$3, brand\)/);
  });
});

describe('imagens', () => {
  const okFetch = (bytes, mime = 'image/jpeg') => async () => ({
    ok: true, status: 200,
    headers: { get: () => mime },
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  });

  test('baixa e grava os bytes', async () => {
    const db = fakeDb(() => ({ rows: [{ id: 1 }], rowCount: 1 }));
    const absorb = createVeeqoAbsorb({ db, veeqo: null, fetchImpl: okFetch(1234) });
    const out = await absorb.apply({ downloads: [
      { product_id: 10, source_url: 'https://x/a.jpg', sku: 'HF-NAC-1300' }] });
    expect(out.images_downloaded).toBe(1);
    const ins = db.queries.find((q) => /INSERT INTO v3\.product_images/.test(q.sql));
    expect(ins.sql).toMatch(/ON CONFLICT \(product_id\) DO UPDATE/);
    expect(Buffer.isBuffer(ins.params[3])).toBe(true);
    expect(ins.params[3]).toHaveLength(1234);
  });

  test('7. imagem acima do teto NÃO é gravada', async () => {
    const db = fakeDb(() => ({ rows: [{ id: 1 }], rowCount: 1 }));
    const absorb = createVeeqoAbsorb({ db, veeqo: null,
      fetchImpl: okFetch(IMAGE_MAX_BYTES + 1) });
    const out = await absorb.apply({ downloads: [
      { product_id: 10, source_url: 'https://x/huge.jpg' }] });
    expect(out.images_downloaded).toBe(0);
    expect(out.images_failed).toBe(1);
    expect(out.errors[0].why).toMatch(/grande demais/);
    expect(db.queries.some((q) => /INSERT INTO v3\.product_images/.test(q.sql))).toBe(false);
  });

  test('resposta que não é imagem é recusada', async () => {
    const db = fakeDb(() => ({ rows: [], rowCount: 0 }));
    const absorb = createVeeqoAbsorb({ db, veeqo: null, fetchImpl: okFetch(50, 'text/html') });
    const out = await absorb.apply({ downloads: [{ product_id: 10, source_url: 'https://x/a' }] });
    expect(out.images_downloaded).toBe(0);
    expect(out.images_failed).toBe(1);
  });

  test('falha de rede não derruba a rodada', async () => {
    const db = fakeDb(() => ({ rows: [], rowCount: 0 }));
    const absorb = createVeeqoAbsorb({ db, veeqo: null,
      fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    const out = await absorb.apply({ downloads: [{ product_id: 10, source_url: 'https://x/a' }] });
    expect(out.images_failed).toBe(1);
    expect(out.errors[0].why).toMatch(/ECONNRESET/);
  });

  test('respeita o teto de downloads por rodada', async () => {
    const db = fakeDb(() => ({ rows: [{ id: 1 }], rowCount: 1 }));
    const absorb = createVeeqoAbsorb({ db, veeqo: null, imageBatch: 2, fetchImpl: okFetch(10) });
    const downloads = [1, 2, 3, 4, 5].map((i) => ({ product_id: i, source_url: 'https://x/' + i }));
    const out = await absorb.apply({ downloads });
    expect(out.images_downloaded).toBe(2);
  });
});

describe('snapshot — o seguro contra o fim da conta', () => {
  test('6. grava o cru e poda pros 8 mais recentes', async () => {
    const db = fakeDb((sql) => (/INSERT INTO v3\.veeqo_snapshots/.test(sql)
      ? { rows: [{ id: 42 }], rowCount: 1 } : { rows: [], rowCount: 3 }));
    const absorb = createVeeqoAbsorb({ db, veeqo: null });
    const out = await absorb.snapshot(SELLABLES, PRODUCTS);

    expect(out.saved).toBe(true);
    expect(out.id).toBe(42);
    expect(out.pruned).toBe(3);

    const ins = db.queries.find((q) => /INSERT INTO v3\.veeqo_snapshots/.test(q.sql));
    expect(ins.params[0]).toBe(4);    // sellables
    expect(ins.params[1]).toBe(1);    // products
    // o payload guarda a resposta CRUA inteira, inclusive o que não sabemos usar
    const payload = JSON.parse(ins.params[2]);
    expect(payload.sellables).toHaveLength(4);
    expect(payload.products[0].id).toBe(88123);

    const del = db.queries.find((q) => /DELETE FROM v3\.veeqo_snapshots/.test(q.sql));
    expect(del.params[0]).toBe(SNAPSHOT_KEEP);
    expect(del.sql).toMatch(/ORDER BY id DESC LIMIT/);
  });

  test('leitura vazia não grava (senão a poda apagaria os snapshots bons)', async () => {
    const db = fakeDb();
    const absorb = createVeeqoAbsorb({ db, veeqo: null });
    const out = await absorb.snapshot([], []);
    expect(out.saved).toBe(false);
    expect(db.queries).toHaveLength(0);
  });
});

describe('run — a rodada inteira', () => {
  test('lê, aplica e guarda o cru', async () => {
    const db = fakeDb((sql) => {
      if (/FROM v3\.product_skus/.test(sql)) return { rows: currentEmpty().skus, rowCount: 4 };
      if (/FROM v3\.products/.test(sql)) return { rows: [{ id: 10, image_url: null, brand: null }], rowCount: 1 };
      if (/FROM v3\.product_images/.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO v3\.veeqo_snapshots/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [{ id: 1 }], rowCount: 1 };
    });
    const veeqo = {
      listSellables: async () => SELLABLES,
      listProducts: async () => PRODUCTS,
    };
    const absorb = createVeeqoAbsorb({ db, veeqo,
      fetchImpl: async () => ({ ok: true, headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new Uint8Array(500).buffer }) });

    const r = await absorb.run();
    expect(r.empty).toBe(false);
    expect(r.applied.updated).toBe(4);
    expect(r.applied.images_downloaded).toBe(1);
    expect(r.snapshot.saved).toBe(true);
  });

  test('Veeqo fora do ar: não grava snapshot vazio nem apaga o que tem', async () => {
    const db = fakeDb();
    const absorb = createVeeqoAbsorb({ db,
      veeqo: { listSellables: async () => [], listProducts: async () => [] } });
    const r = await absorb.run();
    expect(r.empty).toBe(true);
    expect(r.snapshot.saved).toBe(false);
    expect(db.queries.some((q) => /veeqo_snapshots/.test(q.sql))).toBe(false);
  });
});

describe('normalizeProduct — o cru da Veeqo vira a forma que a absorção usa', () => {
  test('acha a foto em qualquer dos campos que a Veeqo usa', () => {
    expect(normalizeProduct({ id: 1, main_image_src: 'a.jpg' }).image_url).toBe('a.jpg');
    expect(normalizeProduct({ id: 1, main_image: { src: 'b.jpg' } }).image_url).toBe('b.jpg');
    expect(normalizeProduct({ id: 1, image: 'c.jpg' }).image_url).toBe('c.jpg');
    expect(normalizeProduct({ id: 1 }).image_url).toBeNull();
  });

  test('traduz o tipo e descarta sellable sem SKU', () => {
    const p = normalizeProduct({ id: 1, sellables: [
      { sku_code: 'A', type: 'Kit' }, { sku_code: '', type: 'ProductVariant' },
      { sku_code: 'B', type: 'ProductVariant' }] });
    expect(p.sellables).toHaveLength(2);
    expect(p.sellables[0].type).toBe('kit');
    expect(p.sellables[1].type).toBe('variant');
  });
});
