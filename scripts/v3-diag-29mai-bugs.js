'use strict';
/* DIAG — 29/mai bugs:
   #1. Quais 2 events estão acionando "Eventos inválidos" hoje?
   #2. Vitor 10:04 AM Potassium + Ana 10:44 AM "linha de produção" —
       regra 31 pegou? Estado no banco + llm_result da msg da Ana. */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const TODAY = '2026-05-29';

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' #1 EVENTS HOJE com duração ruim (negativa/zero/aberto-bug)');
  console.log('═══════════════════════════════════════════════════════════');
  const invalids = (await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug AS activity, at.flow,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
      e.started_at, e.ended_at,
      EXTRACT(EPOCH FROM (e.ended_at - e.started_at))::int AS dur_sec,
      pb.batch_number, pr.canonical_name AS product
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
      AND (e.ended_at IS NOT NULL AND e.ended_at <= e.started_at)
    ORDER BY e.started_at`, [TODAY])).rows;
  if (invalids.length === 0) console.log('  ✓ Nenhum event com dur<=0 hoje (procura outro motivo)');
  for (const r of invalids) {
    console.log(`  ⚠ ev${r.id} ${r.person} ${r.activity}/${r.flow} ${r.s}→${r.e_t} dur=${r.dur_sec}s prod=${r.product || '—'}/${r.batch_number || '—'}`);
  }

  console.log('\n  --- E events que caem FORA da janela NY do dia (clampedSeconds=null) ---');
  // bounds NY: 00:00 → 23:59:59 do dia em UTC
  const bounds = (await pool.query(`
    SELECT
      ('${TODAY}'::date AT TIME ZONE 'America/New_York') AS start_utc,
      (('${TODAY}'::date + interval '1 day') AT TIME ZONE 'America/New_York') AS end_utc`)).rows[0];
  console.log(`  bounds NY: ${bounds.start_utc} → ${bounds.end_utc}`);

  const fora = (await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug, at.flow,
      e.started_at, e.ended_at,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS s,
      TO_CHAR(e.ended_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS e_t
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
      AND (e.ended_at IS NOT NULL
        AND (e.ended_at <= e.started_at
          OR e.ended_at <= ('${TODAY}'::date AT TIME ZONE 'America/New_York')
          OR e.started_at >= (('${TODAY}'::date + interval '1 day') AT TIME ZONE 'America/New_York')))
    ORDER BY e.started_at`, [TODAY])).rows;
  if (fora.length === 0) console.log('  ✓ Nenhum event fora da janela');
  for (const r of fora) {
    console.log(`  ⚠ ev${r.id} ${r.person} ${r.slug}/${r.flow} ${r.s}→${r.e_t}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' #2 Vitor 10:04 AM + Ana 10:44 AM — regra 31');
  console.log('═══════════════════════════════════════════════════════════');
  const linha = (await pool.query(`
    SELECT e.id, p.display_name AS person, p.id AS person_id, at.slug,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
      e.product_batch_id, pb.batch_number, pr.canonical_name AS product,
      e.cowork_with, e.source_message_ts, e.confidence,
      LEFT(COALESCE(e.description,''), 120) AS desc
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.deleted_at IS NULL
      AND at.slug IN ('production_line', 'line_changeover')
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
    ORDER BY e.started_at`, [TODAY])).rows;
  console.log(`  ${linha.length} events production_line/line_changeover hoje:`);
  for (const r of linha) {
    console.log(`  ev${r.id} ${r.person} (id=${r.person_id}) ${r.s}→${r.e_t || 'LIVE'} ${r.slug} prod=${r.product || '—'}/${r.batch_number || '—'} cw=${JSON.stringify(r.cowork_with)} conf=${r.confidence}`);
    console.log(`    src_ts=${r.source_message_ts} desc="${r.desc}"`);
  }

  console.log('\n  --- Msgs Slack 10:00-11:00 AM 29/mai ---');
  const msgs = (await pool.query(`
    SELECT m.id, m.slack_user_id, m.slack_ts,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny,
      m.events_created, m.events_updated,
      m.llm_result->>'categorization' AS cat,
      m.llm_result->>'uncertain' AS uncertain,
      m.llm_result->>'uncertainty_reason' AS uncertainty_reason,
      LEFT(m.raw_text, 200) AS txt,
      m.llm_result->'actions' AS actions
    FROM v3.messages m
    WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1
      AND to_timestamp(m.slack_ts::numeric) >= '${TODAY} 10:00:00-04'
      AND to_timestamp(m.slack_ts::numeric) <= '${TODAY} 11:30:00-04'
    ORDER BY m.slack_ts::numeric`, [TODAY])).rows;
  for (const m of msgs) {
    console.log(`\n  msg${m.id} ${m.ny} from=${m.slack_user_id}`);
    console.log(`    "${m.txt}"`);
    console.log(`    events_created=${JSON.stringify(m.events_created || [])} events_updated=${JSON.stringify(m.events_updated || [])}`);
    console.log(`    cat=${m.cat} uncertain=${m.uncertain} reason="${m.uncertainty_reason || ''}"`);
    if (m.actions) console.log(`    actions=${JSON.stringify(m.actions)}`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
