'use strict';
/* Cria/atualiza o operador SANDBOX (PIN 9999, is_sandbox=true). Idempotente.
   railway run node scripts/seed-sandbox.js */
const { Pool } = require('pg');
const opAuth = require('../src/lib/op-auth');
const PIN = process.env.SANDBOX_PIN || '9999';
const NAME = '🧪 Sandbox (Bruno test)';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const hashed = opAuth.hashPin(PIN); // { pin_hash, pin_salt }
  const existing = await pool.query("SELECT id FROM v3.persons WHERE is_sandbox = true AND deleted_at IS NULL ORDER BY id LIMIT 1");
  let id;
  if (existing.rowCount) {
    id = existing.rows[0].id;
    await pool.query(
      "UPDATE v3.persons SET display_name=$2, role='operator', active=true, is_sandbox=true, pin_hash=$3, pin_salt=$4, updated_at=NOW() WHERE id=$1",
      [id, NAME, hashed.pin_hash, hashed.pin_salt]);
    console.log('sandbox atualizado: person#' + id);
  } else {
    const r = await pool.query(
      "INSERT INTO v3.persons (display_name, role, active, is_sandbox, pin_hash, pin_salt, auto_logoff_seconds) VALUES ($1,'operator',true,true,$2,$3,600) RETURNING id",
      [NAME, hashed.pin_hash, hashed.pin_salt]);
    id = r.rows[0].id;
    console.log('sandbox criado: person#' + id);
  }
  const chk = await pool.query("SELECT id, display_name, is_sandbox, active FROM v3.persons WHERE id=$1", [id]);
  console.log('  ' + JSON.stringify(chk.rows[0]) + '  PIN=' + PIN);
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
