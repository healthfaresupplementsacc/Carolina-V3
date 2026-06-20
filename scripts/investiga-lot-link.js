'use strict';
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s,p) => pool.query(s,p).then(r=>r.rows).catch(e=>[{ERRO:e.message}]);
  const lots = ['BR-2026-0221','BR-2026-0219','BR-2026-0220','BR-2026-0223'];
  console.log('=== esses lotes existem em v3.product_batches (local)? ===');
  console.log(JSON.stringify(await q(`SELECT pb.batch_number, pb.product_id, pr.canonical_name product, pb.origin FROM v3.product_batches pb LEFT JOIN v3.products pr ON pr.id=pb.product_id WHERE pb.batch_number = ANY($1) ORDER BY pb.batch_number`, [lots]), null, 1));
  console.log('\n=== os produtos existem em v3.products? ===');
  console.log(JSON.stringify(await q(`SELECT id, canonical_name, aliases FROM v3.products WHERE canonical_name ILIKE '%myo%' OR canonical_name ILIKE '%melatonin%' OR canonical_name ILIKE '%inositol%'`)));
  console.log('\n=== events recentes desses lotes (como foram criados) ===');
  console.log(JSON.stringify(await q(`SELECT e.id, at.slug, e.source, e.product_batch_id, e.description FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id LEFT JOIN v3.product_batches pb ON pb.id=e.product_batch_id WHERE (e.description ILIKE '%0221%' OR e.description ILIKE '%0219%') AND e.started_at > NOW()-INTERVAL '2 days' ORDER BY e.started_at DESC LIMIT 8`), null, 1));
  await pool.end();
})().catch(e=>{console.error('ERRO',e.message);process.exit(1);});
