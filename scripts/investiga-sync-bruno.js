'use strict';
const { Pool } = require('pg');
const EDT = 'America/New_York';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s,p) => pool.query(s,p).then(r=>r.rows).catch(e=>[{ERRO:e.message}]);
  console.log('=== events ABERTOS hoje (todos) — quem está em quê ===');
  console.log(JSON.stringify(await q(`SELECT e.id, p.display_name, at.slug, at.is_long_running AS slug_longrun, e.is_long_running AS ev_longrun, e.source, pb.batch_number FROM v3.events e JOIN v3.persons p ON p.id=e.person_id JOIN v3.activity_types at ON at.id=e.activity_type_id LEFT JOIN v3.product_batches pb ON pb.id=e.product_batch_id WHERE e.ended_at IS NULL AND e.deleted_at IS NULL ORDER BY p.display_name, e.started_at`), null, 1));
  console.log('\n=== ems_auto events (o que o auto check-in criou) ===');
  console.log(JSON.stringify(await q(`SELECT e.id, p.display_name, at.slug, pb.batch_number, e.ended_at FROM v3.events e JOIN v3.persons p ON p.id=e.person_id JOIN v3.activity_types at ON at.id=e.activity_type_id LEFT JOIN v3.product_batches pb ON pb.id=e.product_batch_id WHERE e.source='ems_auto' ORDER BY e.started_at DESC`), null, 1));
  console.log('\n=== is_long_running por slug (encapsulation/tablet/mixing?) ===');
  console.log(JSON.stringify(await q(`SELECT slug, is_long_running FROM v3.activity_types WHERE slug IN ('encapsulation','mixing','weighing','production_line','review','separating') ORDER BY slug`)));
  console.log('\n=== detecção: cache ativo do Bruno (id7) — review/yield_review (operador-de-registro) ===');
  console.log(JSON.stringify(await q(`SELECT batch_number, stage, machine, sync_status FROM v3.ems_activity_cache WHERE tracker_person_id=7 AND sync_status='active' ORDER BY last_synced_at DESC LIMIT 10`)));
  await pool.end();
})().catch(e=>{console.error('ERRO',e.message);process.exit(1);});
