'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '024_outros_por_grupo.sql'), 'utf8'));
  const r = await pool.query(
    "SELECT slug FROM v3.activity_types WHERE slug LIKE '%_other' ORDER BY slug");
  console.log('slugs _other no banco: ' + r.rows.map((x) => x.slug).join(', '));
  console.log('total: ' + r.rowCount + ' (esperado 5)');
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
