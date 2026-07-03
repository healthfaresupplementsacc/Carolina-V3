'use strict';
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const fc = await p.query("SELECT id, resolution, to_char(carolina_dm_sent_at AT TIME ZONE 'America/New_York','MM-DD HH24:MI') AS dm_sent FROM v3.forgotten_checkouts WHERE id = 18");
  console.log('forgotten_checkout #18 (Ana):', JSON.stringify(fc.rows[0]));
  const hb = await p.query("SELECT key, to_char((value #>> '{}')::timestamptz AT TIME ZONE 'America/New_York','HH24:MI:SS') AS tick FROM v3.settings WHERE key LIKE 'worker_tick_%' ORDER BY key");
  console.log('heartbeats (NY):');
  hb.rows.forEach((r) => console.log('  ', r.key, '→', r.tick));
  const dm = await p.query("SELECT to_char(created_at AT TIME ZONE 'America/New_York','MM-DD HH24:MI') AS at, metadata FROM v3.audit_log WHERE action='carolina_forgotten_dm_sent' AND created_at > NOW() - INTERVAL '2 hours' ORDER BY id DESC LIMIT 3");
  dm.rows.forEach((r) => console.log('  DM audit:', r.at, JSON.stringify(r.metadata)));
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
