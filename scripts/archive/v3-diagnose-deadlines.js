'use strict';
const { Pool } = require('pg');
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = await pool.query('SELECT id, flow, label, kind, time_of_day, weekdays, active FROM v3.deadlines ORDER BY id');
  console.log('v3.deadlines:');
  for (const row of r.rows) console.log(' ', row);
  if (r.rows.length === 0) console.log('  (vazio)');
  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
