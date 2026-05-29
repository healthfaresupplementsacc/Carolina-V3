'use strict';
/* DIAG — fim de expediente Bruno Sarmento 28/mai (regra end_of_day).
   Read-only. Lista o estado de ev305 + todos os events do Bruno Sarmento
   que ainda estão LIVE, separando fg vs bg long_running. */
const { Pool } = require('pg');

const BRUNO_SARMENTO_PERSON_ID = 7;
const TODAY = '2026-05-28';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' 1. ev305 — estado atual');
  console.log('═══════════════════════════════════════════════════════════');
  const ev305 = (await pool.query(`
    SELECT e.id, e.person_id, p.display_name AS person, at.slug AS activity,
      at.flow, at.is_background, e.is_long_running,
      e.started_at, e.ended_at, e.closed_reason,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_start,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_end,
      EXTRACT(EPOCH FROM (COALESCE(e.ended_at, NOW()) - e.started_at))::int AS dur_sec,
      LEFT(COALESCE(e.description,''), 100) AS desc
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.id = 305`)).rows[0];
  if (!ev305) console.log('  ev305 não existe');
  else {
    console.log(`  ev305 ${ev305.person} (id=${ev305.person_id})`);
    console.log(`    ${ev305.activity}/${ev305.flow} bg=${ev305.is_background} long_running=${ev305.is_long_running}`);
    console.log(`    started: ${ev305.ny_start}`);
    console.log(`    ended  : ${ev305.ny_end || 'NULL (LIVE)'}`);
    console.log(`    duração atual: ${Math.floor(ev305.dur_sec / 3600)}h${Math.floor((ev305.dur_sec % 3600) / 60)}m`);
    console.log(`    closed_reason: ${ev305.closed_reason || 'NULL'}`);
    console.log(`    desc: "${ev305.desc}"`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 2. Bruno Sarmento 28/mai — TODOS events (fg vs bg vs long_running)');
  console.log('═══════════════════════════════════════════════════════════');
  const evs = (await pool.query(`
    SELECT e.id, at.slug, at.is_background, e.is_long_running, at.flow,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
      e.ended_at IS NULL AS live,
      pb.batch_number, pr.canonical_name AS product
    FROM v3.events e
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.person_id = $1 AND e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $2
    ORDER BY e.started_at`, [BRUNO_SARMENTO_PERSON_ID, TODAY])).rows;
  for (const r of evs) {
    const kind = r.is_long_running ? '[LONG_RUN]' : (r.is_background ? '[bg]' : '[fg]');
    const status = r.live ? '⚠ LIVE' : '✓ fechado';
    console.log(`  ev${r.id} ${kind} ${status} ${r.s}→${r.e_t || 'NULL'} ${r.slug}/${r.flow} ${r.product ? `(${r.product}/${r.batch_number})` : ''}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 3. Events LIVE de outras pessoas 28/mai (varredura geral)');
  console.log('═══════════════════════════════════════════════════════════');
  const others = (await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug, at.is_background, e.is_long_running, at.flow,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.deleted_at IS NULL AND e.ended_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
      AND e.person_id != $2
    ORDER BY p.display_name, e.started_at`, [TODAY, BRUNO_SARMENTO_PERSON_ID])).rows;
  if (others.length === 0) console.log('  ✓ nenhum');
  else {
    for (const r of others) {
      const kind = r.is_long_running ? '[LONG_RUN]' : (r.is_background ? '[bg]' : '[fg]');
      console.log(`  ev${r.id} ${kind} ${r.person} ${r.s}→LIVE ${r.slug}/${r.flow}`);
    }
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
