'use strict';
const { Pool } = require('pg');
const { ems } = require('../src/v3/services/ems-api');
const { EmsActivitySync } = require('../src/workers/ems-activity-sync');
(async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const w = new EmsActivitySync({ db, ems });
  const r = await w.tick();
  console.log('tick:', JSON.stringify(r));
  const c = await db.query("SELECT machine, process_type, stage, supplement_name, batch_number, employee_ems_name, tracker_person_id, sync_status, EXTRACT(EPOCH FROM (NOW()-started_at))::int AS elapsed FROM v3.ems_activity_cache ORDER BY last_synced_at DESC LIMIT 10");
  console.log('ems_activity_cache (' + c.rowCount + '):');
  c.rows.forEach((x) => console.log('  ' + (x.machine || x.process_type) + ' · ' + x.supplement_name + ' · lote ' + x.batch_number + ' · ' + (x.employee_ems_name || '?') + '→person' + (x.tracker_person_id || '?') + ' · ' + x.sync_status + ' · ' + x.elapsed + 's'));
  await db.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
