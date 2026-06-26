'use strict';
const { Pool } = require('pg');
const { EmsActivitySync } = require('../src/workers/ems-activity-sync');
const { ems } = require('../src/v3/services/ems-api');
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const w = new EmsActivitySync({ db, ems });
  const n = await w._syncProductCatalog();
  console.log('catálogo importado: +' + n + ' produtos novos do EMS');
  const r = await db.query('SELECT COUNT(*)::int AS n FROM v3.products');
  console.log('total de produtos locais agora:', r.rows[0].n);
  const sample = await db.query("SELECT canonical_name FROM v3.products ORDER BY id DESC LIMIT 8");
  console.log('últimos adicionados:', sample.rows.map((x) => x.canonical_name).join(', '));
  await db.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
