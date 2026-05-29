'use strict';
const { Pool } = require('pg');
async function main() {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log('--- product Potassium ---');
  const pr = (await p.query(`SELECT id, canonical_name FROM v3.products WHERE canonical_name ILIKE '%potassium%' ORDER BY id`)).rows;
  for (const r of pr) console.log(`  product_id=${r.id} ${r.canonical_name}`);
  console.log('\n--- v3.product_batches schema ---');
  const cols = (await p.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='v3' AND table_name='product_batches' ORDER BY ordinal_position`)).rows;
  for (const c of cols) console.log(`  ${c.column_name} ${c.data_type}${c.is_nullable === 'YES' ? ' NULL' : ' NOT NULL'}${c.column_default ? ' def=' + c.column_default : ''}`);
  console.log('\n--- batches mais recentes ---');
  const sample = (await p.query(`SELECT id, product_id, batch_number, status, created_at FROM v3.product_batches ORDER BY created_at DESC LIMIT 5`)).rows;
  for (const r of sample) console.log(`  batch_id=${r.id} product_id=${r.product_id} ${r.batch_number} status=${r.status} created=${r.created_at}`);
  await p.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
