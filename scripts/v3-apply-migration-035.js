'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '035_sandbox_account.sql'), 'utf8'));
  const a = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='persons' AND column_name='is_sandbox'");
  const b = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='events' AND column_name='is_test'");
  console.log('persons.is_sandbox: ' + (a.rowCount ? 'OK' : 'AUSENTE') + ' | events.is_test: ' + (b.rowCount ? 'OK' : 'AUSENTE'));
  // schemas p/ o seed
  const pcols = await pool.query("SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema='v3' AND table_name='persons' ORDER BY ordinal_position");
  console.log('\n=== persons cols ===');
  pcols.rows.forEach((c) => console.log(`  ${c.column_name} ${c.is_nullable === 'NO' ? 'NOT NULL' : ''} ${c.column_default ? 'DEF ' + c.column_default : ''}`));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
