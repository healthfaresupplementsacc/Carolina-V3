'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '025_admin_rbac.sql'), 'utf8'));
  for (const t of ['admin_users', 'admin_sessions']) {
    const r = await pool.query("SELECT to_regclass($1) t", ['v3.' + t]);
    console.log(t + ': ' + (r.rows[0].t ? 'OK' : 'AUSENTE'));
  }
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
