'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '045_ems_enrich.sql'), 'utf8'));
  const r = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='product_batches' AND column_name IN ('target_bottles','units_per_bottle')");
  const t = await pool.query("SELECT to_regclass('v3.ems_cleaning_log') AS tbl");
  console.log('cols: ' + r.rows.map((x) => x.column_name).join(', ') + ' | cleaning table: ' + t.rows[0].tbl);
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
