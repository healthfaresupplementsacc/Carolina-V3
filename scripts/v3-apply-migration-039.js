'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '039_menu_reorg_pp.sql'), 'utf8'));
  const r = await pool.query("SELECT slug, requires_order_count AS roc, counts_as_pp AS pp, active FROM v3.activity_types WHERE slug IN ('separating','weighing','orders','marketplace_prep','clinic_shipment','order_printing','labeling','packaging') ORDER BY slug");
  r.rows.forEach((x) => console.log('  ' + x.slug + ' active=' + x.active + ' roc=' + x.roc + ' pp=' + x.pp));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
