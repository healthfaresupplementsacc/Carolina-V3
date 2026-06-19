'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '042_unit_orders.sql'), 'utf8'));
  const r = await pool.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='production_counts_unit_check'");
  console.log('unit check: ' + r.rows[0].d);
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
