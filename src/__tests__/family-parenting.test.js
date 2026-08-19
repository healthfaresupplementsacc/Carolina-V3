'use strict';
/**
 * SKU PARENTING — merge que LIMPA, unmerge e sugestões (Bruno 08-19, S15).
 *
 * A regra que estes testes protegem: casepack (-C2/-C3/-C4, "x3 kit") é SKU
 * diferente na Veeqo mas NÃO EXISTE fisicamente — a garrafa fica solta no mesmo
 * lugar da avulsa. Então o hub mostra UMA linha por produto físico, e o merge
 * tem que levar SKU + ESTOQUE e RETIRAR o fantasma (o print do Bruno mostra o
 * bug: 'AKKERM-INULIN' duas vezes, 'Apple Cider Vinegar' só com "x4 kit").
 *
 * Banco falso em memória (mesmo espírito do warehouse-router.test.js): nenhum
 * Postgres, nenhuma rede.
 */

const { FamilyRepo } = require('../v3/warehouse/family-repo');
const { StockService } = require('../v3/services/StockService');
const { suggest, normName, packOf, skuRoot } = require('../v3/warehouse/sku-suggest');

/**
 * Banco em memória que entende SÓ o que o family-repo + moveProduct usam.
 * As tabelas são arrays; as queries são casadas por regex na ordem que importa.
 */
function makeDb(seed = {}) {
  const t = {
    products: seed.products || [],
    product_skus: seed.product_skus || [],
    stock_bins: seed.stock_bins || [],
    stock_boxes: seed.stock_boxes || [],
    stock_unplaced: seed.stock_unplaced || [],
    stock_issues: seed.stock_issues || [],
    stock_movements: [],
    audit_log: [],
  };
  let movId = 1;

  const db = {
    tables: t,
    // moveProduct usa _withTx; sem .connect ele usa o próprio db como client
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();

      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(q)) return { rows: [] };

      // ── produtos ───────────────────────────────────────────
      if (/SELECT id, merged_into_product_id FROM v3\.products WHERE id/.test(q)) {
        const p = t.products.find((x) => x.id === params[0]);
        return { rows: p ? [{ id: p.id, merged_into_product_id: p.merged_into_product_id || null }] : [] };
      }
      if (/FROM v3\.products WHERE id = \$1/.test(q)) {
        const p = t.products.find((x) => x.id === params[0]);
        return { rows: p ? [p] : [] };
      }
      if (/FROM v3\.products WHERE merged_into_product_id = \$1/.test(q)) {
        return { rows: t.products.filter((x) => x.merged_into_product_id === params[0]) };
      }
      if (/UPDATE v3\.products SET merged_into_product_id = \$2, merged_at/.test(q)) {
        const p = t.products.find((x) => x.id === params[0] && x.merged_into_product_id == null);
        if (!p) return { rows: [] };
        p.merged_into_product_id = params[1]; p.merged_at = 'now'; p.merged_by_person_id = params[2];
        return { rows: [{ id: p.id }] };
      }
      // repai da cadeia: quem apontava pro fantasma passa a apontar pro novo pai
      if (/UPDATE v3\.products SET merged_into_product_id = \$2 WHERE merged_into_product_id = \$1/.test(q)) {
        const hit = t.products.filter((x) => x.merged_into_product_id === params[0]);
        hit.forEach((x) => { x.merged_into_product_id = params[1]; });
        return { rows: hit };
      }
      if (/UPDATE v3\.products SET merged_into_product_id = NULL/.test(q)) {
        const p = t.products.find((x) => x.id === params[0]);
        p.merged_into_product_id = null; p.merged_at = null; p.merged_by_person_id = null;
        return { rows: [p] };
      }

      // ── SKUs ───────────────────────────────────────────────
      if (/FROM v3\.product_skus WHERE product_id = \$1/.test(q)) {
        return { rows: t.product_skus.filter((s) => s.product_id === params[0]) };
      }
      if (/UPDATE v3\.product_skus SET product_id = \$2 WHERE product_id = \$1/.test(q)) {
        const moved = t.product_skus.filter((s) => s.product_id === params[0]);
        moved.forEach((s) => { s.product_id = params[1]; });
        return { rows: moved };
      }
      if (/UPDATE v3\.product_skus SET product_id = \$2 WHERE id = ANY/.test(q)) {
        const ids = params[0]; const to = params[1]; const fromParent = params[2];
        const moved = t.product_skus.filter((s) => ids.includes(s.id) && s.product_id === fromParent);
        moved.forEach((s) => { s.product_id = to; });
        return { rows: moved };
      }
      if (/UPDATE v3\.product_skus SET is_base = false/.test(q)) return { rows: [] };

      // ── audit ──────────────────────────────────────────────
      if (/INSERT INTO v3\.audit_log/.test(q)) {
        t.audit_log.push({ id: t.audit_log.length + 1, action: params[2],
          target_id: params[3], after_data: params[5] });
        return { rows: [] };
      }
      if (/FROM v3\.audit_log/.test(q)) {
        return { rows: t.audit_log
          .filter((a) => a.action === 'warehouse.family_merge' && a.target_id === params[0])
          .reverse().map((a) => ({ after_data: a.after_data })) };
      }

      // ── estoque (moveProduct) ──────────────────────────────
      if (/FROM v3\.stock_bins WHERE product_id = \$1/.test(q)) {
        return { rows: t.stock_bins.filter((b) => b.product_id === params[0]) };
      }
      if (/FROM v3\.stock_boxes WHERE product_id = \$1/.test(q)) {
        return { rows: t.stock_boxes.filter((b) => b.product_id === params[0]) };
      }
      if (/UPDATE v3\.stock_bins SET product_id = \$2/.test(q)) {
        const b = t.stock_bins.find((x) => x.id === params[0]);
        if (b) b.product_id = params[1];
        return { rows: [] };
      }
      if (/UPDATE v3\.stock_boxes SET product_id = \$2/.test(q)) {
        const b = t.stock_boxes.find((x) => x.id === params[0]);
        if (b) b.product_id = params[1];
        return { rows: [] };
      }
      if (/FROM v3\.stock_unplaced WHERE product_id/.test(q)) {
        const u = t.stock_unplaced.find((x) => x.product_id === params[0]);
        return { rows: u ? [u] : [] };
      }
      if (/INSERT INTO v3\.stock_unplaced/.test(q)) {
        const u = t.stock_unplaced.find((x) => x.product_id === params[0]);
        if (u) u.qty = params[1];
        else t.stock_unplaced.push({ product_id: params[0], qty: params[1] });
        return { rows: [] };
      }
      if (/UPDATE v3\.stock_issues SET product_id = \$2/.test(q)) {
        t.stock_issues.filter((i) => i.product_id === params[0])
          .forEach((i) => { i.product_id = params[1]; });
        return { rows: [] };
      }
      if (/INSERT INTO v3\.stock_movements/.test(q)) {
        const [kind, product_id, qty, bin_id, box_id, person_id, source, source_ref] = params;
        if (source_ref && t.stock_movements.some((m) => m.source === source && m.source_ref === source_ref)) {
          return { rows: [] };     // ON CONFLICT DO NOTHING
        }
        const m = { id: movId++, kind, product_id, qty, bin_id, box_id, person_id, source, source_ref };
        t.stock_movements.push(m);
        return { rows: [m] };
      }
      if (/FROM v3\.stock_movements WHERE source = \$1 AND source_ref = \$2/.test(q)) {
        const m = t.stock_movements.find((x) => x.source === params[0] && x.source_ref === params[1]);
        return { rows: m ? [m] : [] };
      }

      return { rows: [] };
    },
  };
  return db;
}

/** Cenário do print do Bruno: AKKERM-INULIN duplicado, com estoque no fantasma. */
function seedAkkerm() {
  return makeDb({
    products: [
      { id: 1, canonical_name: 'AKKERM-INULIN', nickname: 'Akkermansia', merged_into_product_id: null },
      { id: 2, canonical_name: 'AKKERM-INULIN', nickname: null, merged_into_product_id: null },
    ],
    product_skus: [
      { id: 10, product_id: 1, sku: 'AKKERM-INULIN', channel: 'veeqo', units_per_pack: 1, is_base: false },
      { id: 11, product_id: 2, sku: 'AKKERM-INULIN-C3', channel: 'veeqo', units_per_pack: 3, is_base: false },
    ],
    stock_bins: [{ id: 50, product_id: 2, bin_code: 'A01', qty: 40 }],
    stock_boxes: [{ id: 60, product_id: 2, box_number: 'BOX-9', qty: 100 }],
    stock_unplaced: [{ product_id: 2, qty: 7 }],
    stock_issues: [{ id: 70, product_id: 2, qty: 2, status: 'separated' }],
  });
}

function repoOf(db) {
  const stock = new StockService({ db });
  return { repo: new FamilyRepo({ db, stock }), stock };
}

describe('merge que limpa: SKUs + estoque + fantasma retirado', () => {
  test('leva SKUs, move todo o estoque e retira o produto fantasma', async () => {
    const db = seedAkkerm();
    const { repo } = repoOf(db);

    const out = await repo.merge({ from_product_id: 2, into_product_id: 1, person_id: 9 });

    // SKUs foram pro pai
    expect(out.parent.product_id).toBe(1);
    expect(out.moved_skus.map((s) => s.sku)).toEqual(['AKKERM-INULIN-C3']);
    expect(db.tables.product_skus.every((s) => s.product_id === 1)).toBe(true);

    // ESTOQUE inteiro foi junto: 40 (bin) + 100 (caixa) + 7 (a organizar)
    expect(out.moved_qty).toBe(147);
    expect(db.tables.stock_bins[0].product_id).toBe(1);
    expect(db.tables.stock_boxes[0].product_id).toBe(1);
    expect(db.tables.stock_unplaced.find((u) => u.product_id === 1).qty).toBe(7);
    expect(db.tables.stock_unplaced.find((u) => u.product_id === 2).qty).toBe(0);
    // Separadas seguem a garrafa
    expect(db.tables.stock_issues[0].product_id).toBe(1);

    // fantasma RETIRADO, nunca apagado
    expect(out.retired_product_id).toBe(2);
    const ghost = db.tables.products.find((p) => p.id === 2);
    expect(ghost).toBeTruthy();
    expect(ghost.merged_into_product_id).toBe(1);
  });

  test('o total do armazém não muda: cada peça é um par (−origem, +destino)', async () => {
    const db = seedAkkerm();
    const { repo } = repoOf(db);
    await repo.merge({ from_product_id: 2, into_product_id: 1 });
    const sum = db.tables.stock_movements.reduce((n, m) => n + Number(m.qty), 0);
    expect(sum).toBe(0);                                   // nada foi criado nem sumiu
    expect(db.tables.stock_movements.length).toBe(6);      // 3 peças × 2 movimentos
    expect(db.tables.stock_movements.every((m) => m.source === 'sku_merge')).toBe(true);
  });

  test('idempotente: reenviar o mesmo merge não move estoque de novo', async () => {
    const db = seedAkkerm();
    const { repo } = repoOf(db);
    const a = await repo.merge({ from_product_id: 2, into_product_id: 1 });
    const b = await repo.merge({ from_product_id: 2, into_product_id: 1 });
    expect(a.moved_qty).toBe(147);
    expect(b.moved_qty).toBe(0);                    // já tinha ido
    expect(b.already_retired).toBe(true);
    expect(db.tables.stock_movements.length).toBe(6);
    expect(db.tables.stock_unplaced.find((u) => u.product_id === 1).qty).toBe(7);  // não dobrou
  });

  test('merge em cima de um fantasma sobe pra raiz (A→B, C→B vira C→A)', async () => {
    const db = seedAkkerm();
    db.tables.products.push({ id: 3, canonical_name: 'AKKERM 500', nickname: null,
      merged_into_product_id: null });
    const { repo } = repoOf(db);
    await repo.merge({ from_product_id: 2, into_product_id: 1 });
    const out = await repo.merge({ from_product_id: 3, into_product_id: 2 });   // pai já absorvido
    expect(out.parent.product_id).toBe(1);          // resolveu pra raiz
    expect(db.tables.products.find((p) => p.id === 3).merged_into_product_id).toBe(1);
  });

  test('produto igual a si mesmo → erro (400 no router)', async () => {
    const { repo } = repoOf(seedAkkerm());
    await expect(repo.merge({ from_product_id: 1, into_product_id: 1 }))
      .rejects.toThrow(/iguais/);
  });
});

describe('unmerge: reversível', () => {
  test('devolve o produto ao hub e os SKUs daquele merge voltam', async () => {
    const db = seedAkkerm();
    const { repo } = repoOf(db);
    const m = await repo.merge({ from_product_id: 2, into_product_id: 1 });
    // o router é quem grava o audit com sku_ids; aqui simulamos esse rastro
    db.tables.audit_log.push({ id: 1, action: 'warehouse.family_merge', target_id: 1,
      after_data: { from_product_id: 2, sku_ids: m.moved_skus.map((s) => s.id) } });

    const out = await repo.unmerge({ product_id: 2 });
    expect(out.was_merged_into).toBe(1);
    expect(out.returned_skus.map((s) => s.sku)).toEqual(['AKKERM-INULIN-C3']);
    expect(db.tables.products.find((p) => p.id === 2).merged_into_product_id).toBeNull();
    expect(db.tables.product_skus.find((s) => s.id === 11).product_id).toBe(2);
    // estoque NÃO volta sozinho: as garrafas estão fisicamente com o pai
    expect(out.moved_qty_back).toBe(0);
    expect(db.tables.stock_bins[0].product_id).toBe(1);
  });

  test('produto que não está absorvido → erro', async () => {
    const { repo } = repoOf(seedAkkerm());
    await expect(repo.unmerge({ product_id: 1 })).rejects.toThrow(/não está absorvido/);
  });
});

describe('forProduct: família com base, filhos e absorvidos', () => {
  test('base é a avulsa; children são os casepacks', async () => {
    const db = seedAkkerm();
    const { repo } = repoOf(db);
    await repo.merge({ from_product_id: 2, into_product_id: 1 });
    const fam = await repo.forProduct(1, 147);
    expect(fam.base.sku).toBe('AKKERM-INULIN');
    expect(fam.sku_count).toBe(2);
    expect(fam.children.map((c) => c.sku)).toEqual(['AKKERM-INULIN-C3']);
    // pacotes derivados: floor(147 ÷ 3)
    expect(fam.children[0].derived_packs).toBe(49);
    expect(fam.absorbed.map((a) => a.product_id)).toEqual([2]);
  });

  test('família SÓ com kit ainda escolhe uma base (Apple Cider Vinegar do print)', async () => {
    const db = makeDb({
      products: [{ id: 5, canonical_name: 'Apple Cider Vinegar', merged_into_product_id: null }],
      product_skus: [{ id: 20, product_id: 5, sku: 'ACV-X4', channel: 'veeqo',
        units_per_pack: 4, is_base: false }],
    });
    const { repo } = repoOf(db);
    const fam = await repo.forProduct(5, 100);
    expect(fam.base.sku).toBe('ACV-X4');
    expect(fam.base.units_per_pack).toBe(4);        // marca que não tem avulsa
  });

  test('is_base marcado por humano ganha da dedução', async () => {
    const db = makeDb({
      products: [{ id: 6, canonical_name: 'Beet Root 2000mg', merged_into_product_id: null }],
      product_skus: [
        { id: 30, product_id: 6, sku: 'BEET-2000', channel: 'veeqo', units_per_pack: 1, is_base: false },
        { id: 31, product_id: 6, sku: 'BEET-ALT', channel: 'veeqo', units_per_pack: 1, is_base: true },
      ],
    });
    const { repo } = repoOf(db);
    const fam = await repo.forProduct(6, 10);
    expect(fam.base.sku).toBe('BEET-ALT');
  });
});

describe('sugestões: agrupa o que é a mesma garrafa, nunca junta sozinho', () => {
  // apelido default = o próprio nome (é o que o service faz quando nickname é
  // null). Um apelido fixo e repetido no fixture agruparia produtos por acidente.
  const row = (over) => {
    const base = { product_id: 1, name: 'X', base_sku: null, skus: [], total: 0,
      veeqo: null, retired: false };
    const r = Object.assign(base, over);
    if (!r.nickname) r.nickname = r.name;
    return r;
  };

  test('BEET-2000 e BEET-2000-C3 e "Beet Root 2000mg - C4" caem no mesmo grupo', () => {
    const rows = [
      row({ product_id: 1, name: 'Beet Root 2000mg', base_sku: 'BEET-2000', total: 120,
        skus: [{ sku: 'BEET-2000', channel: 'veeqo', units_per_pack: 1 }] }),
      row({ product_id: 2, name: 'Beet Root 2000mg C3', base_sku: 'BEET-2000-C3',
        skus: [{ sku: 'BEET-2000-C3', channel: 'veeqo', units_per_pack: 3 }] }),
      row({ product_id: 3, name: 'Beet Root 2000mg - C4', base_sku: 'BEET-2000-C4',
        skus: [{ sku: 'BEET-2000-C4', channel: 'veeqo', units_per_pack: 4 }] }),
    ];
    const { groups, counts } = suggest(rows, {});
    expect(groups.length).toBe(1);
    expect(groups[0].members.map((m) => m.product_id).sort()).toEqual([1, 2, 3]);
    // pai = a avulsa, que é quem tem units_per_pack 1 e o estoque
    expect(groups[0].suggested_parent.product_id).toBe(1);
    expect(groups[0].confidence).toBe('alta');
    expect(groups[0].reason).toMatch(/casepack/);
    expect(counts.groups).toBe(1);
    expect(counts.products).toBe(3);
  });

  test('AKKERM-INULIN duplicado agrupa pelo mesmo SKU base', () => {
    const rows = [
      row({ product_id: 1, name: 'AKKERM-INULIN', base_sku: 'AKKERM-INULIN', total: 50,
        skus: [{ sku: 'AKKERM-INULIN', channel: 'veeqo', units_per_pack: 1 }] }),
      row({ product_id: 2, name: 'AKKERM-INULIN', base_sku: 'AKKERM-INULIN-C3',
        skus: [{ sku: 'AKKERM-INULIN-C3', channel: 'veeqo', units_per_pack: 3 }] }),
    ];
    const { groups } = suggest(rows, {});
    expect(groups.length).toBe(1);
    expect(groups[0].suggested_parent.product_id).toBe(1);
  });

  test('"Apple Cider Vinegar" só com kit agrupa com a avulsa pelo nome', () => {
    const rows = [
      row({ product_id: 1, name: 'Apple Cider Vinegar', base_sku: 'ACV', total: 30,
        skus: [{ sku: 'ACV', channel: 'veeqo', units_per_pack: 1 }] }),
      row({ product_id: 2, name: 'Apple Cider Vinegar x4 kit', base_sku: 'ACV-KIT4',
        skus: [{ sku: 'ACV-KIT4', channel: 'veeqo', units_per_pack: 4 }] }),
    ];
    const { groups } = suggest(rows, {});
    expect(groups.length).toBe(1);
    expect(groups[0].members.length).toBe(2);
    expect(groups[0].suggested_parent.product_id).toBe(1);
    expect(groups[0].confidence).toBe('média');
  });

  test('mesmo UPC é o sinal mais forte: confiança alta', () => {
    const rows = [
      row({ product_id: 1, name: 'Nada a ver A', base_sku: 'AAA',
        skus: [{ sku: 'AAA', channel: 'veeqo', units_per_pack: 1, barcode: '812345678901' }] }),
      row({ product_id: 2, name: 'Nada a ver B', base_sku: 'BBB',
        skus: [{ sku: 'BBB', channel: 'veeqo', units_per_pack: 1, barcode: '812345678901' }] }),
    ];
    const { groups } = suggest(rows, {});
    expect(groups.length).toBe(1);
    expect(groups[0].confidence).toBe('alta');
    expect(groups[0].reason).toMatch(/código de barras/);
  });

  test('DOSE DIFERENTE NUNCA agrupa (Berberine 1000 vs 6000)', () => {
    const rows = [
      row({ product_id: 1, name: 'Berberine 1000mg', base_sku: 'BERB-1000',
        skus: [{ sku: 'BERB-1000', channel: 'veeqo', units_per_pack: 1 }] }),
      row({ product_id: 2, name: 'Berberine 6000mg', base_sku: 'BERB-6000',
        skus: [{ sku: 'BERB-6000', channel: 'veeqo', units_per_pack: 1 }] }),
    ];
    expect(suggest(rows, {}).groups.length).toBe(0);
  });

  test('produto já absorvido não entra em sugestão nenhuma', () => {
    const rows = [
      row({ product_id: 1, name: 'Beet Root 2000mg', base_sku: 'BEET-2000',
        skus: [{ sku: 'BEET-2000', channel: 'veeqo', units_per_pack: 1 }] }),
      row({ product_id: 2, name: 'Beet Root 2000mg C3', base_sku: 'BEET-2000-C3', retired: true,
        merged_into_product_id: 1,
        skus: [{ sku: 'BEET-2000-C3', channel: 'veeqo', units_per_pack: 3 }] }),
    ];
    expect(suggest(rows, {}).groups.length).toBe(0);
  });

  test('cada produto entra em UM grupo só, e a ordem é estável', () => {
    const rows = [
      row({ product_id: 1, name: 'Beet Root 2000mg', base_sku: 'BEET-2000', total: 5,
        skus: [{ sku: 'BEET-2000', channel: 'veeqo', units_per_pack: 1, barcode: '111' }] }),
      row({ product_id: 2, name: 'Beet Root 2000mg C3', base_sku: 'BEET-2000-C3',
        skus: [{ sku: 'BEET-2000-C3', channel: 'veeqo', units_per_pack: 3, barcode: '111' }] }),
    ];
    const a = suggest(rows, {}); const b = suggest(rows, {});
    expect(a.groups.length).toBe(1);
    expect(JSON.stringify(a.groups)).toBe(JSON.stringify(b.groups));
  });

  test('normalização: pacote sai, dose fica', () => {
    expect(normName('Beet Root 2000mg - C4')).toBe('beet root 2000mg');
    expect(normName('Apple Cider Vinegar x4 kit')).toBe('apple cider vinegar');
    expect(normName('Berberine 1000mg')).not.toBe(normName('Berberine 6000mg'));
    expect(packOf('BEET-2000-C3')).toBe(3);
    expect(packOf('Apple Cider Vinegar x4 kit')).toBe(4);
    expect(packOf('BEET-2000')).toBeNull();
    expect(skuRoot('BEET-2000-C3')).toBe('BEET-2000');
    expect(skuRoot('BEET-2000')).toBe('BEET-2000');
  });
});
