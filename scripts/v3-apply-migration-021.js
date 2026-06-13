'use strict';
/* Aplica migration 021 — dead-letter. Idempotente.
   Rodar: railway run --service ProductionLineService node scripts/v3-apply-migration-021.js */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '021_dead_letter.sql'), 'utf8');
  await pool.query(sql);
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='v3' AND table_name='messages'
      AND column_name IN ('processing_attempts','last_error','last_attempt_at','dead_lettered_at')`);
  console.log('messages colunas novas: ' + cols.rows.map((r) => r.column_name).sort().join(', '));
  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
