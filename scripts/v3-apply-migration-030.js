'use strict';
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '030_notification_delivery_method.sql'), 'utf8'));
  const r = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='notifications' AND column_name='delivery_method'");
  console.log('notifications.delivery_method: ' + (r.rowCount ? 'OK' : 'AUSENTE'));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
