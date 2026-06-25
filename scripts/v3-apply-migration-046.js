'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '046_pp_flow_fix.sql'), 'utf8'));
  const r = await pool.query("SELECT slug, display_name, flow, counts_as_pp FROM v3.activity_types WHERE slug LIKE '%\\_other' ORDER BY slug");
  console.log('flows dos _other depois da 046:');
  r.rows.forEach((x) => console.log(`  ${x.slug} | "${x.display_name}" | flow=${x.flow} | counts_as_pp=${x.counts_as_pp}`));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
