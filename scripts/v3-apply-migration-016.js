'use strict';
/* Aplica migration 016 — v3.llm_metrics.
   Idempotente (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS).
   Rodar: railway run --service ProductionLineService node scripts/v3-apply-migration-016.js */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Check tabela existente antes de aplicar (informativo — apply é idempotente).
  const existsBefore = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'v3' AND table_name = 'llm_metrics'
    ) AS exists`);
  console.log(`v3.llm_metrics existia antes: ${existsBefore.rows[0].exists}`);

  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '016_llm_metrics.sql'),
    'utf8');
  await pool.query(sql);

  const cols = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'v3' AND table_name = 'llm_metrics'
    ORDER BY ordinal_position`);
  console.log('\nv3.llm_metrics columns:');
  for (const c of cols.rows) {
    console.log(`  ${c.column_name.padEnd(34)} ${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}`);
  }

  const fks = await pool.query(`
    SELECT tc.constraint_name, kcu.column_name, ccu.table_schema || '.' || ccu.table_name AS refs, rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'v3' AND tc.table_name = 'llm_metrics'`);
  console.log('\nFKs:');
  for (const f of fks.rows) {
    console.log(`  ${f.column_name} → ${f.refs} (ON DELETE ${f.delete_rule})`);
  }

  const idx = await pool.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'v3' AND tablename = 'llm_metrics' ORDER BY indexname`);
  console.log('\nÍndices:');
  for (const i of idx.rows) console.log(`  ${i.indexname}`);

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
