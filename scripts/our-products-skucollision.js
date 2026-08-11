'use strict';
/* Bruno 07-10: "oq vc acha q ta duplicado então?" — teste DEFINITIVO por SKU.
   Um SKU de marketplace pertence a UM produto só. Se o MESMO SKU (ou a mesma
   base, tirando o sufixo de casepack -C2/-C3) aparece em 2 linhas diferentes,
   é duplicata real (fora pai/filho de casepack, que é legítimo). Read-only.
   railway run --service ProductionLineService node scripts/our-products-skucollision.js */
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const up = (s) => String(s || '').trim().toUpperCase();
const isCode = (a) => /^[A-Z]{2,}[-0-9]/i.test(up(a)) && /\d/.test(a);
const baseSku = (s) => up(s).replace(/[-\s]*(C\d+|WFS|FBA|R)\b/g, '').replace(/[-_\s]+$/, '').replace(/[-_\s]+/g, '-');

(async () => {
  const prods = (await p.query('SELECT id, canonical_name, aliases, active, parent_product_id, variant_label FROM v3.products ORDER BY id')).rows;
  const byId = new Map(prods.map((r) => [r.id, r]));
  const relatedByCasepack = (a, b) => a.parent_product_id === b.id || b.parent_product_id === a.id
    || (a.parent_product_id && a.parent_product_id === b.parent_product_id);

  // 1) COLISÃO DE SKU EXATO (o sinal mais forte)
  const exact = new Map(); // SKU -> Set(ids)
  for (const r of prods) for (const a of (r.aliases || [])) if (isCode(a)) {
    const k = up(a); if (!exact.has(k)) exact.set(k, new Set()); exact.get(k).add(r.id);
  }
  const exactHits = [...exact.entries()].filter(([, ids]) => ids.size > 1);

  console.log('\n════ 1) MESMO SKU EXATO em 2+ produtos (duplicata forte) ════');
  if (!exactHits.length) console.log('  nenhum.');
  for (const [sku, ids] of exactHits.sort((a, b) => a[0].localeCompare(b[0]))) {
    const rows = [...ids].map((i) => byId.get(i));
    const cp = rows.length === 2 && relatedByCasepack(rows[0], rows[1]) ? '  (pai/filho casepack — ok)' : '  ⚠️';
    console.log(`  ${sku.padEnd(22)}${cp}`);
    rows.forEach((r) => console.log(`      #${String(r.id).padEnd(4)} ${r.canonical_name}${r.variant_label ? ' [' + r.variant_label + ']' : ''}${r.active ? '' : ' INATIVO'}`));
  }

  // 2) MESMA BASE de SKU (mesmo produto, sufixo casepack/WFS/FBA à parte) em 2+ linhas NÃO pai/filho
  const base = new Map(); // baseSku -> Set(ids)
  for (const r of prods) for (const a of (r.aliases || [])) if (isCode(a)) {
    const k = baseSku(a); if (!k) continue; if (!base.has(k)) base.set(k, new Set()); base.get(k).add(r.id);
  }
  const baseHits = [];
  for (const [b, ids] of base) {
    if (ids.size < 2) continue;
    const rows = [...ids].map((i) => byId.get(i));
    // ignora se TODOS são pai/filho entre si (casepack legítimo)
    let allRelated = true;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) if (!relatedByCasepack(rows[i], rows[j])) allRelated = false;
    if (!allRelated) baseHits.push([b, rows]);
  }
  console.log('\n════ 2) MESMA BASE de SKU em linhas NÃO pai/filho (suspeito) ════');
  if (!baseHits.length) console.log('  nenhum.');
  for (const [b, rows] of baseHits.sort((a, b2) => a[0].localeCompare(b2[0]))) {
    console.log(`  base ${b}`);
    rows.forEach((r) => console.log(`      #${String(r.id).padEnd(4)} ${r.canonical_name}${r.variant_label ? ' [' + r.variant_label + ']' : ''}${r.active ? '' : ' INATIVO'}`));
  }
  console.log('');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
