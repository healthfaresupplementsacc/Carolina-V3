'use strict';
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await p.query(`
    SELECT m.slack_ts, m.user_name, m.text AS msg_text, m.parsed_type,
           (m.created_at AT TIME ZONE 'America/New_York')::date AS et_date
    FROM messages m
    WHERE m.created_at >= NOW() - INTERVAL '14 days'
      AND m.text ~* 'transform'
    ORDER BY m.slack_ts DESC
    LIMIT 18
  `);
  for (const row of r.rows) {
    console.log('---');
    console.log(`[${row.et_date}] (${row.parsed_type || '-'}) ${row.user_name}: ${row.msg_text.replace(/\n/g, ' ').slice(0, 260)}`);
  }
  console.log(`\nTotal matches: ${r.rows.length}`);
  await p.end();
})().catch((e) => { console.error('FATAL:', e.message); p.end().catch(()=>{}); process.exit(1); });
