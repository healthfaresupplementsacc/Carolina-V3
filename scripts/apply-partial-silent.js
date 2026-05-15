'use strict';
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  for (const [k, v] of [['silent_mode','false'],['silent_text','true'],['silent_reactions','false']]) {
    await p.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [k, v]
    );
  }
  const r = await p.query(
    `SELECT key, value, updated_at FROM app_state
     WHERE key IN ('silent_mode','silent_text','silent_reactions')
     ORDER BY key`
  );
  console.table(r.rows);
  await p.end();
})().catch((e) => { console.error(e.message); p.end().catch(()=>{}); process.exit(1); });
