'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '023_blocked_ips.sql'), 'utf8'));
  const t = await pool.query("SELECT to_regclass('v3.blocked_ips') t");
  console.log('blocked_ips: ' + (t.rows[0].t ? 'OK' : 'AUSENTE'));
  const i = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname='v3' AND indexname='idx_blocked_ips_expires'");
  console.log('idx_blocked_ips_expires: ' + (i.rowCount ? 'OK' : 'AUSENTE'));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
