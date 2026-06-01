'use strict';
/* Aplica migration 015 — v3.pending_commands.
   Idempotente (CREATE TABLE IF NOT EXISTS).
   Rodar: railway run --service ProductionLineService node scripts/v3-apply-migration-015.js */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '015_pending_commands.sql'), 'utf8');
  await pool.query(sql);
  const r = await pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'v3' AND table_name = 'pending_commands'
    ORDER BY ordinal_position`);
  console.log('v3.pending_commands columns:');
  for (const c of r.rows) {
    console.log(`  ${c.column_name.padEnd(22)} ${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}`);
  }
  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
