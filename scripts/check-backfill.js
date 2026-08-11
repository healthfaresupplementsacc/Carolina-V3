'use strict';
// Conferência pós-backfill Veeqo (read-only).
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const sum = (await p.query(`SELECT status, COUNT(*)::int n, COALESCE(SUM(qty),0)::int units,
    MIN(order_date) f, MAX(order_date) t FROM v3.pnp_order_lines GROUP BY status ORDER BY status`)).rows;
  const unm = (await p.query('SELECT COUNT(*)::int n FROM v3.pnp_order_lines WHERE product_id IS NULL')).rows[0].n;
  const mov = (await p.query('SELECT COUNT(*)::int n FROM v3.stock_movements')).rows[0].n;
  const sk = (await p.query('SELECT COUNT(*)::int total, COUNT(confirmed_at)::int confirmed FROM v3.product_skus')).rows[0];
  for (const s of sum) console.log(`${s.status}: ${s.n} linhas / ${s.units} un (${String(s.f).slice(0,10)} → ${String(s.t).slice(0,10)})`);
  console.log(`unmapped: ${unm} | stock_movements: ${mov} (tem que ser 0) | skus: ${sk.total} (confirmados: ${sk.confirmed})`);
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
