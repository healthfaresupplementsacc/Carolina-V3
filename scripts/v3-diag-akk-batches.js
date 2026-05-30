'use strict';
const { Pool } = require('pg');
async function main() {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = (await p.query(`SELECT id, batch_number, status, started_at FROM v3.product_batches WHERE product_id=18 ORDER BY started_at DESC LIMIT 5`)).rows;
  console.log('Batches Akkermansia:');
  for (const x of r) console.log(`  batch_id=${x.id} ${x.batch_number} status=${x.status} started=${x.started_at}`);
  if (r.length === 0) console.log('  (nenhum batch)');
  await p.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
