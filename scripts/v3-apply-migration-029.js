'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '029_label_tasks.sql'), 'utf8'));
  const r = await pool.query("SELECT slug, display_name FROM v3.activity_types WHERE slug IN ('label_change','label_repair') ORDER BY slug");
  r.rows.forEach((x) => console.log('  ' + x.slug + ' = ' + x.display_name));
  console.log('total: ' + r.rowCount + ' (esperado 2)');
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
