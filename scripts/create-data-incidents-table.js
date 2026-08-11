'use strict';
// Bruno 07-23: incidentes de DADOS (duplicata de contagem etc). Alimenta a caixa
// URGENTE do dashboard + relatório detalhado (o quê/onde/canal/foi-falta-de-atenção).
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  await p.query(`
    CREATE TABLE IF NOT EXISTS v3.data_incidents (
      id           SERIAL PRIMARY KEY,
      kind         TEXT NOT NULL,            -- 'duplicate_count' | ...
      severity     TEXT NOT NULL DEFAULT 'warning',  -- info|warning|urgent
      title        TEXT NOT NULL,
      explanation  TEXT NOT NULL,            -- o que aconteceu, em texto claro pro Bruno
      diagnosis    TEXT,                     -- "foi falta de atenção" | "erro de sistema no X" etc
      where_json   JSONB,                    -- onde/como (canal, event_id, person, ts, o que fizeram)
      person_id    INT,
      product_id   INT,
      amount       INT,                      -- qtd envolvida (bottles)
      status       TEXT NOT NULL DEFAULT 'open',  -- open|resolved|dismissed
      auto_fixed   BOOLEAN NOT NULL DEFAULT false, -- o sistema já corrigiu sozinho?
      related_count_ids INT[],
      resolved_by  INT,
      resolved_at  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_data_incidents_open ON v3.data_incidents (status, created_at DESC) WHERE status='open'`);
  const n=(await p.query(`SELECT COUNT(*)::int n FROM v3.data_incidents`)).rows[0].n;
  console.log('v3.data_incidents pronta. linhas:', n);
})().catch(e => { console.error('ERR', e.message); process.exit(1); }).finally(() => p.end());
