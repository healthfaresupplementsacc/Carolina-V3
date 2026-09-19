'use strict';
/**
 * Importa o histórico de estoque da Veeqo (últimos N dias) pro espelho v3.veeqo_stock_history
 * e aplica no nosso livro o que é aplicável (regras em veeqo-history-sync.js).
 * Bruno 09-16: "atualiza o sistema com as entradas do último mês, adiciona as anotações e os motivos".
 *   railway run node scripts/veeqo-history-backfill.js [--days=30] [--dry]
 * Por SKU base (filtro sellable_id do feed): 1 pedido por produto, sem o ruído de kits/pedidos.
 */
const { Pool } = require('pg');
const { veeqo } = require('../src/v3/services/veeqo-api');
const { StockService } = require('../src/v3/services/StockService');
const { VeeqoHistorySync } = require('../src/v3/services/veeqo-history-sync');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith('--' + k + '=')); return m ? m.split('=')[1] : d; };
(async () => {
  const days = Number(arg('days', 30)); const dry = process.argv.includes('--dry');
  const since = new Date(Date.now() - days * 86400000).toISOString();
  // sellable_id por SKU (o feed filtra por sellable_id; o catálogo da Veeqo traz o id)
  const bySku = new Map();
  for (let page = 1; page <= 60; page++) {
    const rows = await veeqo.getProductsPage({ page, pageSize: 100, timeoutMs: 60000 });
    if (!rows.length) break;
    for (const pd of rows) for (const s of (pd.sellables || [])) if (s.sku_code) bySku.set(String(s.sku_code).trim().toUpperCase(), s.id);
    if (rows.length < 100) break;
  }
  const base = (await p.query(`SELECT ps.sku, ps.product_id, pr.canonical_name FROM v3.product_skus ps JOIN v3.products pr ON pr.id = ps.product_id
                                WHERE pr.active AND pr.merged_into_product_id IS NULL AND COALESCE(pr.kind,'bottle') = 'bottle'
                                  AND COALESCE(ps.units_per_pack,1) = 1 AND ps.sku NOT ILIKE '%-WFS' AND COALESCE(ps.veeqo_type,'') <> 'kit' AND ps.channel = 'veeqo'`)).rows;
  const stock = dry ? { async adjust(x) { return { movement: null, applied: x.qty, duplicate: false, dry: true }; } } : new StockService({ db: p });
  const sync = new VeeqoHistorySync({ db: p, veeqo, stock, log: (...a) => console.log('  ', ...a) });
  const tot = { products: 0, no_sellable: 0, seen: 0, mirrored: 0, applied: 0, duplicate: 0, skipped: 0, errors: 0 };
  for (const b of base) {
    const sid = bySku.get(String(b.sku).toUpperCase());
    if (!sid) { tot.no_sellable++; continue; }
    tot.products++;
    const r = await sync.backfillSellable(sid, since);
    for (const k of ['seen', 'mirrored', 'applied', 'duplicate', 'skipped', 'errors']) tot[k] += r[k] || 0;
    if (r.mirrored) console.log(`${b.canonical_name} (${b.sku}): ${r.mirrored} novas, ${r.applied} aplicadas`);
  }
  // cursor do incremental = maior id já visto (evita re-ler o passado no primeiro tick)
  const mx = (await p.query(`SELECT COALESCE(MAX(id),0)::bigint AS m FROM v3.veeqo_stock_history`)).rows[0].m;
  if (!dry) await p.query(`INSERT INTO v3.settings (key, value, description) VALUES ('veeqo_history.cursor', $1::jsonb, 'último id do feed /stock_histories da Veeqo já espelhado')
                           ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`, [JSON.stringify({ last_id: Number(mx), at: new Date().toISOString(), backfill_days: days })]);
  console.log(JSON.stringify({ dry, since, ...tot, cursor: Number(mx) }));
  await p.end();
})().catch((e) => { console.error(e); process.exit(1); });
