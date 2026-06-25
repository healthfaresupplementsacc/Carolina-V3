'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '047_pp_no_finish_count.sql'), 'utf8'));
  const r = await pool.query("SELECT slug, requires_order_count AS roc, counts_as_pp AS pp FROM v3.activity_types WHERE slug IN ('order_printing','labeling','packaging','packaging_other','marketplace_prep','clinic_shipment') ORDER BY slug");
  console.log('requires_order_count depois da 047:');
  r.rows.forEach((x) => console.log(`  ${x.slug} | roc=${x.roc} | counts_as_pp=${x.pp}`));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
