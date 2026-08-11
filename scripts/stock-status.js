'use strict';
// Status do Centro de Estoque (read-only) — pra doc/conferência.
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = async (sql) => { try { return (await p.query(sql)).rows; } catch (e) { return [{ err: e.message.slice(0, 60) }]; } };
(async () => {
  console.log('lines   :', JSON.stringify(await q(
    "SELECT source, status, COUNT(*)::int n FROM v3.pnp_order_lines GROUP BY 1,2 ORDER BY 1,2")));
  console.log('physical:', JSON.stringify(await q(
    'SELECT (SELECT COUNT(*)::int FROM v3.stock_bins) bins, (SELECT COUNT(*)::int FROM v3.stock_boxes) boxes, (SELECT COUNT(*)::int FROM v3.stock_movements) movements, (SELECT COUNT(*)::int FROM v3.stock_issues) issues')));
  console.log('skus    :', JSON.stringify(await q(
    "SELECT channel, COUNT(*)::int n, COUNT(confirmed_at)::int confirmed FROM v3.product_skus GROUP BY 1 ORDER BY 1")));
  console.log('catalog :', JSON.stringify(await q(
    "SELECT COUNT(*)::int n, COUNT(product_id)::int matched, COUNT(*) FILTER (WHERE status='hold')::int hold, COUNT(expiry_date)::int with_expiry FROM v3.product_catalog")));
  console.log('coas    :', JSON.stringify(await q('SELECT COUNT(*)::int n FROM v3.raw_material_coas')));
  console.log('setup   :', JSON.stringify(await q(
    'SELECT COUNT(*)::int products, COUNT(nickname)::int with_nick, COUNT(bottle_color)::int with_color FROM v3.products')));
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
