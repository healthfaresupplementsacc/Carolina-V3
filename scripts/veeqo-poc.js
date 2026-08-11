'use strict';
// POC Veeqo (Fase ①, Bruno 07-08): puxa os pedidos ENVIADOS (shipped = etiqueta
// impressa) e agrega "quantos pedidos + quantas unidades por suplemento" no dia NY.
// Chave via env VEEQO_API_KEY (nunca logada). Uso: VEEQO_API_KEY=... node scripts/veeqo-poc.js [YYYY-MM-DD]
const KEY = process.env.VEEQO_API_KEY;
const EDT = 'America/New_York';
const BASE = 'https://api.veeqo.com';
const dayArg = process.argv[2] || new Date().toLocaleDateString('en-CA', { timeZone: EDT });
const nyDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: EDT }) : null;

async function fetchPage(status, sinceIso, page) {
  const u = `${BASE}/orders?status=${status}&updated_at_min=${encodeURIComponent(sinceIso)}&page_size=100&page=${page}`;
  const r = await fetch(u, { headers: { 'x-api-key': KEY, accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
  if (r.status === 401) throw new Error('401 — chave recusada');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const total = r.headers.get('x-total-count');
  const j = await r.json();
  return { orders: Array.isArray(j) ? j : (j.orders || []), total };
}

(async () => {
  if (!KEY) { console.error('sem VEEQO_API_KEY'); process.exit(1); }
  // janela: começa 1 dia antes do dia pedido (UTC) e filtra por data NY do shipped_at
  const sinceIso = new Date(Date.parse(dayArg + 'T00:00:00Z') - 30 * 3600 * 1000).toISOString();
  const byProduct = new Map(); const byChannel = new Map();
  let orders = 0, units = 0, scanned = 0;
  for (let page = 1; page <= 40; page++) {
    const { orders: rows } = await fetchPage('shipped', sinceIso, page);
    if (!rows.length) break;
    scanned += rows.length;
    for (const o of rows) {
      if (nyDate(o.shipped_at) !== dayArg) continue;   // só os enviados NO dia (NY)
      orders += 1;
      const ch = (o.channel && (o.channel.name || o.channel.type_code)) || '—';
      byChannel.set(ch, (byChannel.get(ch) || 0) + 1);
      for (const li of (o.line_items || [])) {
        const s = li.sellable || {};
        const key = (s.product_title || s.full_title || li.title || '?') + ' | ' + (s.sku_code || '');
        const q = Number(li.quantity) || 0;
        units += q;
        const cur = byProduct.get(key) || { units: 0, lines: 0 };
        cur.units += q; cur.lines += 1; byProduct.set(key, cur);
      }
    }
    if (rows.length < 100) break;
  }
  console.log(`\n📦 VEEQO — pedidos ENVIADOS (etiqueta impressa) em ${dayArg} (NY)`);
  console.log(`   varridos ${scanned} shipped desde ${sinceIso.slice(0, 10)} · do dia: ${orders} pedidos · ${units} unidades`);
  console.log('\n   por canal:');
  [...byChannel.entries()].sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`     ${c.padEnd(20)} ${n}`));
  console.log('\n   por suplemento (unidades):');
  [...byProduct.entries()].sort((a, b) => b[1].units - a[1].units).forEach(([k, v]) => {
    const [name, sku] = k.split(' | ');
    console.log(`     ${String(v.units).padStart(4)}  ${name}${sku ? '  [' + sku + ']' : ''}`);
  });
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
