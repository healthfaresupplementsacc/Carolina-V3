'use strict';
/* Investigação de prod (read-only) p/ os 3 bugs. railway run node scripts/inspect-prod.js */
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s, p) => pool.query(s, p).then((r) => r.rows);

  console.log('=== activity_types colunas ===');
  const acols = await q("SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='activity_types'");
  console.log('  ' + acols.map((c) => c.column_name).join(', '));
  console.log('=== activity_types (slugs reais) ===');
  const acts = await q("SELECT slug, requires_product FROM v3.activity_types WHERE active ORDER BY slug");
  acts.forEach((a) => console.log(`  ${a.slug}  | requires_product=${a.requires_product}`));
  console.log(`  has 'production_line'? ${acts.some((a) => a.slug === 'production_line')}`);

  console.log('\n=== eventos production_line recentes (slug efetivo) ===');
  const evs = await q(`SELECT e.id, at.slug, e.started_at, e.ended_at, e.cowork_group_id, e.product_batch_id
                       FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
                       WHERE at.slug = 'production_line'
                       ORDER BY e.started_at DESC LIMIT 8`);
  evs.forEach((e) => console.log(`  ev#${e.id} slug=${e.slug} batch=${e.product_batch_id} cowork=${e.cowork_group_id || '-'} ended=${e.ended_at ? 'Y' : 'N'}`));

  console.log('\n=== product_batches recentes (p/ Bug 2) ===');
  const batches = await q(`SELECT pb.id, pb.batch_number, pb.product_id, pr.canonical_name,
                                  MAX(e.started_at) AS last_event
                           FROM v3.product_batches pb
                           LEFT JOIN v3.products pr ON pr.id = pb.product_id
                           LEFT JOIN v3.events e ON e.product_batch_id = pb.id AND e.deleted_at IS NULL
                           GROUP BY pb.id, pb.batch_number, pb.product_id, pr.canonical_name
                           ORDER BY MAX(e.started_at) DESC NULLS LAST LIMIT 10`);
  batches.forEach((b) => console.log(`  ${b.batch_number} | prod#${b.product_id} ${b.canonical_name || '?'} | last_event=${b.last_event || '-'}`));

  console.log('\n=== products: quantos / colunas de imagem (p/ Bug 3) ===');
  const cols = await q("SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='products'");
  console.log('  colunas products: ' + cols.map((c) => c.column_name).join(', '));
  const pc = await q('SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE active)::int active FROM v3.products');
  console.log(`  products total=${pc[0].n} active=${pc[0].active}`);

  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
