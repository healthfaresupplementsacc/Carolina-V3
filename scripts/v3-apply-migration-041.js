'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '041_pc_product_nullable.sql'), 'utf8'));
  const r = await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema='v3' AND table_name='production_counts' AND column_name='product_id'");
  console.log('product_id nullable: ' + r.rows[0].is_nullable);
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
