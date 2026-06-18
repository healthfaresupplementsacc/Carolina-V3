'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '034_operator_created_batches.sql'), 'utf8'));
  const r = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='product_batches' AND column_name IN ('origin','created_by_person_id','created_via','reviewed_at','reviewed_by_person_id')");
  console.log('product_batches.origin/created_*/reviewed_* : ' + (r.rowCount === 5 ? 'OK' : 'AUSENTE (' + r.rowCount + '/5)'));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
