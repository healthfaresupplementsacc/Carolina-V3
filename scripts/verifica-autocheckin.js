'use strict';
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s) => pool.query(s).then((r) => r.rows).catch((e) => [{ ERRO: e.message }]);
  console.log('persons com ems_user_id (UUID) backfilled: ' + JSON.stringify(await q("SELECT id, display_name, ems_user_id FROM v3.persons WHERE ems_user_id IS NOT NULL ORDER BY display_name")));
  console.log('cache: ativos mapeados (tracker_person_id) + stage_started recente?: ' + JSON.stringify(await q("SELECT batch_number, stage, machine, tracker_person_id, auto_event_id, to_char(started_at,'MM-DD HH24:MI') started FROM v3.ems_activity_cache WHERE sync_status='active' ORDER BY started_at DESC NULLS LAST LIMIT 6")));
  console.log('events ems_auto criados: ' + JSON.stringify(await q("SELECT COUNT(*)::int n, MAX(started_at) ultimo FROM v3.events WHERE source='ems_auto'")));
  console.log('audit ems_auto_checkin (erros?): ' + JSON.stringify(await q("SELECT COUNT(*)::int n FROM v3.audit_log WHERE action='event.ems_auto_checkin'")));
  await pool.end();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
