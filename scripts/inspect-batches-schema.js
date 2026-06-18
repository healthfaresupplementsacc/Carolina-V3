'use strict';
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const cols = await pool.query(`SELECT column_name, data_type, is_nullable, column_default
                                 FROM information_schema.columns
                                 WHERE table_schema='v3' AND table_name='product_batches'
                                 ORDER BY ordinal_position`);
  console.log('=== v3.product_batches ===');
  cols.rows.forEach((c) => console.log(`  ${c.column_name} ${c.data_type} ${c.is_nullable === 'NO' ? 'NOT NULL' : ''} ${c.column_default ? 'DEFAULT ' + c.column_default : ''}`));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
