'use strict';
/**
 * Diagnóstico 27/mai — read-only.
 *   - catálogo de activity_types (qual slug é "manutenção")
 *   - batch 0158 (rows Graviola vs Licorice + events ligados ao errado)
 *   - eventos da "troca de linha" 9:47-10:59
 *   - varredura geral 27/mai (open events, gaps grandes, msgs sem classificação)
 */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const NY_DATE = '2026-05-27';

  console.log('═══════════════════ CATÁLOGO activity_types ═══════════════════');
  const at = await pool.query(`
    SELECT id, slug, display_name, category, flow, is_background, expected_seconds
    FROM v3.activity_types
    ORDER BY flow, phase_order NULLS LAST, display_name`);
  for (const r of at.rows) {
    console.log(`  id=${String(r.id).padStart(2)}  ${r.slug.padEnd(22)}  ${r.flow || '?'}/${r.category || '?'}  bg=${r.is_background}  expected=${r.expected_seconds || '—'}  "${r.display_name}"`);
  }

  console.log('\n═══════════════════ BATCH 0158 (Graviola/Licorice) ═══════════════════');
  const batches = await pool.query(`
    SELECT pb.id, pb.batch_number, pb.product_id, p.canonical_name AS product,
           pb.created_at, pb.deleted_at,
           (SELECT COUNT(*) FROM v3.events e WHERE e.product_batch_id = pb.id AND e.deleted_at IS NULL) AS event_count
    FROM v3.product_batches pb
    LEFT JOIN v3.products p ON p.id = pb.product_id
    WHERE pb.batch_number = 'BR-2026-0158' OR pb.batch_number = 'BR-2026-0150'
    ORDER BY pb.batch_number, pb.id`);
  for (const r of batches.rows) {
    console.log(`  batch_id=${r.id}  ${r.batch_number}  product=${r.product || '?'} (id=${r.product_id})  events=${r.event_count}  deleted=${r.deleted_at}`);
  }

  console.log('\n═══════════════════ EVENTS apontando batch_id=13 (Graviola 0158 errado) ═══════════════════');
  const ev13 = await pool.query(`
    SELECT e.id, e.person_id, p.display_name AS person, at.slug AS activity,
           e.started_at AT TIME ZONE 'America/New_York' AS ny_start,
           e.ended_at   AT TIME ZONE 'America/New_York' AS ny_end,
           e.description, e.phase_label, e.source_message_ts
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.product_batch_id = 13 AND e.deleted_at IS NULL
    ORDER BY e.started_at`);
  for (const r of ev13.rows) {
    console.log(`  ev${r.id}  ${r.person}  ${r.activity}  ${r.ny_start.toISOString()} → ${r.ny_end ? r.ny_end.toISOString() : 'LIVE'}  desc="${r.description || ''}"`);
  }

  console.log('\n═══════════════════ batch GRAVIOLA "BR-2026-0150" existe? ═══════════════════');
  const grav150 = await pool.query(`
    SELECT pb.id, pb.batch_number, pb.product_id, p.canonical_name
    FROM v3.product_batches pb LEFT JOIN v3.products p ON p.id = pb.product_id
    WHERE p.canonical_name ILIKE 'Graviola%' ORDER BY pb.id`);
  for (const r of grav150.rows) {
    console.log(`  batch_id=${r.id}  ${r.batch_number}  ${r.canonical_name}`);
  }

  console.log('\n═══════════════════ EVENTOS 27/mai (todos) ═══════════════════');
  const ev27 = await pool.query(`
    SELECT e.id, e.person_id, p.display_name AS person, at.slug AS activity,
           e.started_at AT TIME ZONE 'America/New_York' AS ny_start,
           e.ended_at   AT TIME ZONE 'America/New_York' AS ny_end,
           e.is_long_running,
           COALESCE(pb.batch_number, '') AS batch, COALESCE(pr.canonical_name, '') AS product,
           e.cowork_with, e.source_message_ts,
           LEFT(COALESCE(e.description, ''), 60) AS desc_preview
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
      AND e.deleted_at IS NULL
    ORDER BY e.started_at`, [NY_DATE]);
  for (const r of ev27.rows) {
    const cw = r.cowork_with && r.cowork_with.length ? ` cw=[${r.cowork_with.join(',')}]` : '';
    const longTag = r.is_long_running ? ' [LONG]' : '';
    console.log(`  ev${r.id}  ${(r.person || '?').padEnd(15)}  ${(r.activity || '?').padEnd(20)}  ${r.ny_start.toISOString().slice(11, 16)} → ${r.ny_end ? r.ny_end.toISOString().slice(11, 16) : 'LIVE '}  ${r.product || '?'}/${r.batch || '?'}${cw}${longTag} ${r.desc_preview ? '"'+r.desc_preview+'"' : ''}`);
  }

  console.log('\n═══════════════════ MSGS 27/mai com palavras-chave troca/manutenção/descarregar/recebimento ═══════════════════');
  const keywords = await pool.query(`
    SELECT id, slack_ts, p.display_name AS author,
           to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York' AS ny_ts,
           llm_processed_at IS NOT NULL AS processed,
           events_created, events_updated,
           LEFT(raw_text, 140) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE (to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1::date
      AND (raw_text ILIKE '%troca%' OR raw_text ILIKE '%manuten%' OR raw_text ILIKE '%descarreg%'
           OR raw_text ILIKE '%recebimento%' OR raw_text ILIKE '%caminh%')
    ORDER BY slack_ts::numeric`, [NY_DATE]);
  for (const r of keywords.rows) {
    console.log(`  msg${r.id}  ${r.ny_ts.toISOString().slice(11, 16)}  ${(r.author || '?').padEnd(15)}  events:[${r.events_created || []}+${r.events_updated || []}]  "${r.txt}"`);
  }

  console.log('\n═══════════════════ OPEN events 27/mai (ainda sem F) ═══════════════════');
  const open = await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug AS activity,
           e.started_at AT TIME ZONE 'America/New_York' AS ny_start,
           e.is_long_running,
           COALESCE(pb.batch_number, '') AS batch, COALESCE(pr.canonical_name, '') AS product
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.ended_at IS NULL AND e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
    ORDER BY e.started_at`, [NY_DATE]);
  for (const r of open.rows) {
    console.log(`  ev${r.id} OPEN  ${(r.person || '?').padEnd(15)}  ${(r.activity || '?').padEnd(20)}  ${r.ny_start.toISOString().slice(11, 16)}  ${r.product || '?'}/${r.batch || '?'} ${r.is_long_running ? '[LONG]' : ''}`);
  }

  console.log('\n═══════════════════ Uncertain cases 27/mai ═══════════════════');
  const unc = await pool.query(`
    SELECT m.id,
           to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York' AS ny_ts,
           p.display_name AS author,
           (m.llm_result->>'uncertain')::boolean AS uncertain,
           m.llm_result->>'uncertainty_reason' AS reason,
           m.llm_result->>'confidence_overall' AS conf,
           LEFT(m.raw_text, 100) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1::date
      AND ((m.llm_result->>'uncertain')::boolean = true
           OR m.llm_result->>'confidence_overall' IN ('low','unconfirmed'))
    ORDER BY m.slack_ts::numeric`, [NY_DATE]);
  if (unc.rows.length === 0) console.log('  (sem uncertain)');
  for (const r of unc.rows) {
    console.log(`  msg${r.id}  ${r.ny_ts.toISOString().slice(11, 16)}  ${(r.author || '?').padEnd(15)}  conf=${r.conf || '?'} uncertain=${r.uncertain || false}  reason=${r.reason || ''}  "${r.txt}"`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
