'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '031_production_line_exception.sql'), 'utf8'));
  const r = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='events' AND column_name IN ('exception_no_count','exception_reason')");
  console.log('events.exception_* : ' + (r.rowCount === 2 ? 'OK' : 'AUSENTE (' + r.rowCount + '/2)'));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
