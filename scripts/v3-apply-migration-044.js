'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '044_ems_autocheckin.sql'), 'utf8'));
  const r = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND ((table_name='persons' AND column_name='ems_user_id') OR (table_name='ems_activity_cache' AND column_name='auto_event_id')) ORDER BY 1");
  console.log('colunas: ' + r.rows.map((x) => x.column_name).join(', '));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
