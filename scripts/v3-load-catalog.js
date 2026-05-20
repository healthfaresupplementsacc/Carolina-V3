'use strict';
/**
 * HEALTHFARE V3 — FIX B (pós-backfill §2.13) — catálogo completo.
 *
 * A migração §1.3 trouxe só 13 produtos, alguns truncados ("Plant"
 * em vez de "Plant Sterols"). Este script carrega o catálogo real
 * (~64 produtos) e RECONCILIA os truncados.
 *
 * Pra cada produto da LISTA:
 *   - canonical já existe (match exato, normalizado) → merge de
 *     aliases (dedup) + corrige a grafia do canonical
 *   - não existe → INSERT
 *
 * RECONCILIAÇÃO: um produto EXISTENTE que não casa com nenhum
 * canonical da lista, mas cujo nome aparece como ALIAS de um produto
 * da lista (ex.: "Plant" → alias de "Plant Sterols"), é CONSOLIDADO:
 *   - o nome truncado vira alias do canonical correto
 *   - product_batches / production_counts / events são re-apontados
 *     do id antigo pro consolidado
 *   - a row truncada é deletada
 * Tudo auditado em v3.audit_log.
 *
 * MODOS:
 *   (default / --dry-run)  imprime o plano completo. ZERO escrita.
 *   --apply                executa em transação única.
 *
 *   railway run ... node scripts/v3-load-catalog.js              # dry-run
 *   railway run ... node scripts/v3-load-catalog.js --apply
 *
 * NOTA: Silica, injeções e FNSKU NÃO são produtos (insumos/processos)
 * — não estão na lista e não são adicionados.
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

// ── catálogo autoritativo (canonical | aliases) — confirmado pelo Bruno ──
const CATALOG = [
  ['Acetyl L-Carnitine', ['acetyl l-carnitine', 'acetil carnitina', 'alcar', 'l-carnitine', 'carnitine', 'acetil l-carnitina']],
  ['Activated Charcoal', ['charcoal', 'carvao ativado', 'carvao', 'activated charcoal', 'carbon ativado']],
  ['Aged Black Garlic', ['aged black garlic', 'black garlic', 'alho negro', 'alho preto', 'garlic', 'alho']],
  ['Akkermansia', ['akkermansia', 'akkermansia muciniphila']],
  ['Aloe Vera', ['aloe', 'aloe vera', 'babosa', 'gel de aloe']],
  ['Apple Cider Vinegar', ['apple cider vinegar', 'apple cider', 'cider', 'acv vinegar', 'vinagre de maca', 'acv', 'vinagre', 'cider vinegar']],
  ['Banaba Leaf', ['banaba', 'banaba leaf', 'lagerstroemia']],
  ['Beet Root', ['beet root', 'beterraba', 'beet', 'beetroot', 'red beet']],
  ['Benfotiamine', ['benfotiamina', 'benfo', 'benfotiamine']],
  ['Berberine', ['berberina', 'berberine', 'berberine ceylon', 'berberine cinnamon', 'berberin', 'berberine cinnamon ceylon']],
  ['Bilberry', ['bilberry', 'bilbery', 'bilberry extract']],
  ['Bitter Melon', ['bitter melon', 'melao amargo', 'karela', 'bitter melon extract']],
  ['Butchers Broom', ['butchers broom', 'vassoura de acougueiro', 'ruscus', 'butcher broom']],
  ['Cayenne Pepper', ['cayenne', 'pimenta caiena', 'cayenne pepper', 'capsaicina', 'capsaicin']],
  ['Chlorophyll', ['clorofila', 'chlorophyll', 'chlorophyl', 'clorofill']],
  ['Chromium Picolinate', ['chromium', 'cromo', 'picolinato', 'chromium picolinate', 'picolinato de cromo']],
  ['Citrus Bergamot', ['citrus bergamot', 'citrus', 'bergamot', 'bergamota', 'bergamotto']],
  ['D-Aspartic Acid', ['d-aspartic', 'd aspartic', 'aspartic acid', 'acido aspartico', 'daa']],
  ['Devils Claw', ['devils claw', 'garra do diabo', 'harpagophytum', 'devil claw']],
  ['Fadogia Agrestis', ['fadogia', 'fadogia agrestis']],
  ['Feminiva', ['feminiva']],
  ['Fenugreek', ['fenugreco', 'fenugrek', 'fenngreff', 'fenugreek', 'fenugr', 'fenugreek seed', 'methi']],
  ['Folic Acid', ['acido folico', 'folic acid', 'folato', 'folate', 'folic']],
  ['Ginger Root', ['ginger', 'gengibre', 'ginger root', 'gengibre root']],
  ['Ginkgo Biloba', ['ginkgo', 'ginkgo biloba', 'biloba', 'ginko']],
  ['Ginseng Ginkgo', ['ginseng', 'panax ginseng', 'ginseng ginkgo', 'panax ginseng ginkgo', 'ginseng e ginkgo']],
  ['Glutathione', ['glutationa', 'glutation', 'glutathione']],
  ['Graviola', ['graviola', 'soursop', 'graviolla', 'graviol', 'graviola soursop']],
  ['Green Tea', ['green tea', 'cha verde', 'te verde', 'egcg', 'green tea extract']],
  ['Gymnema Sylvestre', ['gymnema', 'gymnema sylvestre', 'gurmar']],
  ['Hawthorn Berry', ['hawthorn', 'hawthorn berry', 'espinheiro', 'cratego', 'crataegus']],
  ['He Shou Wu', ['he shou wu', 'fo-ti', 'fo ti', 'heshouwu', 'poligonum', 'fallopia multiflora']],
  ['Hyaluronic Acid', ['hyaluronic', 'hialuronico', 'acido hialuronico', 'hyaluronic acid']],
  ['L-Glutamine', ['glutamina', 'l-glutamine', 'glutamine', 'l glutamine']],
  ['Licorice Root', ['licorice', 'alcacuz', 'licorice root', 'regaliz', 'glycyrrhiza']],
  ['Lithium Orotate', ['lithium', 'litio', 'litium', 'orotato de litio', 'lithium orotate', 'litio orotato']],
  ['Magnesium', ['magnesio', 'magnesium', 'mag']],
  ['Magnesium Citrate', ['magnesium citrate', 'citrato de magnesio', 'mag citrate', 'citrate', 'citrato']],
  ['Magnesium Glycinate', ['magnesium glycinate', 'glicinato', 'glycinate', 'mag glycinate', 'glycinote', 'glicinate', 'bisglicinato', 'bisglycinate']],
  ['Melatonin', ['melatonina', 'melatonin']],
  ['Mullein Leaf', ['mullein', 'mulein', 'verbasco', 'mullein leaf', 'mullein extract']],
  ['Multi Collagen', ['colageno', 'collagen', 'collagen peptides', 'multi collagen', 'collag']],
  ['Myo Inositol', ['inositol', 'myo-inositol', 'mioinositol', 'myo inositol']],
  ['NAC', ['nac', 'n-acetyl', 'n acetyl', 'n-acetil', 'acetil cisteina', 'cysteine', 'n-acetylcysteine', 'acetyl cysteine']],
  ['NAD', ['nad', 'nad+', 'nmn', 'nicotinamide', 'nad supplement']],
  ['Panax', ['panax ginseng', 'panax', 'pana', 'ginsen', 'ginseng', 'panas']],
  ['Pantothenic Acid', ['pantotenico', 'pantotenic', 'pantothenic', 'b5', 'vit b5', 'vitamina b5', 'acido pantotenico']],
  ['Pine Bark', ['pine bark', 'french maritime', 'casca de pinho', 'pycnogenol', 'pine bark extract']],
  ['Plant Sterols', ['plant sterols', 'plant sterol', 'sterols', 'esterois', 'fitosterois', 'phytosterols', 'plant']],
  ['Potassium Iodide', ['potassium iodide', 'potassium', 'potassio', 'iodide', 'iodeto', 'iodo de potassio', 'potassium iodide 130']],
  ['Psyllium Husk', ['psyllium', 'psyllium husk', 'casca de psyllium', 'psilio', 'ispagula']],
  ['Pygeum', ['pygeum', 'pigeum', 'pygenum', 'pygeum africanum']],
  ['Rhodiola', ['rhodiola', 'rodiola', 'rhodiola rosea']],
  ['Rutin', ['rutin', 'rutim', 'rutina']],
  ['Saw Palmetto', ['saw palmetto', 'palmeto', 'sabal serrulata']],
  ['Skullcap', ['skullcap', 'skull cap', 'escutelaria', 'chinese skullcap']],
  ['Stinging Nettle', ['nettle', 'urtiga', 'stinging nettle', 'nettle leaf', 'nettle root', 'stinging nettle root', 'stinging nettle leaf']],
  ['Tribulus Terrestris', ['tribulus', 'tribulo', 'tribulus terrestris', 'trib']],
  ['Turkesterone', ['turkesterone', 'tongkat ali', 'turk', 'turkersterone', 'eurycoma']],
  ['Valerian Root', ['valerian', 'valeriana', 'valerian root']],
  ['Vitamin B1', ['vitamina b1', 'thiamine', 'tiamina', 'vit b1', 'b1', 'vitamin b1']],
  ['Vitamin B2', ['vitamina b2', 'riboflavin', 'riboflavina', 'vit b2', 'b2', 'vitamin b2']],
  ['White Kidney Bean', ['white kidney bean', 'kidney bean', 'feijao branco', 'kidney', 'white kidney']],
  ['Yohimbine', ['yohimbina', 'yohimbine', 'yohimbine hcl', 'yoimbina', 'iombina']],
].map(([canonical, aliases]) => ({ canonical, aliases }));

/** Normaliza p/ comparação: minúsculo, sem acento, espaços colapsados. */
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/\s+/g, ' ');
}

/** União de aliases, dedup por forma normalizada, preserva a 1ª grafia. */
function mergeAliases(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const a of (list || [])) {
      const t = String(a || '').trim();
      if (!t) continue;
      const n = norm(t);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(t.toLowerCase());
    }
  }
  return out;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = makeV3Pool();
  const client = await pool.connect();
  try {
    console.log(`==== V3 FIX B — catálogo completo (${apply ? 'APPLY' : 'DRY-RUN'}) ====`);
    console.log(`lista autoritativa: ${CATALOG.length} produtos\n`);

    // ── 1. carrega o estado atual ──
    const existing = (await client.query(
      'SELECT id, canonical_name, aliases FROM v3.products ORDER BY id')).rows;
    console.log(`produtos hoje em v3.products: ${existing.length}`);

    // índice: norma → produto da lista (canonical e aliases)
    const listByCanon = new Map();    // norm(canonical) → catalog entry
    const listByAlias = new Map();    // norm(alias) → [catalog entries]
    for (const p of CATALOG) {
      listByCanon.set(norm(p.canonical), p);
      for (const a of [p.canonical, ...p.aliases]) {
        const n = norm(a);
        if (!listByAlias.has(n)) listByAlias.set(n, []);
        if (!listByAlias.get(n).includes(p)) listByAlias.get(n).push(p);
      }
    }

    // ── 2. classifica cada produto existente ──
    const matches = [];        // { existing, list }       — merge
    const consolidations = []; // { existing, list }       — re-aponta + deleta
    const ambiguous = [];      // { existing, lists }
    const orphans = [];        // existing — não casa com nada
    for (const e of existing) {
      const ne = norm(e.canonical_name);
      if (listByCanon.has(ne)) {
        matches.push({ existing: e, list: listByCanon.get(ne) });
        continue;
      }
      const viaAlias = listByAlias.get(ne) || [];
      if (viaAlias.length === 1) {
        consolidations.push({ existing: e, list: viaAlias[0] });
      } else if (viaAlias.length > 1) {
        ambiguous.push({ existing: e, lists: viaAlias });
      } else {
        orphans.push(e);
      }
    }

    // produtos da lista que ainda não têm row (nem match nem alvo de
    // consolidação que JÁ exista) → INSERT
    const coveredCanon = new Set(matches.map((m) => norm(m.list.canonical)));
    const inserts = CATALOG.filter((p) => !coveredCanon.has(norm(p.canonical)));

    // ── 3. conta o impacto de cada consolidação ──
    for (const c of consolidations) {
      const id = c.existing.id;
      const [b, ct] = await Promise.all([
        client.query('SELECT COUNT(*) n FROM v3.product_batches WHERE product_id = $1', [id]),
        client.query('SELECT COUNT(*) n FROM v3.production_counts WHERE product_id = $1', [id]),
      ]);
      const ev = await client.query(
        `SELECT COUNT(*) n FROM v3.events
         WHERE product_batch_id IN (SELECT id FROM v3.product_batches WHERE product_id = $1)`, [id]);
      c.impact = { batches: +b.rows[0].n, counts: +ct.rows[0].n, events: +ev.rows[0].n };
    }

    // ── 4. relatório do plano ──
    console.log(`\n── MATCHES (merge de aliases): ${matches.length} ──`);
    for (const m of matches) {
      const merged = mergeAliases(m.list.aliases, m.existing.aliases, [m.existing.canonical_name]);
      const novos = merged.length - (m.existing.aliases || []).length;
      const recase = m.existing.canonical_name !== m.list.canonical ? ` [grafia: "${m.existing.canonical_name}"→"${m.list.canonical}"]` : '';
      console.log(`  = "${m.list.canonical}" (id ${m.existing.id}) +${novos} alias${recase}`);
    }

    console.log(`\n── CONSOLIDAÇÕES (truncado → canonical): ${consolidations.length} ──`);
    for (const c of consolidations) {
      const i = c.impact;
      console.log(`  ⇒ "${c.existing.canonical_name}" (id ${c.existing.id}) → "${c.list.canonical}"`
        + ` | re-aponta ${i.batches} batch, ${i.events} event, ${i.counts} count`);
    }

    console.log(`\n── INSERTS (novos): ${inserts.length} ──`);
    for (const p of inserts) console.log(`  + "${p.canonical}" (${p.aliases.length} aliases)`);

    if (ambiguous.length) {
      console.log(`\n── ⚠️ AMBÍGUOS (precisam decisão do Bruno): ${ambiguous.length} ──`);
      for (const a of ambiguous) {
        console.log(`  ? "${a.existing.canonical_name}" (id ${a.existing.id}) casa com: `
          + a.lists.map((l) => l.canonical).join(' | '));
      }
    }
    if (orphans.length) {
      console.log(`\n── ⚠️ ÓRFÃOS (existem mas não estão na lista — mantidos): ${orphans.length} ──`);
      for (const o of orphans) console.log(`  ! "${o.canonical_name}" (id ${o.id}) — revisar manualmente`);
    }

    const finalCount = matches.length + inserts.length + orphans.length;
    console.log(`\n── RESUMO ──`);
    console.log(`  matches:        ${matches.length}`);
    console.log(`  consolidações:  ${consolidations.length}  (rows truncadas removidas)`);
    console.log(`  inserts:        ${inserts.length}`);
    console.log(`  ambíguos:       ${ambiguous.length}  (NÃO tocados)`);
    console.log(`  órfãos:         ${orphans.length}  (NÃO tocados)`);
    console.log(`  catálogo final estimado: ${finalCount} produtos`);

    if (!apply) {
      console.log('\nDRY-RUN — nada escrito. Revise o plano e rode com --apply.');
      return;
    }

    // ── 5. APPLY — transação única ──
    console.log('\n==== APPLY ====');
    await client.query('BEGIN');
    const audit = async (action, targetId, before, after) => {
      await client.query(
        `INSERT INTO v3.audit_log (actor_type, action, target_type, target_id, before_data, after_data)
         VALUES ('system', $1, 'product', $2, $3::jsonb, $4::jsonb)`,
        [action, targetId, JSON.stringify(before || {}), JSON.stringify(after || {})]);
    };

    // 5a. matches → merge aliases + corrige grafia
    for (const m of matches) {
      const merged = mergeAliases(m.list.aliases, m.existing.aliases, [m.existing.canonical_name]);
      await client.query(
        'UPDATE v3.products SET canonical_name = $1, aliases = $2, active = true WHERE id = $3',
        [m.list.canonical, merged, m.existing.id]);
      await audit('fix_b.product_merged', m.existing.id,
        { canonical_name: m.existing.canonical_name, aliases: m.existing.aliases },
        { canonical_name: m.list.canonical, aliases: merged });
    }

    // 5b. inserts → novos canonicals
    const idByCanon = new Map();
    for (const m of matches) idByCanon.set(norm(m.list.canonical), m.existing.id);
    for (const p of inserts) {
      const r = await client.query(
        'INSERT INTO v3.products (canonical_name, aliases, active) VALUES ($1, $2, true) RETURNING id',
        [p.canonical, mergeAliases(p.aliases)]);
      idByCanon.set(norm(p.canonical), r.rows[0].id);
      await audit('fix_b.product_inserted', r.rows[0].id, {}, { canonical_name: p.canonical });
    }

    // 5c. consolidações → re-aponta tudo do id truncado pro canonical, deleta a row
    for (const c of consolidations) {
      const targetId = idByCanon.get(norm(c.list.canonical));
      if (!targetId) throw new Error(`consolidação sem alvo: ${c.list.canonical}`);
      const oldId = c.existing.id;

      // re-aponta batches (trata conflito de UNIQUE(product_id, batch_number))
      const oldBatches = (await client.query(
        'SELECT id, batch_number FROM v3.product_batches WHERE product_id = $1', [oldId])).rows;
      for (const ob of oldBatches) {
        const clash = await client.query(
          'SELECT id FROM v3.product_batches WHERE product_id = $1 AND batch_number = $2',
          [targetId, ob.batch_number]);
        if (clash.rows.length) {
          // batch já existe no alvo → move events/counts pro batch do alvo e some com o antigo
          const tgtBatch = clash.rows[0].id;
          await client.query('UPDATE v3.events SET product_batch_id = $1 WHERE product_batch_id = $2', [tgtBatch, ob.id]);
          await client.query('UPDATE v3.production_counts SET product_batch_id = $1 WHERE product_batch_id = $2', [tgtBatch, ob.id]);
          await client.query('DELETE FROM v3.product_batches WHERE id = $1', [ob.id]);
        } else {
          await client.query('UPDATE v3.product_batches SET product_id = $1 WHERE id = $2', [targetId, ob.id]);
        }
      }
      // re-aponta production_counts (product_id)
      await client.query('UPDATE v3.production_counts SET product_id = $1 WHERE product_id = $2', [targetId, oldId]);

      // o nome truncado vira alias do canonical
      const tgt = (await client.query('SELECT canonical_name, aliases FROM v3.products WHERE id = $1', [targetId])).rows[0];
      const merged = mergeAliases(tgt.aliases, [c.existing.canonical_name], c.existing.aliases);
      await client.query('UPDATE v3.products SET aliases = $1 WHERE id = $2', [merged, targetId]);

      // deleta a row truncada
      await client.query('DELETE FROM v3.products WHERE id = $1', [oldId]);
      await audit('fix_b.product_consolidated', oldId,
        { canonical_name: c.existing.canonical_name, aliases: c.existing.aliases },
        { consolidated_into_id: targetId, consolidated_into: c.list.canonical, impact: c.impact });
    }

    await client.query('COMMIT');
    const after = (await client.query('SELECT COUNT(*) n FROM v3.products')).rows[0].n;
    console.log(`OK — merges: ${matches.length}, inserts: ${inserts.length}, `
      + `consolidações: ${consolidations.length}. v3.products agora: ${after} produtos.`);
  } catch (e) {
    if (apply) { try { await client.query('ROLLBACK'); } catch (_) { /* */ } }
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main();
