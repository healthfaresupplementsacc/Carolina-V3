'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '022_voice_special.sql'), 'utf8'));
  const v = await pool.query("SELECT to_regclass('v3.voice_recordings') t");
  console.log('voice_recordings: ' + (v.rows[0].t ? 'OK' : 'AUSENTE'));
  const e = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='events' AND column_name='orders_printed'");
  console.log('events.orders_printed: ' + (e.rowCount ? 'OK' : 'AUSENTE'));
  const s = await pool.query("SELECT id FROM v3.activity_types WHERE slug='special_task'");
  console.log('special_task: ' + (s.rowCount ? 'id' + s.rows[0].id : 'AUSENTE'));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
