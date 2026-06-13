'use strict';
/** Diagnóstico TZ — verifica Railway/Node/DB sem mexer em nada. */
const { Pool } = require('pg');
const { nyDate, resolveDate, toNyIso } = require('../src/v3/data/ny-date');

async function main() {
  console.log('=== ENV / Node TZ ===');
  console.log('  process.env.TZ:', JSON.stringify(process.env.TZ));
  console.log('  Date.now() (UTC):', new Date().toISOString());
  console.log('  Local server time string:', new Date().toString());
  console.log('  Intl resolved tz:', Intl.DateTimeFormat().resolvedOptions().timeZone);
  console.log('');
  console.log('=== ny-date.js helpers ===');
  console.log('  nyDate()           →', nyDate());
  console.log("  resolveDate('2026-05-26') →", resolveDate('2026-05-26'));
  console.log("  resolveDate(undefined)    →", resolveDate(undefined));
  console.log("  resolveDate('lixo')       →", resolveDate('lixo'));
  console.log('  toNyIso(new Date()):', toNyIso(new Date()));
  console.log('');

  console.log('=== DB ===');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = await pool.query(`
    SELECT now() AS utc_now,
           now() AT TIME ZONE 'America/New_York' AS ny_now,
           current_setting('TimeZone') AS db_tz
  `);
  console.log('  ', r.rows[0]);

  // Sample event — confirma que started_at é UTC absoluto bem armazenado
  const ev = await pool.query(`
    SELECT id, started_at, started_at AT TIME ZONE 'America/New_York' AS ny_start,
           ended_at,   ended_at   AT TIME ZONE 'America/New_York' AS ny_end
    FROM v3.events
    WHERE deleted_at IS NULL
    ORDER BY started_at DESC
    LIMIT 5
  `);
  console.log('\n  Últimos 5 events (started_at UTC vs NY):');
  for (const row of ev.rows) {
    console.log(`    ev${row.id}: utc=${row.started_at.toISOString()}  ny=${row.ny_start.toISOString()}`);
  }

  // buildSnapshot pra hoje 26/mai
  console.log('\n=== buildSnapshot test ===');
  const { buildRepos, buildSnapshot } = require('../src/v3/data/router');
  const repos = buildRepos(pool);

  for (const d of ['2026-05-26', '2026-05-25', undefined]) {
    const snap = await buildSnapshot(d, repos);
    console.log(`  buildSnapshot(${JSON.stringify(d)}) → data.date='${snap.date}', timeline.date='${snap.timeline.date}', timeline.people.length=${snap.timeline.people.length}`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
