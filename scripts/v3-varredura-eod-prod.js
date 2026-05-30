'use strict';
/* Varredura read-only — end_of_day events em prod com ended_at != started_at.
   Quem foi pego pelo bug antigo (meta_closed_by_fg do dia seguinte etc). */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' end_of_day events com ended_at != started_at ou ended_at NULL');
  console.log('═══════════════════════════════════════════════════════════');
  const r = (await pool.query(`
    SELECT e.id, e.person_id, p.display_name AS person,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS s_ny,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS e_ny,
      e.started_at, e.ended_at, e.deleted_at IS NOT NULL AS deleted,
      e.closed_reason,
      LEFT(COALESCE(e.description,''), 100) AS desc,
      EXTRACT(EPOCH FROM (e.ended_at - e.started_at))::int AS dur_sec
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE at.slug = 'end_of_day'
      AND (e.ended_at IS NULL OR e.ended_at != e.started_at)
    ORDER BY e.started_at DESC`)).rows;

  if (r.length === 0) {
    console.log('  ✓ Nenhum end_of_day com bug detectado em prod.');
  } else {
    console.log(`  ${r.length} end_of_day(s) com ended_at != started_at:`);
    for (const e of r) {
      const status = e.deleted ? '(DEL)' : (e.ended_at == null ? 'LIVE' : `dur=${e.dur_sec}s`);
      console.log(`\n  ev${e.id} ${e.person} ${status}`);
      console.log(`    started: ${e.s_ny}`);
      console.log(`    ended:   ${e.e_ny || 'NULL'}`);
      console.log(`    closed_reason: ${e.closed_reason || 'NULL'}`);
      console.log(`    desc: "${e.desc}"`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' end_of_day events íntegros (ended_at = started_at)');
  console.log('═══════════════════════════════════════════════════════════');
  const ok = (await pool.query(`
    SELECT COUNT(*)::int AS c FROM v3.events e
    JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE at.slug = 'end_of_day'
      AND e.ended_at = e.started_at
      AND e.deleted_at IS NULL`)).rows[0];
  console.log(`  ${ok.c} end_of_day(s) íntegros (carimbo instantâneo correto)`);

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
