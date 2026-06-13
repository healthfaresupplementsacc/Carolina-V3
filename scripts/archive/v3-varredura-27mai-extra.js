'use strict';
const { Pool } = require('pg');
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const D = '2026-05-27';

  console.log('\n══════ Bruno Sarmento TODOS events 27/mai ══════');
  const bruno = await pool.query(`
    SELECT e.id, at.slug AS activity, at.category, at.is_background,
           e.started_at AT TIME ZONE 'America/New_York' AS ny_start,
           e.ended_at AT TIME ZONE 'America/New_York' AS ny_end,
           e.is_long_running,
           pr.canonical_name AS product, pb.batch_number AS batch,
           e.cowork_with,
           LEFT(COALESCE(e.description, ''), 80) AS desc
    FROM v3.events e
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.person_id = 7 AND e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
    ORDER BY e.started_at`, [D]);
  for (const r of bruno.rows) {
    const flag = r.category === 'meta' ? '[META]' : r.is_background ? '[bg]' : '[fg]';
    const lr = r.is_long_running ? '[LONG]' : '';
    console.log(`  ev${r.id} ${flag}${lr} ${(r.activity || '?').padEnd(20)} ${r.ny_start.toISOString().slice(11,16)}→${r.ny_end ? r.ny_end.toISOString().slice(11,16) : 'LIVE'} ${r.product || '—'}/${r.batch || '—'} cw=[${r.cowork_with}] "${r.desc}"`);
  }

  console.log('\n══════ Vitor TODOS events 27/mai ══════');
  const vitor = await pool.query(`
    SELECT e.id, at.slug AS activity, at.category, at.is_background,
           e.started_at AT TIME ZONE 'America/New_York' AS ny_start,
           e.ended_at AT TIME ZONE 'America/New_York' AS ny_end,
           pr.canonical_name AS product, pb.batch_number AS batch,
           e.cowork_with,
           LEFT(COALESCE(e.description, ''), 80) AS desc
    FROM v3.events e
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.person_id = 4 AND e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
    ORDER BY e.started_at`, [D]);
  for (const r of vitor.rows) {
    const flag = r.category === 'meta' ? '[META]' : r.is_background ? '[bg]' : '[fg]';
    console.log(`  ev${r.id} ${flag} ${(r.activity || '?').padEnd(20)} ${r.ny_start.toISOString().slice(11,16)}→${r.ny_end ? r.ny_end.toISOString().slice(11,16) : 'LIVE'} ${r.product || '—'}/${r.batch || '—'} cw=[${r.cowork_with}] "${r.desc}"`);
  }

  console.log('\n══════ Msgs 14:45-15:30 (Vitor pausa máquina selar) ══════');
  const msgs = await pool.query(`
    SELECT m.id, to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York' AS ny_ts,
           p.display_name AS author, m.events_created, m.events_updated,
           LEFT(m.raw_text, 140) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1::date
      AND m.slack_ts::numeric BETWEEN
        EXTRACT(epoch FROM ($1::date + time '14:30') AT TIME ZONE 'America/New_York')
        AND EXTRACT(epoch FROM ($1::date + time '15:35') AT TIME ZONE 'America/New_York')
    ORDER BY m.slack_ts::numeric`, [D]);
  for (const r of msgs.rows) {
    console.log(`  msg${r.id} ${r.ny_ts.toISOString().slice(11,16)} ${(r.author || '?').padEnd(15)} ev:[${r.events_created || []}+${r.events_updated || []}] "${r.txt}"`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
