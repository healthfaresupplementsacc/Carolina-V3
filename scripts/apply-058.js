'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '058_warehouse_stock.sql'), 'utf8');
  await pool.query(sql);
  for (const t of ['product_skus', 'stock_bins', 'stock_boxes', 'stock_movements', 'stock_thresholds']) {
    const cols = (await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name=$1 ORDER BY ordinal_position", [t])).rows.map((r) => r.column_name);
    console.log('v3.' + t + ':', cols.length ? cols.join(', ') : 'FALTANDO!');
  }
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
