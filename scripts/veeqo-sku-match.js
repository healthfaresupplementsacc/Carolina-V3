'use strict';
/* Veeqo SKUs × nosso catálogo (Bruno 07-09): os SKUs da Veeqo batem com o que
   temos? Nosso v3.products NÃO tem coluna de SKU — os SKUs (quando existem) vivem
   dentro do array `aliases`. Então: pra cada SKU único da Veeqo, ele aparece em
   algum aliases[]? (exato / por base sem sufixo de canal / por nome). Read-only.
   railway run --service ProductionLineService node scripts/veeqo-sku-match.js */
const { Pool } = require('pg');
const KEY = process.env.VEEQO_API_KEY;
const BASE = process.env.VEEQO_API_BASE || 'https://api.veeqo.com';
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
if (!KEY) { console.error('sem VEEQO_API_KEY'); process.exit(1); }

const up = (s) => String(s || '').trim().toUpperCase();
// base do SKU: tira sufixos de canal/fulfillment (-C2..-C9, -WFS, -FBA e combinações no fim)
const baseSku = (s) => up(s).replace(/[-\s]*(C\d+|WFS|FBA|R)\b/g, '').replace(/[-_\s]+$/,'').replace(/[-_\s]+/g, '-');
// normaliza NOME pra match textual: minúsculo, tira marca/dose/pontuação
const normName = (s) => String(s || '').toLowerCase().split('|')[0]
  .replace(/healthfare|healthfare/g, ' ')
  .replace(/\b\d[\d.,]*\s*(mg|mcg|g|iu|ml|ct|count|caps?|capsules?|tablets?|softgels?|vegan|pills?)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

async function get(path) {
  const r = await fetch(BASE + path, { headers: { 'x-api-key': KEY, accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const isClinic = (sku) => /^HC[-\s]/.test(up(sku)) || up(sku) === '70';
const isNonProduct = (sku, title) => /^(RUBBER|SILIN|SHOPIFY|V7|V\b)/.test(up(sku)) || /waste basket|food pan|syringe|test strip|tip default|clinic services/i.test(title || '');

(async () => {
  // ── nosso catálogo ──
  const prods = (await p.query('SELECT id, canonical_name, aliases, active FROM v3.products')).rows;
  const aliasExact = new Map(); // ALIAS(up) -> product
  const aliasBase = new Map();  // baseSku -> product
  const nameIndex = [];         // { norm, product } pra match por nome
  for (const pr of prods) {
    const names = [pr.canonical_name, ...(pr.aliases || [])];
    for (const a of names) {
      const A = up(a);
      if (!A) continue;
      if (/^[A-Z]{2,}[-0-9]/.test(A) || /\d/.test(A)) { // parece código
        if (!aliasExact.has(A)) aliasExact.set(A, pr);
        const b = baseSku(A); if (b && !aliasBase.has(b)) aliasBase.set(b, pr);
      }
      const nn = normName(a); if (nn && nn.length >= 3) nameIndex.push({ norm: nn, product: pr });
    }
  }

  // ── catálogo Veeqo ──
  const seen = new Map(); // sku -> title
  for (let page = 1; page <= 60; page++) {
    const rows = await get(`/products?page=${page}&page_size=100`);
    const arr = Array.isArray(rows) ? rows : (rows.products || []);
    if (!arr.length) break;
    for (const pd of arr) for (const s of (pd.sellables || [])) {
      const sku = (s.sku_code || '').trim();
      if (sku && !seen.has(sku)) seen.set(sku, pd.title || pd.name || s.product_title || '');
    }
    if (arr.length < 100) break;
  }

  const cats = { exact: [], base: [], name: [], unmatched: [], clinic: [], nonprod: [] };
  for (const [sku, title] of seen) {
    if (isNonProduct(sku, title)) { cats.nonprod.push([sku, title]); continue; }
    if (isClinic(sku)) { cats.clinic.push([sku, title]); continue; }
    const A = up(sku);
    if (aliasExact.has(A)) { cats.exact.push([sku, title, aliasExact.get(A)]); continue; }
    const b = baseSku(sku);
    if (aliasBase.has(b)) { cats.base.push([sku, title, aliasBase.get(b)]); continue; }
    const nn = normName(title);
    const hit = nn && nameIndex.find((x) => x.norm === nn || (x.norm.length >= 5 && (nn.includes(x.norm) || x.norm.includes(nn))));
    if (hit) { cats.name.push([sku, title, hit.product]); continue; }
    cats.unmatched.push([sku, title]);
  }

  const realTotal = cats.exact.length + cats.base.length + cats.name.length + cats.unmatched.length;
  console.log(`\n════ VEEQO SKUs × NOSSO CATÁLOGO ════`);
  console.log(`Veeqo: ${seen.size} SKUs únicos. Nosso: ${prods.length} produtos.`);
  console.log(`\nSKUs de SUPLEMENTO (tirando clínica/embalagem): ${realTotal}`);
  console.log(`  ✅ casam EXATO no aliases:          ${cats.exact.length}`);
  console.log(`  ✅ casam pela BASE (sufixo -C2/-WFS/-FBA difere): ${cats.base.length}`);
  console.log(`  🟡 casam só por NOME (sem o SKU no sistema):       ${cats.name.length}`);
  console.log(`  ❌ NÃO casam com nada (buraco):     ${cats.unmatched.length}`);
  console.log(`\nFora do escopo da linha:`);
  console.log(`  🏥 clínica (HC-…): ${cats.clinic.length}   📦 embalagem/misc: ${cats.nonprod.length}`);

  const show = (arr, withProd) => arr.slice(0, 200).forEach(([sku, title, pr]) =>
    console.log(`  ${sku.padEnd(22)} ${(title || '').split('|')[0].trim().slice(0, 48).padEnd(48)}${withProd && pr ? ' → #' + pr.id + ' ' + pr.canonical_name : ''}`));

  console.log(`\n──── ❌ SKUs de suplemento SEM correspondência (${cats.unmatched.length}) ────`);
  show(cats.unmatched, false);
  console.log(`\n──── 🟡 casaram só por nome (${cats.name.length}) — SKU não está no sistema, confirmar ────`);
  show(cats.name, true);

  // reverso: nossos produtos ATIVOS sem NENHUM SKU Veeqo no aliases
  const veeqoBases = new Set([...seen.keys()].map(baseSku));
  const ourNoSku = prods.filter((pr) => pr.active).filter((pr) => {
    const codes = [pr.canonical_name, ...(pr.aliases || [])].filter((a) => /^[A-Z]{2,}[-0-9]/i.test(up(a)) && /\d/.test(a));
    return !codes.some((c) => veeqoBases.has(baseSku(c)));
  });
  console.log(`\n──── ⬅️ nossos produtos ATIVOS sem SKU Veeqo casável (${ourNoSku.length}) ────`);
  ourNoSku.slice(0, 200).forEach((pr) => console.log(`  #${String(pr.id).padEnd(4)} ${pr.canonical_name}`));
  console.log('');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
