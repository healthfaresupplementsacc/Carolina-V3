'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '033_cowork_multi_finish.sql'), 'utf8'));
  const r = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='events' AND column_name IN ('cowork_group_id','cowork_member_finished_at','cowork_is_last_finisher')");
  console.log('events.cowork_* : ' + (r.rowCount === 3 ? 'OK' : 'AUSENTE (' + r.rowCount + '/3)'));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
