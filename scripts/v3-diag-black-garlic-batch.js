'use strict';
const { Pool } = require('pg');
async function main() {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log('--- Produto Black Garlic ---');
  const pr = (await p.query(`SELECT id, canonical_name FROM v3.products WHERE canonical_name ILIKE '%black garlic%' OR canonical_name ILIKE '%black%' ORDER BY id`)).rows;
  for (const r of pr) console.log(`  product_id=${r.id} ${r.canonical_name}`);

  console.log('\n--- Batches Black Garlic ativos ---');
  const bs = (await p.query(`
    SELECT pb.id, pb.product_id, pb.batch_number, pb.status, pb.started_at, pb.finished_at, pb.deleted_at
    FROM v3.product_batches pb
    JOIN v3.products pr ON pr.id = pb.product_id
    WHERE pr.canonical_name ILIKE '%black garlic%'
    ORDER BY pb.started_at DESC LIMIT 8`)).rows;
  for (const x of bs) console.log(`  batch_id=${x.id} product_id=${x.product_id} ${x.batch_number} status=${x.status} started=${x.started_at} finished=${x.finished_at} deleted=${x.deleted_at}`);
  await p.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
