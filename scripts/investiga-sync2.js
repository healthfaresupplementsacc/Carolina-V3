'use strict';
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s,p) => pool.query(s,p).then(r=>r.rows).catch(e=>[{ERRO:e.message}]);
  console.log('=== TODOS events abertos (quem em quê) ===');
  console.log(JSON.stringify(await q(`SELECT e.id, p.display_name, at.slug, e.is_long_running, e.source, pb.batch_number FROM v3.events e JOIN v3.persons p ON p.id=e.person_id JOIN v3.activity_types at ON at.id=e.activity_type_id LEFT JOIN v3.product_batches pb ON pb.id=e.product_batch_id WHERE e.ended_at IS NULL AND e.deleted_at IS NULL ORDER BY p.display_name`), null, 1));
  console.log('\n=== activity_types: colunas de "background/long" ===');
  console.log(JSON.stringify(await q(`SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='activity_types' AND (column_name ILIKE '%long%' OR column_name ILIKE '%background%' OR column_name ILIKE '%flow%')`)));
  console.log('\n=== flow/category de encapsulation/mixing/etc ===');
  console.log(JSON.stringify(await q(`SELECT slug, flow, category FROM v3.activity_types WHERE slug IN ('encapsulation','mixing','weighing','production_line','review','tableting','separating')`)));
  await pool.end();
})().catch(e=>{console.error('ERRO',e.message);process.exit(1);});
