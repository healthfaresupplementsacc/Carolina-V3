'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '028_metrics.sql'), 'utf8'));
  const mv = await pool.query("SELECT to_regclass('v3.events_enriched') t");
  console.log('events_enriched (matview): ' + (mv.rows[0].t ? 'OK' : 'AUSENTE'));
  const tt = await pool.query("SELECT to_regclass('v3.task_targets') t");
  console.log('task_targets: ' + (tt.rows[0].t ? 'OK' : 'AUSENTE'));
  const n = await pool.query('SELECT count(*)::int n FROM v3.events_enriched');
  console.log('events_enriched linhas: ' + n.rows[0].n);
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
