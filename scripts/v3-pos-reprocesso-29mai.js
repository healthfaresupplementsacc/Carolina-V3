'use strict';
/* Verifica o que nasceu/atualizou após reprocesso. */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Msgs 721-740 — events criados/atualizados pós-reprocesso');
  console.log('═══════════════════════════════════════════════════════════');
  const msgs = (await pool.query(`
    SELECT m.id, m.slack_user_id,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS ny_t,
      m.events_created, m.events_updated,
      m.llm_result->>'categorization' AS cat,
      m.llm_processed_at,
      LEFT(m.raw_text, 100) AS txt
    FROM v3.messages m
    WHERE m.id BETWEEN 721 AND 740
    ORDER BY m.id`)).rows;
  for (const m of msgs) {
    const evs = [...(m.events_created || []), ...(m.events_updated || [])];
    const status = m.llm_processed_at ? (evs.length > 0 ? '✓ event' : '─ no event') : '⚠ não processada';
    console.log(`\n  ${status} msg${m.id} ${m.ny_t} cat=${m.cat || '—'} ev=[${evs.join(',')}]`);
    console.log(`    "${m.txt}"`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Events 329+ — nascidos pós-reprocesso');
  console.log('═══════════════════════════════════════════════════════════');
  const evs = (await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug, at.flow,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS s,
      TO_CHAR(e.ended_at AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS e_t,
      e.closed_reason, e.confidence, e.source_message_ts,
      e.deleted_at IS NOT NULL AS deleted,
      pr.canonical_name AS product, pb.batch_number,
      LEFT(COALESCE(e.description,''), 100) AS desc
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.id >= 329 AND (e.started_at AT TIME ZONE 'America/New_York')::date = '2026-05-29'
    ORDER BY e.id`)).rows;
  for (const r of evs) {
    console.log(`\n  ev${r.id}${r.deleted ? ' (DEL)' : ''} ${r.s}→${r.e_t || 'LIVE'} ${r.person} ${r.slug}/${r.flow}`);
    console.log(`    product=${r.product || '—'}/${r.batch_number || '—'} conf=${r.confidence} src=${r.source_message_ts}`);
    console.log(`    closed=${r.closed_reason || '—'} desc: "${r.desc}"`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Estado final da fila (msgs ainda em LIMBO)');
  console.log('═══════════════════════════════════════════════════════════');
  const queue = (await pool.query(`
    SELECT id,
      TO_CHAR(to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS ny_t,
      claimed_at, llm_processed_at, processing_error,
      LEFT(raw_text, 50) AS txt
    FROM v3.messages
    WHERE llm_processed_at IS NULL
    ORDER BY id`)).rows;
  if (queue.length === 0) console.log('  ✓ Fila totalmente vazia.');
  for (const q of queue) console.log(`  msg${q.id} ${q.ny_t} claim=${q.claimed_at ? 'Y' : 'N'} err=${q.processing_error || '—'} | ${q.txt}`);

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
