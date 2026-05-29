'use strict';
/* Corrige TZ bug aplicado no ev318. Passei "2026-05-29T12:16:00" sem TZ;
   foi armazenado como UTC, virou 08:16 AM NY (4h antes do started_at 11:29 AM).
   Reaplica com ISO explícito UTC: 12:16 PM NY = 16:16 UTC. */
const { Pool } = require('pg');
const { EventService } = require('../src/v3/services/EventService');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const ev = new EventService({ db: pool });

  const before = (await pool.query(`
    SELECT id, started_at, ended_at,
      TO_CHAR(started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS s_ny,
      TO_CHAR(ended_at   AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS e_ny
    FROM v3.events WHERE id=318`)).rows[0];
  console.log('BEFORE: started_ny=' + before.s_ny + '  ended_ny=' + before.e_ny);
  console.log('  raw UTC: started=' + before.started_at.toISOString() + '  ended=' + before.ended_at.toISOString());

  // 12:16 PM NY = 16:16 UTC durante EDT (UTC-4)
  await ev.correct(318, { ended_at: '2026-05-29T16:16:00Z' }, null,
    'Fix TZ: ended_at anterior ficou em 16:16 UTC interpretado como NY (08:16 NY = neg dur). Reaplica com ISO UTC explícito = 12:16 PM NY. Bloco 29/mai noite.',
    'admin');

  const after = (await pool.query(`
    SELECT id, started_at, ended_at,
      TO_CHAR(started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS s_ny,
      TO_CHAR(ended_at   AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS e_ny
    FROM v3.events WHERE id=318`)).rows[0];
  console.log('AFTER:  started_ny=' + after.s_ny + '  ended_ny=' + after.e_ny);
  console.log('  raw UTC: started=' + after.started_at.toISOString() + '  ended=' + after.ended_at.toISOString());

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
