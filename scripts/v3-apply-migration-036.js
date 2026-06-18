'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '036_passada2_eod_gaps.sql'), 'utf8'));
  const t = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='v3' AND table_name IN ('daily_totals_log','activity_gaps')");
  console.log('tabelas: ' + t.rows.map((r) => r.table_name).sort().join(', ') + ' (' + t.rowCount + '/2)');
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
