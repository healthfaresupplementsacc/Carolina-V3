'use strict';
/* Varredura completa 27/mai — read-only.
   (a) open sem F  (b) classificação suspeita  (c) break + trabalho
   (d) duplicados  (e) uncertain                                       */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const D = '2026-05-27';

  console.log('\n══════ (a) EVENTS ABERTOS 27/mai (sem F) ══════');
  const open = await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug AS activity, at.is_background,
           e.started_at AT TIME ZONE 'America/New_York' AS ny_start,
           e.is_long_running,
           pr.canonical_name AS product, pb.batch_number AS batch,
           LEFT(COALESCE(e.description, ''), 80) AS desc_preview
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.ended_at IS NULL AND e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
    ORDER BY p.display_name, e.started_at`, [D]);
  for (const r of open.rows) {
    const bg = r.is_background ? '[bg]' : '[fg]';
    const lr = r.is_long_running ? '[LONG]' : '';
    console.log(`  ev${r.id} ${(r.person || '?').padEnd(15)} ${bg}${lr} ${(r.activity || '?').padEnd(20)} ${r.ny_start.toISOString().slice(11,16)} ${r.product || '?'}/${r.batch || '?'} "${r.desc_preview}"`);
  }
  console.log(`  TOTAL: ${open.rows.length} open`);

  console.log('\n══════ (b) EVENTS suspeitos por descrição/atividade ══════');
  const suspect = await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug AS activity,
           e.started_at AT TIME ZONE 'America/New_York' AS ny_start,
           e.ended_at   AT TIME ZONE 'America/New_York' AS ny_end,
           pr.canonical_name AS product, pb.batch_number AS batch,
           e.cowork_with, e.source_message_ts,
           LEFT(COALESCE(e.description, ''), 120) AS desc_preview
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
      AND (e.description ILIKE '%filtro%' OR e.description ILIKE '%ar-condic%' OR e.description ILIKE '%ar condic%'
        OR e.description ILIKE '%máquin%' OR e.description ILIKE '%maquin%'
        OR e.description ILIKE '%selar%' OR e.description ILIKE '%ajuste%'
        OR e.description ILIKE '%shipment%' OR e.description ILIKE '%FBA%'
        OR e.description ILIKE '%clinic%' OR e.description ILIKE '%inje%'
        OR e.description ILIKE '%tablet%' OR e.description ILIKE '%peneira%'
        OR e.description ILIKE '%Lithium%' OR e.description ILIKE '%manuten%'
        OR e.description ILIKE '%troca%')
    ORDER BY e.started_at`, [D]);
  for (const r of suspect.rows) {
    console.log(`  ev${r.id} ${(r.person || '?').padEnd(15)} ${(r.activity || '?').padEnd(20)} ${r.ny_start.toISOString().slice(11,16)}→${r.ny_end ? r.ny_end.toISOString().slice(11,16) : 'LIVE'} ${r.product || '—'}/${r.batch || '—'} cw=[${r.cowork_with}] "${r.desc_preview}"`);
  }

  console.log('\n══════ (c) ESTADO CONTRADITÓRIO — break + trabalho simultâneos ══════');
  const conflict = await pool.query(`
    WITH metas AS (
      SELECT e.id AS meta_id, e.person_id, p.display_name AS person, at.slug AS meta_slug,
             e.started_at AS meta_start, e.ended_at AS meta_end
      FROM v3.events e
      JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.persons p ON p.id = e.person_id
      WHERE at.category = 'meta' AND e.deleted_at IS NULL
        AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
    )
    SELECT m.meta_id, m.person, m.meta_slug,
           m.meta_start AT TIME ZONE 'America/New_York' AS meta_start_ny,
           m.meta_end AT TIME ZONE 'America/New_York' AS meta_end_ny,
           array_agg(e2.id ORDER BY e2.started_at) AS conflicting_event_ids,
           array_agg(at2.slug ORDER BY e2.started_at) AS conflicting_slugs
    FROM metas m
    JOIN v3.events e2 ON e2.person_id = m.person_id AND e2.deleted_at IS NULL AND e2.id != m.meta_id
    JOIN v3.activity_types at2 ON at2.id = e2.activity_type_id
    WHERE at2.is_background = false AND at2.category != 'meta'
      AND e2.started_at > m.meta_start
      AND (m.meta_end IS NULL OR e2.started_at < m.meta_end)
    GROUP BY m.meta_id, m.person, m.meta_slug, m.meta_start, m.meta_end
    ORDER BY m.meta_start`, [D]);
  if (conflict.rows.length === 0) console.log('  (nenhum conflito)');
  for (const r of conflict.rows) {
    console.log(`  META ev${r.meta_id} ${r.person} ${r.meta_slug} ${r.meta_start_ny.toISOString().slice(11,16)}→${r.meta_end_ny ? r.meta_end_ny.toISOString().slice(11,16) : 'LIVE'}`);
    console.log(`    CONFLITA com fg: [${r.conflicting_event_ids}] (${r.conflicting_slugs})`);
  }

  console.log('\n══════ (d) DUPLICADOS — events com source_message_ts repetido ══════');
  const dup = await pool.query(`
    SELECT source_message_ts, array_agg(id ORDER BY id) AS ids, count(*) AS c
    FROM v3.events
    WHERE deleted_at IS NULL AND source_message_ts IS NOT NULL
      AND (started_at AT TIME ZONE 'America/New_York')::date = $1::date
    GROUP BY source_message_ts
    HAVING count(*) > 1
    ORDER BY source_message_ts`, [D]);
  if (dup.rows.length === 0) console.log('  (sem duplicatas)');
  for (const r of dup.rows) {
    console.log(`  ts=${r.source_message_ts} → ${r.c} events: [${r.ids}]`);
  }

  console.log('\n══════ (e) UNCERTAIN cases 27/mai ══════');
  const unc = await pool.query(`
    SELECT m.id,
           to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York' AS ny_ts,
           p.display_name AS author,
           (m.llm_result->>'uncertain')::boolean AS uncertain,
           m.llm_result->>'uncertainty_reason' AS reason,
           m.llm_result->>'confidence_overall' AS conf,
           m.events_created, m.events_updated,
           LEFT(m.raw_text, 100) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1::date
      AND ((m.llm_result->>'uncertain')::boolean = true
           OR m.llm_result->>'confidence_overall' IN ('low','unconfirmed'))
    ORDER BY m.slack_ts::numeric`, [D]);
  if (unc.rows.length === 0) console.log('  (sem uncertain)');
  for (const r of unc.rows) {
    console.log(`  msg${r.id} ${r.ny_ts.toISOString().slice(11,16)} ${(r.author || '?').padEnd(15)} conf=${r.conf || '?'} unc=${r.uncertain || false} reason="${r.reason || ''}" "${r.txt}"`);
  }

  console.log('\n══════ EVENTOS LITHIUM 0166 27/mai (sequencial?) ══════');
  const lit = await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug AS activity,
           e.started_at AT TIME ZONE 'America/New_York' AS ny_start,
           e.ended_at   AT TIME ZONE 'America/New_York' AS ny_end,
           e.is_long_running,
           LEFT(COALESCE(e.description, ''), 100) AS desc_preview
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.deleted_at IS NULL
      AND (pr.canonical_name ILIKE 'Lithium%' OR e.description ILIKE '%Lithium%')
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
    ORDER BY e.started_at`, [D]);
  for (const r of lit.rows) {
    console.log(`  ev${r.id} ${(r.person || '?').padEnd(15)} ${(r.activity || '?').padEnd(20)} ${r.ny_start.toISOString().slice(11,16)}→${r.ny_end ? r.ny_end.toISOString().slice(11,16) : 'LIVE'} ${r.is_long_running ? '[LONG]' : ''} "${r.desc_preview}"`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
