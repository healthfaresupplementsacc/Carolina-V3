'use strict';
const { Pool } = require('pg');
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = await pool.query("SELECT id, display_name, role, active FROM v3.persons WHERE deleted_at IS NULL ORDER BY id");
  for (const p of r.rows) console.log(`  id=${p.id}  ${p.display_name}  (${p.role})  active=${p.active}`);
  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
