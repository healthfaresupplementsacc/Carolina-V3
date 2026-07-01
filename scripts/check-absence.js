'use strict';
const { Pool } = require('pg');
const { AbsenceAlert } = require('../src/workers/absence-alert');
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const w = new AbsenceAlert({ db, slack: null, channelId: null, enabled: true, thresholdMin: 15 });
  const absent = await w.findAbsent(); // read-only
  console.log('Ociosos agora (>15min sem função):', JSON.stringify(absent.map((a) => ({ who: a.display_name, idle_min: a.idle_min })), null, 1));
  const recent = await db.query(
    `SELECT person_name, to_char(created_at AT TIME ZONE 'America/New_York','MM-DD HH24:MI') AS at, payload
     FROM v3.operator_action_log WHERE action_type = 'absence_alert' AND created_at > NOW() - INTERVAL '6 hours' ORDER BY created_at DESC LIMIT 10`);
  console.log('Alertas de ausência enviados (últimas 6h):', recent.rowCount);
  recent.rows.forEach((r) => console.log('  ', r.at, r.person_name, JSON.stringify(r.payload)));
  await db.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
