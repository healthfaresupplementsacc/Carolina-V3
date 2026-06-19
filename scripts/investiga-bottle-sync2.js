'use strict';
const { Pool } = require('pg');
const EDT = 'America/New_York';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s) => pool.query(s).then((r) => r.rows);
  const WIN = `e.ended_at > NOW() - INTERVAL '14 days'`;

  console.log('=== production_line FECHADOS últimos 14d: linkagem batch/product + count ===');
  const rows = await q(`
    SELECT e.id, p.display_name, e.product_batch_id, pb.product_id, pb.batch_number, e.exception_no_count,
           pc.id AS pc_id, pc.kind, pc.unit, pc.bottles
    FROM v3.events e
    JOIN v3.activity_types at ON at.id=e.activity_type_id AND at.slug='production_line'
    JOIN v3.persons p ON p.id=e.person_id
    LEFT JOIN v3.product_batches pb ON pb.id=e.product_batch_id
    LEFT JOIN v3.production_counts pc ON pc.source_event_id=e.id AND pc.deleted_at IS NULL
    WHERE e.deleted_at IS NULL AND e.ended_at IS NOT NULL AND ${WIN}
    ORDER BY e.ended_at DESC LIMIT 60`);
  let nullBatch=0,nullProd=0,linked=0,withCount=0,exc=0;
  rows.forEach((r)=>{ if(r.pc_id)withCount++; if(r.exception_no_count)exc++;
    if(!r.product_batch_id)nullBatch++; else if(r.product_id==null)nullProd++; else linked++; });
  console.log(`${rows.length} events | ${withCount} c/ count | ${exc} exceção | LINKADOS=${linked} batch_NULL=${nullBatch} product_NULL=${nullProd}`);
  // mostra os que têm count mas batch/product faltando (= os que somem)
  console.log('\n--- counts que o INNER JOIN DERRUBA (têm bottles mas batch/product NULL): ---');
  rows.filter((r)=>r.pc_id && r.kind==='bottles' && (!r.product_batch_id || r.product_id==null))
      .forEach((r)=>console.log(`  ev${r.id} ${r.display_name} bottles=${r.bottles} batch=${r.batch_number||'NULL'} pid=${r.product_id==null?'NULL':r.product_id}`));

  const since14 = `pc.reported_at > NOW() - INTERVAL '14 days'`;
  const inner = (await q(`SELECT COALESCE(SUM(pc.bottles),0)::int t FROM v3.production_counts pc JOIN v3.events e ON e.id=pc.source_event_id JOIN v3.activity_types at ON at.id=e.activity_type_id JOIN v3.product_batches pb ON pb.id=e.product_batch_id JOIN v3.products pr ON pr.id=pb.product_id WHERE at.slug='production_line' AND pc.deleted_at IS NULL AND e.deleted_at IS NULL AND ${since14}`))[0].t;
  const correct = (await q(`SELECT COALESCE(SUM(pc.bottles),0)::int t FROM v3.production_counts pc JOIN v3.events e ON e.id=pc.source_event_id JOIN v3.activity_types at ON at.id=e.activity_type_id WHERE at.slug='production_line' AND pc.kind='bottles' AND pc.deleted_at IS NULL AND e.deleted_at IS NULL AND ${since14}`))[0].t;
  console.log(`\n=== 14d: byProduct INNER=${inner} | correto(kind=bottles,sem product join)=${correct} | PERDIDOS=${correct-inner} ===`);

  const byKind = await q(`SELECT COALESCE(kind,'(null)') kind, COUNT(*)::int n, SUM(bottles)::int total FROM v3.production_counts WHERE deleted_at IS NULL AND reported_at > NOW() - INTERVAL '14 days' GROUP BY 1`);
  console.log('por kind (14d): ' + JSON.stringify(byKind));
  await pool.end();
})().catch((e)=>{console.error('ERRO',e.message);process.exit(1);});
