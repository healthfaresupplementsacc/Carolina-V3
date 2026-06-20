'use strict';
const { Pool } = require('pg');
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = await p.query("SELECT e.id, at.slug, e.is_long_running, e.source FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id WHERE at.slug IN ('encapsulation','mixing','weighing') AND e.started_at > NOW()-INTERVAL '15 minutes' ORDER BY e.id DESC LIMIT 4");
  console.log(JSON.stringify(r.rows));
  await p.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
