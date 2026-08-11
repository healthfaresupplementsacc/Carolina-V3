'use strict';
// Bruno 07-17: pagina "Impressao" no dashboard — persiste o estado FISICO de cada
// impressora (o poller do .28 ja manda transicoes; hoje so ia pro Slack/SSE).
// printer_status = estado atual por impressora; printer_status_log = historico de
// transicoes (vai medir o tempo fisico real quando o canal EPSON entrar).
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  await p.query(`
    CREATE TABLE IF NOT EXISTS v3.printer_status (
      computer     TEXT NOT NULL,
      printer      TEXT NOT NULL,
      status_label TEXT,
      error_label  TEXT,
      ink          JSONB,
      media        JSONB,
      raw          JSONB,
      changed_at   TIMESTAMPTZ,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (computer, printer)
    )`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS v3.printer_status_log (
      id           SERIAL PRIMARY KEY,
      computer     TEXT,
      printer      TEXT,
      status_label TEXT,
      error_label  TEXT,
      at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_printer_status_log_at ON v3.printer_status_log (printer, at DESC)`);
  const a = (await p.query(`SELECT COUNT(*)::int n FROM v3.printer_status`)).rows[0].n;
  const b = (await p.query(`SELECT COUNT(*)::int n FROM v3.printer_status_log`)).rows[0].n;
  console.log('v3.printer_status pronta (linhas:', a + '); v3.printer_status_log pronta (linhas:', b + ')');
})().catch(e => { console.error('ERR', e.message); process.exit(1); }).finally(() => p.end());
