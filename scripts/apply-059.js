'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '059_pnp_order_lines.sql'), 'utf8');
  await pool.query(sql);
  const cols = (await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='pnp_order_lines' ORDER BY ordinal_position")).rows.map((r) => r.column_name);
  console.log('v3.pnp_order_lines:', cols.length ? cols.join(', ') : 'FALTANDO!');
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
