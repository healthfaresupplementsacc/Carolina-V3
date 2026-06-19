'use strict';
const { Pool } = require('pg');
const EDT = 'America/New_York';
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await p.query(
      `INSERT INTO v3.production_counts
         (product_id, product_batch_id, bottles, reported_at, production_date,
          reported_by_person_id, source_event_id, unit, confidence, kind, marketplace)
       VALUES ($1, $2, $3, NOW(), (NOW() AT TIME ZONE '${EDT}')::date, $4, $5, 'orders', 'high', 'orders', $6)`,
      [null, null, 48, 8, null, 'Amazon']);
    console.log('INSERT OK (limpa)');
    await p.query("DELETE FROM v3.production_counts WHERE kind='orders' AND marketplace='Amazon' AND reported_by_person_id=8 AND source_event_id IS NULL");
  } catch (e) { console.log('INSERT ERRO: ' + e.message); }
  await p.end();
})().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
