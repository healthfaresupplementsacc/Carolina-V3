'use strict';
/* Ground truth do NOSSO catálogo (Bruno 07-09): colunas de v3.products + lista.
   railway run --service ProductionLineService node scripts/our-products-probe.js */
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const cols = (await p.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='v3' AND table_name='products' ORDER BY ordinal_position`)).rows;
  console.log('\n════ v3.products — colunas ════');
  cols.forEach((c) => console.log(`  ${c.column_name.padEnd(24)} ${c.data_type}`));

  // qualquer coluna que cheire a SKU/identificador de marketplace no schema v3
  const skuish = (await p.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='v3' AND (
        column_name ILIKE '%sku%' OR column_name ILIKE '%asin%' OR column_name ILIKE '%upc%'
        OR column_name ILIKE '%fnsku%' OR column_name ILIKE '%barcode%' OR column_name ILIKE '%marketplace%'
        OR column_name ILIKE '%listing%' OR column_name ILIKE '%external%' OR column_name ILIKE '%veeqo%')
      ORDER BY table_name, column_name`)).rows;
  console.log('\n════ colunas "SKU-ish" em todo o schema v3 ════');
  if (!skuish.length) console.log('  (nenhuma)');
  skuish.forEach((c) => console.log(`  v3.${c.table_name}.${c.column_name}`));

  const n = (await p.query('SELECT COUNT(*)::int c FROM v3.products')).rows[0].c;
  const rows = (await p.query('SELECT * FROM v3.products ORDER BY id LIMIT 400')).rows;
  console.log(`\n════ v3.products — ${n} linhas (mostrando ${rows.length}) ════`);
  rows.forEach((r) => {
    // imprime todas as chaves não-nulas curtas, pra ver que identificadores existem
    const extra = Object.entries(r).filter(([k]) => !['id', 'canonical_name', 'created_at', 'updated_at'].includes(k))
      .filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `${k}=${Array.isArray(v) ? '[' + v.join(',') + ']' : v}`).join('  ');
    console.log(`  #${String(r.id).padEnd(4)} ${String(r.canonical_name || '').padEnd(42)} ${extra}`);
  });
  console.log('');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
