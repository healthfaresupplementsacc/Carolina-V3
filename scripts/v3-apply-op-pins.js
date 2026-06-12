'use strict';
/* Seta/rotaciona PINs dos operadores (scrypt) + count_exempt do Bruno Sarmento.
   PINs vêm de ENV VARS (nunca em claro no repo):
     PIN_VITOR, PIN_SIMONE, PIN_ANA, PIN_BRUNO_S   (4 dígitos cada)
   Pode setar só alguns (os ausentes são pulados) — útil pra rotação individual.

   Rodar (PowerShell):
     $env:PIN_VITOR='....'; $env:PIN_SIMONE='....'; ...
     railway run --service ProductionLineService node scripts/v3-apply-op-pins.js */
const { Pool } = require('pg');
const { hashPin } = require('../src/lib/op-auth');

const TARGETS = [
  { id: 4, name: 'Vitor', env: 'PIN_VITOR' },
  { id: 5, name: 'Simone', env: 'PIN_SIMONE' },
  { id: 6, name: 'Ana', env: 'PIN_ANA' },
  { id: 7, name: 'Bruno Sarmento', env: 'PIN_BRUNO_S', count_exempt: true },
];

async function main() {
  const todo = TARGETS.filter((t) => process.env[t.env]);
  if (!todo.length) {
    console.error('Nenhuma env var de PIN setada (PIN_VITOR / PIN_SIMONE / PIN_ANA / PIN_BRUNO_S). Nada a fazer.');
    process.exit(1);
  }
  for (const t of todo) {
    if (!/^\d{4}$/.test(process.env[t.env])) {
      console.error(t.env + ' inválido (precisa de 4 dígitos). Abortando sem tocar no banco.');
      process.exit(1);
    }
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const t of todo) {
    const { pin_hash, pin_salt } = hashPin(process.env[t.env]);
    const r = await pool.query(
      `UPDATE v3.persons SET pin_hash=$2, pin_salt=$3, count_exempt=COALESCE($4, count_exempt), updated_at=NOW()
       WHERE id=$1 AND role='operator' RETURNING id, display_name`,
      [t.id, pin_hash, pin_salt, t.count_exempt === undefined ? null : t.count_exempt]);
    if (r.rowCount !== 1) { console.error('FALHOU id=' + t.id + ' (' + t.name + ')'); continue; }
    await pool.query(
      `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
       VALUES ('admin', NULL, 'person.pin_set', 'person', $1, $2::jsonb)`,
      [t.id, JSON.stringify({ via: 'v3-apply-op-pins', rotated: true })]);
    console.log('PIN setado: ' + r.rows[0].display_name + ' (id=' + t.id + ')');
  }
  const chk = await pool.query(
    "SELECT id, display_name, (pin_hash IS NOT NULL) AS has_pin, count_exempt FROM v3.persons WHERE role='operator' ORDER BY id");
  console.log('\nOperadores:');
  chk.rows.forEach((r) => console.log('  id=' + r.id + ' ' + r.display_name + ' pin=' + (r.has_pin ? 'SIM' : 'não') + ' exempt=' + r.count_exempt));
  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
