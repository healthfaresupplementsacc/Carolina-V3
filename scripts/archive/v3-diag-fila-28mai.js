'use strict';
/* Diagnóstico fila/processamento — read-only.
   Q1: fila pendente (llm_processed_at IS NULL) ontem 27/mai + hoje 28/mai
   Q2: erros de processamento recentes
   Q3: ordem de processamento (timestamp vs arrival) + out-of-order risk
   Q4: Simone 28/mai
   Q5: Ana/Vitor/Bruno Sarmento 28/mai
   Q6: worker tick atual
   Q7: é seguro reprocessar?
*/
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const TODAY = '2026-05-28';
  const YDAY  = '2026-05-27';

  // Q6 — worker tick atual
  console.log('══════════════════════════════════════════════════');
  console.log(' Q6. WORKER STATUS');
  console.log('══════════════════════════════════════════════════');
  const wh = await pool.query(`
    SELECT
      (SELECT value FROM v3.settings WHERE key = 'observer_last_tick_at') AS last_tick,
      now() AT TIME ZONE 'America/New_York' AS ny_now,
      (SELECT COUNT(*)::int FROM v3.messages WHERE llm_processed_at IS NULL) AS pending_total`);
  const tickRaw = wh.rows[0].last_tick && JSON.stringify(wh.rows[0].last_tick).replace(/"/g, '');
  console.log('  NY now              :', wh.rows[0].ny_now);
  console.log('  observer_last_tick  :', tickRaw);
  if (tickRaw) {
    const ageSec = (Date.now() - new Date(tickRaw).getTime()) / 1000;
    console.log('  tick_age_seconds    :', Math.round(ageSec), ageSec < 60 ? '✓ ALIVE' : ageSec < 300 ? '⚠ lento' : '❌ MORTO?');
  }
  console.log('  fila TOTAL pending  :', wh.rows[0].pending_total);

  // Q1 — fila pendente, breakdown por dia
  console.log('\n══════════════════════════════════════════════════');
  console.log(' Q1. FILA pendente (llm_processed_at IS NULL) — breakdown');
  console.log('══════════════════════════════════════════════════');
  const pending = await pool.query(`
    SELECT
      (to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York')::date AS ny_day,
      COUNT(*)::int AS pending,
      MIN(TO_CHAR(to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI AM')) AS first_pending,
      MAX(TO_CHAR(to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI AM')) AS last_pending
    FROM v3.messages
    WHERE llm_processed_at IS NULL
    GROUP BY ny_day ORDER BY ny_day DESC`);
  if (pending.rows.length === 0) console.log('  (fila VAZIA — zero msgs pending) ✓');
  for (const r of pending.rows) {
    console.log(`  ${r.ny_day.toISOString().slice(0,10)}: ${r.pending} pending (de ${r.first_pending} até ${r.last_pending})`);
  }

  // Detalhe das pendentes recentes
  console.log('\n  Últimas 20 msgs pending (qualquer dia):');
  const pendDetail = await pool.query(`
    SELECT
      m.id,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_ts,
      m.slack_user_id, p.display_name AS resolved,
      m.processing_error,
      LEFT(m.raw_text, 100) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE m.llm_processed_at IS NULL
    ORDER BY m.slack_ts::numeric DESC LIMIT 20`);
  if (pendDetail.rows.length === 0) console.log('    (vazio)');
  for (const r of pendDetail.rows) {
    console.log(`    msg${r.id} ${r.ny_ts} ${(r.resolved || '?').padEnd(15)} err="${r.processing_error || ''}" "${r.txt}"`);
  }

  // Q2 — erros de ontem/hoje
  console.log('\n══════════════════════════════════════════════════');
  console.log(' Q2. ERROS de processamento (27 + 28 mai)');
  console.log('══════════════════════════════════════════════════');
  const errs = await pool.query(`
    SELECT m.id,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_ts,
      p.display_name AS resolved,
      m.processing_error,
      LEFT(m.raw_text, 110) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE m.processing_error IS NOT NULL
      AND (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date IN ($1::date, $2::date)
    ORDER BY m.slack_ts::numeric`, [YDAY, TODAY]);
  if (errs.rows.length === 0) console.log('  (sem erros 27+28 mai)');
  for (const r of errs.rows) {
    console.log(`  msg${r.id} ${r.ny_ts} ${r.resolved || '?'} err="${r.processing_error}" "${r.txt}"`);
  }

  // Q3 — ordem (timestamp slack vs id incremental)
  console.log('\n══════════════════════════════════════════════════');
  console.log(' Q3. ORDEM cronológica vs ordem de insert');
  console.log('══════════════════════════════════════════════════');
  // Pega últimas 30 msgs e compara ordem por slack_ts vs ordem por id
  const order = await pool.query(`
    WITH last30 AS (
      SELECT id, slack_ts::numeric AS ts,
        to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York' AS ny_ts,
        llm_processed_at, created_at
      FROM v3.messages
      ORDER BY id DESC LIMIT 30
    ),
    ordered AS (
      SELECT id, ts, ny_ts, llm_processed_at, created_at,
        ROW_NUMBER() OVER (ORDER BY ts) AS by_ts_rank,
        ROW_NUMBER() OVER (ORDER BY id) AS by_id_rank
      FROM last30
    )
    SELECT id, TO_CHAR(ny_ts, 'YYYY-MM-DD HH12:MI:SS AM') AS ny_ts,
      created_at, llm_processed_at,
      (by_id_rank - by_ts_rank) AS rank_diff
    FROM ordered ORDER BY id DESC LIMIT 30`);
  console.log('  Últimas 30 msgs (id descendente). rank_diff != 0 = chegada fora de ordem cronológica.');
  for (const r of order.rows) {
    const tag = r.rank_diff !== 0 ? `⚠ rank_diff=${r.rank_diff}` : '';
    console.log(`    msg${r.id} ${r.ny_ts} ${tag}`);
  }

  // Q4 — Simone HOJE
  console.log('\n══════════════════════════════════════════════════');
  console.log(' Q4. SIMONE hoje 28/mai — events + msgs');
  console.log('══════════════════════════════════════════════════');
  // events
  const simEvents = await pool.query(`
    SELECT e.id, at.slug AS activity,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_start,
      TO_CHAR(e.ended_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_end,
      pr.canonical_name AS product, pb.batch_number AS batch,
      LEFT(COALESCE(e.description,''), 90) AS desc
    FROM v3.events e
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.person_id = 5 AND e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
    ORDER BY e.started_at`, [TODAY]);
  console.log(`  Events Simone 28/mai: ${simEvents.rows.length}`);
  for (const r of simEvents.rows) {
    console.log(`    ev${r.id} ${r.ny_start}→${r.ny_end || 'LIVE'} ${r.activity || 'NULL'} ${r.product || '—'}/${r.batch || '—'} "${r.desc}"`);
  }
  // msgs
  const simMsgs = await pool.query(`
    SELECT m.id,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_ts,
      m.llm_processed_at IS NOT NULL AS processed,
      m.processing_error,
      m.events_created, m.events_updated,
      m.person_id, p.display_name AS resolved,
      LEFT(m.raw_text, 140) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1::date
      AND (m.slack_user_id = (SELECT slack_user_id FROM v3.persons WHERE display_name='Simone')
           OR m.person_id = 5
           OR m.raw_text ILIKE '%simone%'
           OR m.raw_text ILIKE '%S:%' OR m.raw_text ILIKE '%S-%')
    ORDER BY m.slack_ts::numeric`, [TODAY]);
  console.log(`\n  Msgs hoje da/sobre Simone (qualquer pattern relevante): ${simMsgs.rows.length}`);
  for (const r of simMsgs.rows) {
    console.log(`    msg${r.id} ${r.ny_ts} processed=${r.processed} resolved=${r.resolved || 'NULL'} err="${r.processing_error || ''}" ev:[${r.events_created || []}+${r.events_updated || []}] "${r.txt}"`);
  }

  // Q5 — Ana / Vitor / Bruno Sarmento hoje
  console.log('\n══════════════════════════════════════════════════');
  console.log(' Q5. Ana / Vitor / Bruno Sarmento hoje 28/mai');
  console.log('══════════════════════════════════════════════════');
  for (const [pid, pname] of [[6, 'Ana'], [4, 'Vitor'], [7, 'Bruno Sarmento']]) {
    const evs = await pool.query(`
      SELECT e.id, at.slug AS activity,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_start,
        TO_CHAR(e.ended_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_end,
        pr.canonical_name AS product, pb.batch_number AS batch,
        LEFT(COALESCE(e.description,''), 80) AS desc
      FROM v3.events e
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      LEFT JOIN v3.products pr ON pr.id = pb.product_id
      WHERE e.person_id = $1 AND e.deleted_at IS NULL
        AND (e.started_at AT TIME ZONE 'America/New_York')::date = $2::date
      ORDER BY e.started_at`, [pid, TODAY]);
    console.log(`\n  ${pname} (id=${pid}): ${evs.rows.length} events`);
    for (const r of evs.rows) {
      console.log(`    ev${r.id} ${r.ny_start}→${r.ny_end || 'LIVE'} ${r.activity || 'NULL'} ${r.product || '—'}/${r.batch || '—'} "${r.desc}"`);
    }
  }

  // Q3 extra — comparação de hora do Slack vs created_at do banco (gap > 5min = chegou atrasado)
  console.log('\n══════════════════════════════════════════════════');
  console.log(' Q3 extra. Latência insert (slack_ts vs created_at) — 27+28/mai');
  console.log('══════════════════════════════════════════════════');
  const lat = await pool.query(`
    SELECT
      (to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York')::date AS ny_day,
      COUNT(*) FILTER (WHERE created_at - to_timestamp(slack_ts::numeric) > interval '5 minutes')::int AS late_5min,
      COUNT(*) FILTER (WHERE created_at - to_timestamp(slack_ts::numeric) > interval '1 hour')::int AS late_1h,
      COUNT(*)::int AS total,
      MAX(EXTRACT(epoch FROM (created_at - to_timestamp(slack_ts::numeric))))::int AS max_lag_sec
    FROM v3.messages
    WHERE (to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York')::date IN ($1::date, $2::date)
    GROUP BY ny_day ORDER BY ny_day DESC`, [YDAY, TODAY]);
  for (const r of lat.rows) {
    const tag = r.late_5min > 0 ? `⚠ ${r.late_5min} msgs chegaram >5min depois do slack_ts` : '';
    console.log(`  ${r.ny_day.toISOString().slice(0,10)}: ${r.total} msgs, ${r.late_5min} late>5min, ${r.late_1h} late>1h, max_lag=${r.max_lag_sec}s ${tag}`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
