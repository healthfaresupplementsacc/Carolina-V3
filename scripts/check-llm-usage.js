'use strict';
// Quantas chamadas de LLM por dia o sistema faz de verdade? (base p/ dimensionar free tiers)
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const daily = await p.query(
    `SELECT to_char(created_at AT TIME ZONE 'America/New_York','MM-DD') AS dia,
            COUNT(*)::int AS chamadas,
            COUNT(*) FILTER (WHERE provider ILIKE '%gemini%')::int AS gemini,
            SUM(input_tokens)::bigint AS tok_in, SUM(output_tokens)::bigint AS tok_out
     FROM v3.llm_metrics WHERE created_at > NOW() - INTERVAL '10 days'
     GROUP BY 1 ORDER BY 1`);
  console.log('Chamadas LLM por dia (10 dias):');
  daily.rows.forEach((r) => console.log(`  ${r.dia}: ${r.chamadas} chamadas (${r.gemini} gemini) · ${r.tok_in} in / ${r.tok_out} out tokens`));
  const dead = await p.query("SELECT COUNT(*)::int n FROM v3.messages WHERE dead_lettered_at > NOW() - INTERVAL '2 days'");
  console.log('Dead-letters (48h):', dead.rows[0].n);
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
