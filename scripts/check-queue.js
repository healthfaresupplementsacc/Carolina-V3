'use strict';
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await p.query(
    `SELECT COUNT(*) FILTER (WHERE llm_processed_at IS NULL AND dead_lettered_at IS NULL)::int AS fila,
            COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS mortas,
            COUNT(*) FILTER (WHERE llm_processed_at > NOW() - INTERVAL '5 minutes')::int AS processadas_5min
     FROM v3.messages WHERE created_at > NOW() - INTERVAL '72 hours'`);
  console.log('fila:', r.rows[0].fila, '| dead-letter:', r.rows[0].mortas, '| processadas nos últimos 5min:', r.rows[0].processadas_5min);
  const prov = await p.query(
    `SELECT provider, model, COUNT(*)::int n FROM v3.llm_metrics WHERE created_at > NOW() - INTERVAL '10 minutes' GROUP BY provider, model`);
  prov.rows.forEach((x) => console.log('  chamadas 10min:', x.provider, x.model, '×' + x.n));
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
