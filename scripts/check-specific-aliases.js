'use strict';
const { Pool } = require('pg');
const parser = require('../src/parser');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const CANDIDATES = [
  { canonical: 'Apple Cider Vinegar', alias: 'apple cider' },
  { canonical: 'Apple Cider Vinegar', alias: 'cider' },
  { canonical: 'Potassium Iodide',    alias: 'potassium' },
  { canonical: 'Potassium Iodide',    alias: 'potassio' },
  { canonical: '???', alias: 'citrus' },
  { canonical: '???', alias: 'feminiva' },
  { canonical: '???', alias: 'injecoes' },
  { canonical: '???', alias: 'bottle preto' },
  { canonical: '???', alias: 'black bottle' },
];

(async () => {
  for (const c of CANDIDATES) {
    const r = await p.query(
      `SELECT slack_ts, text FROM messages
       WHERE created_at >= NOW() - INTERVAL '30 days'
         AND text ILIKE $1
       ORDER BY slack_ts DESC LIMIT 4`,
      [`%${c.alias}%`]
    );
    console.log(`\n=== "${c.alias}" → propose canonical: ${c.canonical} === (${r.rows.length} matches, top 4):`);
    for (const row of r.rows) {
      // Does the parser already match it?
      const matched = parser.extractSupplement(row.text);
      console.log(`  [parser sees: ${matched || 'NONE'}] ${row.text.slice(0, 120).replace(/\n/g, ' ')}`);
    }
  }
  await p.end();
})().catch((e) => { console.error(e.message); p.end().catch(() => {}); process.exit(1); });
