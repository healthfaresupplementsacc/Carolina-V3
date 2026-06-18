'use strict';
/* Confirma que o worker de limpeza removeu TODO dado de sandbox (read-only).
   railway run node scripts/verify-sandbox-clean.js */
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s) => pool.query(s).then((r) => r.rows[0]);
  const ev = await q('SELECT COUNT(*)::int n FROM v3.events WHERE is_test = true');
  const sbIds = (await pool.query('SELECT id FROM v3.persons WHERE is_sandbox = true')).rows.map((r) => r.id);
  const batches = await q("SELECT COUNT(*)::int n FROM v3.product_batches WHERE created_by_person_id = ANY('{" + (sbIds.join(',') || '0') + "}'::int[]) AND deleted_at IS NULL");
  const audit = await q("SELECT COUNT(*)::int n FROM v3.audit_log WHERE actor_person_id = ANY('{" + (sbIds.join(',') || '0') + "}'::int[])");
  console.log('events is_test restantes: ' + ev.n);
  console.log('lotes sandbox ativos restantes: ' + batches.n);
  console.log('audit sandbox restantes: ' + audit.n);
  const clean = ev.n === 0 && batches.n === 0 && audit.n === 0;
  console.log(clean ? '\nLIMPEZA: OK (nada de sandbox sobrou)' : '\nLIMPEZA: ainda há resíduo (rode de novo em alguns segundos)');
  await pool.end();
  process.exit(clean ? 0 : 1);
})().then(null, (e) => { console.error('ERR', e.message); process.exit(2); });
