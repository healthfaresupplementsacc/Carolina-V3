'use strict';
/* Aplica migration 020 — v3.dedupe_links. Idempotente.
   Rodar: railway run --service ProductionLineService node scripts/v3-apply-migration-020.js */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '020_dedupe_links.sql'), 'utf8');
  await pool.query(sql);
  const r = await pool.query("SELECT to_regclass('v3.dedupe_links') AS t");
  console.log('v3.dedupe_links: ' + (r.rows[0].t ? 'OK' : 'AUSENTE!'));
  const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='v3' AND table_name='dedupe_links' ORDER BY ordinal_position");
  console.log('colunas: ' + cols.rows.map((x) => x.column_name).join(', '));
  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
