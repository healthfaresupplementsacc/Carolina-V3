'use strict';
const { Pool } = require('pg');
const EDT = 'America/New_York';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s,p) => pool.query(s,p).then(r=>r.rows).catch(e=>[{ERRO:e.message}]);
  console.log('=== ev1040 ===');
  console.log(JSON.stringify(await q(`SELECT e.id, e.person_id, p.display_name, at.slug, e.source, e.started_at, e.ended_at, e.closed_reason, pb.batch_number, e.description FROM v3.events e JOIN v3.persons p ON p.id=e.person_id JOIN v3.activity_types at ON at.id=e.activity_type_id LEFT JOIN v3.product_batches pb ON pb.id=e.product_batch_id WHERE e.id=1040`), null, 1));
  console.log('\n=== events ABERTOS do Bruno Sarmento (id 7) — duplicados? ===');
  console.log(JSON.stringify(await q(`SELECT e.id, at.slug, e.source, to_char(e.started_at AT TIME ZONE '${EDT}','MM-DD HH24:MI') st, pb.batch_number, e.closed_reason FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id LEFT JOIN v3.product_batches pb ON pb.id=e.product_batch_id WHERE e.person_id=7 AND e.ended_at IS NULL AND e.deleted_at IS NULL ORDER BY e.started_at DESC`), null, 1));
  console.log('\n=== events ems_auto criados (auto check-in disparou?) ===');
  console.log(JSON.stringify(await q(`SELECT COUNT(*)::int n, MIN(started_at) primeiro, MAX(started_at) ultimo FROM v3.events WHERE source='ems_auto'`)));
  console.log('por person/slug ems_auto: ' + JSON.stringify(await q(`SELECT person_id, COUNT(*)::int n, COUNT(*) FILTER (WHERE ended_at IS NULL)::int abertos FROM v3.events WHERE source='ems_auto' GROUP BY 1`)));
  console.log('\n=== cache EMS do Bruno (auto_event_id) ===');
  console.log(JSON.stringify(await q(`SELECT batch_number, stage, machine, sync_status, auto_event_id FROM v3.ems_activity_cache WHERE tracker_person_id=7 AND sync_status='active' ORDER BY last_synced_at DESC LIMIT 6`), null, 1));
  await pool.end();
})().catch(e=>{console.error('ERRO',e.message);process.exit(1);});
