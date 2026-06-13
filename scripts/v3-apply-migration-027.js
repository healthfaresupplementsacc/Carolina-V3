'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '027_forgotten_checkouts.sql'), 'utf8'));
  const r = await pool.query("SELECT to_regclass('v3.forgotten_checkouts') t");
  console.log('forgotten_checkouts: ' + (r.rows[0].t ? 'OK' : 'AUSENTE'));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
