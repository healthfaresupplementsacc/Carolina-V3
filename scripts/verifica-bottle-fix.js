'use strict';
const { Pool } = require('pg');
const EDT = 'America/New_York';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s) => pool.query(s).then((r) => r.rows);
  const win = `(e.ended_at AT TIME ZONE '${EDT}')::date > (NOW() AT TIME ZONE '${EDT}')::date - 14`;
  // NOVO byProduct (LEFT JOIN + kind=bottles)
  const nov = await q(`
    SELECT COALESCE(pr.canonical_name,'Sem produto vinculado') product, SUM(pc.bottles)::int total
    FROM v3.production_counts pc
    JOIN v3.events e ON e.id=pc.source_event_id
    JOIN v3.activity_types at ON at.id=e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id=e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id=pb.product_id
    WHERE at.slug='production_line' AND pc.kind='bottles' AND pc.deleted_at IS NULL AND e.deleted_at IS NULL AND ${win}
    GROUP BY 1 ORDER BY total DESC`);
  const totalNovo = nov.reduce((a, r) => a + r.total, 0);
  console.log('NOVO byProduct (LEFT+kind) total 14d = ' + totalNovo);
  console.log('  por produto: ' + JSON.stringify(nov));
  // confirma: nenhum order vazou (deve ser 0 orders no production_line)
  const leak = await q(`SELECT COUNT(*)::int n FROM v3.production_counts pc JOIN v3.events e ON e.id=pc.source_event_id JOIN v3.activity_types at ON at.id=e.activity_type_id WHERE at.slug='production_line' AND pc.kind<>'bottles' AND pc.deleted_at IS NULL`);
  console.log('counts production_line com kind != bottles (deve 0): ' + leak[0].n);
  await pool.end();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
