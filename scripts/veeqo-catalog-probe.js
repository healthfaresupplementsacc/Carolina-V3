'use strict';
/* Probe do catálogo Veeqo (Bruno 07-09): quais produtos + SKUs a Veeqo tem?
   Read-only. Roda via: railway run --service ProductionLineService node scripts/veeqo-catalog-probe.js
   Chave via env VEEQO_API_KEY (nunca logada). */
const KEY = process.env.VEEQO_API_KEY;
const BASE = process.env.VEEQO_API_BASE || 'https://api.veeqo.com';
if (!KEY) { console.error('sem VEEQO_API_KEY'); process.exit(1); }

async function get(path) {
  const r = await fetch(BASE + path, { headers: { 'x-api-key': KEY, accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) { const e = new Error('HTTP ' + r.status + ' em ' + path.split('?')[0]); e.status = r.status; throw e; }
  return r.json();
}

(async () => {
  // 1) puxa TODOS os produtos, extrai sellables (variantes) com sku
  const sellables = []; // { sku, title, product_title, product_id, sellable_id, upc, active }
  let productCount = 0, page = 1, capped = true;
  for (; page <= 60; page++) {
    let rows;
    try { rows = await get(`/products?page=${page}&page_size=100`); } catch (e) { console.error('erro pág', page, e.message); break; }
    const arr = Array.isArray(rows) ? rows : (rows.products || []);
    if (!arr.length) { capped = false; break; }
    productCount += arr.length;
    for (const p of arr) {
      const ss = p.sellables || p.variants || [];
      if (!ss.length) {
        sellables.push({ sku: p.sku_code || '', title: p.title || p.name || '', product_title: p.title || '', product_id: p.id, sellable_id: null, upc: p.upc_code || '', active: p.active !== false });
      }
      for (const s of ss) {
        sellables.push({
          sku: s.sku_code || '', title: s.title || s.full_title || '', product_title: p.title || p.name || s.product_title || '',
          product_id: p.id, sellable_id: s.id, upc: s.upc_code || s.upc || '', active: (s.active !== false) && (p.active !== false),
        });
      }
    }
    if (arr.length < 100) { capped = false; break; }
  }

  const withSku = sellables.filter((s) => s.sku);
  const noSku = sellables.filter((s) => !s.sku);
  const uniqSku = new Map();
  for (const s of withSku) if (!uniqSku.has(s.sku)) uniqSku.set(s.sku, s);

  console.log(`\n════ CATÁLOGO VEEQO ════`);
  console.log(`produtos: ${productCount}${capped ? ' (CAP — pode ter mais)' : ''} · sellables/variantes: ${sellables.length} · com SKU: ${withSku.length} · SKUs únicos: ${uniqSku.size} · sem SKU: ${noSku.length}`);

  // prefixos de SKU (pra ver o padrão, ex HF-)
  const prefix = new Map();
  for (const sku of uniqSku.keys()) {
    const pfx = (sku.match(/^[A-Za-z]+[-_]?/) || ['?'])[0].toUpperCase();
    prefix.set(pfx, (prefix.get(pfx) || 0) + 1);
  }
  console.log('\nprefixos de SKU:');
  [...prefix.entries()].sort((a, b) => b[1] - a[1]).forEach(([p, n]) => console.log(`  ${String(p).padEnd(8)} ${n}`));

  console.log(`\ntodos os SKUs (${uniqSku.size}) — sku  ·  título:`);
  [...uniqSku.values()].sort((a, b) => a.sku.localeCompare(b.sku)).forEach((s) => {
    const name = (s.product_title || s.title || '').split('|')[0].trim().slice(0, 60);
    console.log(`  ${s.sku.padEnd(22)} ${name}${s.active ? '' : '  [inativo]'}`);
  });

  if (noSku.length) {
    console.log(`\n⚠️ ${noSku.length} sellables SEM sku_code (amostra):`);
    noSku.slice(0, 15).forEach((s) => console.log(`  (sem sku)  ${(s.product_title || s.title).slice(0, 60)}`));
  }
  console.log('');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
