'use strict';
// Bruno 07-16: registra cada job de impressao do PC .28 (Estacao de Impressao).
// Alimenta a task "Impressao de Labels" + o futuro Supplement Control System.
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  await p.query(`
    CREATE TABLE IF NOT EXISTS v3.print_jobs (
      id             SERIAL PRIMARY KEY,
      computer       TEXT,
      job_id         TEXT,
      job_ts         BIGINT,
      document       TEXT,
      printer        TEXT,
      win_user       TEXT,
      operator       TEXT,
      pages          INT,
      copies         INT,
      sheets         INT,
      size_bytes     BIGINT,
      submitted_at   TIMESTAMPTZ,
      completed_at   TIMESTAMPTZ,
      duration_sec   INT,
      session_active_sec INT,
      product_id     INT REFERENCES v3.products(id),
      product_batch_id INT REFERENCES v3.product_batches(id),
      label_event_id BIGINT,
      person_id      INT REFERENCES v3.persons(id),
      has_batch      BOOLEAN,
      status         TEXT,
      error          TEXT,
      raw            JSONB,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_print_jobs_dedup ON v3.print_jobs (computer, job_id) WHERE job_id IS NOT NULL`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_created ON v3.print_jobs (created_at DESC)`);
  const c = (await p.query(`SELECT COUNT(*)::int n FROM v3.print_jobs`)).rows[0].n;
  console.log('v3.print_jobs pronta. linhas:', c);
})().catch(e => { console.error('ERR', e.message); process.exit(1); }).finally(() => p.end());
