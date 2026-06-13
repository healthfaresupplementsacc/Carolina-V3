'use strict';
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '014_material_handling.sql'), 'utf8');
  await pool.query(sql);
  const r = await pool.query(`SELECT id, slug, display_name, category, flow, is_background, active FROM v3.activity_types WHERE slug = 'material_handling'`);
  console.log(' ', r.rows[0]);
  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
