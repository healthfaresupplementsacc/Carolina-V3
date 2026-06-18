'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '032_shipping_marketplaces.sql'), 'utf8'));
  const r = await pool.query("SELECT slug FROM v3.activity_types WHERE slug IN ('shipping_walmart','shipping_amazon') AND active = true ORDER BY slug");
  console.log('shipping marketplaces: ' + (r.rowCount === 2 ? 'OK (' + r.rows.map((x) => x.slug).join(', ') + ')' : 'AUSENTE (' + r.rowCount + '/2)'));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
