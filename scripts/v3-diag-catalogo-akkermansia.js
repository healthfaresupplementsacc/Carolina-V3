'use strict';
const { Pool } = require('pg');
async function main() {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log('=== Akkermansia/Akkermania/Akemansia em v3.products ===');
  const r1 = (await p.query(`SELECT id, canonical_name FROM v3.products WHERE canonical_name ~* '(akk|akem|akman)' ORDER BY id`)).rows;
  for (const x of r1) console.log(`  id=${x.id} ${x.canonical_name}`);
  if (r1.length === 0) console.log('  (não cadastrado)');

  console.log('\n=== activity_types relevantes ===');
  const r2 = (await p.query(`SELECT id, slug, display_name FROM v3.activity_types WHERE slug IN ('production_line','machine_downtime','partial_count','marketplace_prep') ORDER BY id`)).rows;
  for (const x of r2) console.log(`  id=${x.id} slug=${x.slug} ${x.display_name}`);
  await p.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
