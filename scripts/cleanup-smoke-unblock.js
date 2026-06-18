'use strict';
/* Limpa os artefatos do smoke-real-unblock (event + batch de teste). read/write mínimo.
   railway run node scripts/cleanup-smoke-unblock.js */
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const ev = await pool.query("UPDATE v3.events SET deleted_at = NOW() WHERE id = 925 AND deleted_at IS NULL RETURNING id");
  const b = await pool.query("UPDATE v3.product_batches SET deleted_at = NOW() WHERE batch_number = 'ZZSMOKE-019' AND deleted_at IS NULL RETURNING id, batch_number");
  console.log('event 925 soft-deleted: ' + (ev.rowCount ? 'OK' : 'já estava / não achou'));
  console.log('batch ZZSMOKE-019 soft-deleted: ' + (b.rowCount ? 'OK (#' + b.rows[0].id + ')' : 'já estava / não achou'));
  // confirma que não sobrou nada de teste
  const left = await pool.query("SELECT id, batch_number, origin FROM v3.product_batches WHERE batch_number LIKE 'ZZSMOKE%' AND deleted_at IS NULL");
  console.log('batches de teste ativos restantes: ' + left.rowCount);
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
