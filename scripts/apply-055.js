'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '055_product_variants.sql'), 'utf8');
  await pool.query(sql);
  const reactivated = (await pool.query('SELECT COUNT(*)::int n FROM v3.products WHERE COALESCE(active,true)=true')).rows[0].n;
  const linked = (await pool.query('SELECT id, canonical_name, variant_label, parent_product_id FROM v3.products WHERE parent_product_id IS NOT NULL ORDER BY canonical_name')).rows;
  console.log('Produtos ativos agora:', reactivated);
  console.log('Variantes ligadas ao pai:', linked.length);
  linked.forEach((v) => console.log('  ', v.canonical_name, '→ pai', v.parent_product_id, '(' + v.variant_label + ')'));
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
