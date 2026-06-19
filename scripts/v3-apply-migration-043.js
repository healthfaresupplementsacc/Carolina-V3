'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '043_pause.sql'), 'utf8'));
  const r = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='events' AND column_name IN ('paused_at','total_paused_seconds','is_unfinished') ORDER BY column_name");
  console.log('colunas pausa: ' + r.rows.map((x) => x.column_name).join(', '));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
