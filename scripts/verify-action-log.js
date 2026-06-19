'use strict';
const { Pool } = require('pg');
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = await p.query("SELECT action_type, person_name, is_test, to_char(created_at AT TIME ZONE 'America/New_York','HH24:MI:SS') AS t FROM v3.operator_action_log WHERE created_at > NOW() - INTERVAL '5 minutes' ORDER BY id DESC LIMIT 8");
  console.log('action_log (últimos 5min): ' + r.rowCount + ' registros');
  r.rows.forEach((x) => console.log('  ' + x.t + ' · ' + x.person_name + ' · ' + x.action_type + ' · test=' + x.is_test));
  await p.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
