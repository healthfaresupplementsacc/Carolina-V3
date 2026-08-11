'use strict';
// Bruno 07-17: tempo FÍSICO real da impressão (PR→IL do ESC/Label ~H(SMA,S) —
// distinto de duration_sec (spooler) e session_active_sec (teclado/mouse).
// Preenchido quando o leitor do .28 detecta a impressora sair de imprimindo→ociosa.
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  await p.query(`ALTER TABLE v3.print_jobs ADD COLUMN IF NOT EXISTS print_seconds INT`);
  await p.query(`ALTER TABLE v3.print_jobs ADD COLUMN IF NOT EXISTS phys_started_at TIMESTAMPTZ`);
  await p.query(`ALTER TABLE v3.print_jobs ADD COLUMN IF NOT EXISTS phys_ended_at TIMESTAMPTZ`);
  const c = (await p.query(`SELECT COUNT(*)::int n FROM v3.print_jobs WHERE print_seconds IS NOT NULL`)).rows[0].n;
  console.log('print_jobs: colunas print_seconds/phys_started_at/phys_ended_at OK. com físico:', c);
})().catch(e => { console.error('ERR', e.message); process.exit(1); }).finally(() => p.end());
