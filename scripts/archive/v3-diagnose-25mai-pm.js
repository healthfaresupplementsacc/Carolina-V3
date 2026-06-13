'use strict';
/**
 * DIAGNÓSTICO read-only — investiga "sistema cego depois das 12:15 NY de hoje".
 *
 * Pergunta: A) Observer parou OU B) snapshot congelado/cache.
 *
 * Roda em produção via `railway run node scripts/v3-diagnose-25mai-pm.js`.
 * Usa DATABASE_URL do env do Railway — não imprime nem retorna a string.
 * Saída: SÓ counts, timestamps e previews. Nenhum secret no stdout.
 *
 * NÃO MUTATIVO — só SELECT.
 */

const { Pool } = require('pg');

const NY_DATE = '2026-05-25';                       // dia em investigação
const NY_AFTERNOON_CUT = '12:00:00';                 // tarde = depois disso

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // 0) Sanidade — pinga e mostra hora NY do servidor
  const nowR = await pool.query(`
    SELECT now() AT TIME ZONE 'America/New_York' AS ny_now,
           now()                                  AS utc_now
  `);
  const nowRow = nowR.rows[0];
  console.log('=== AGORA (server) ===');
  console.log('  NY:  ', nowRow.ny_now);
  console.log('  UTC: ', nowRow.utc_now);

  // 1) HEARTBEAT do Observer (v3.settings.observer_last_tick_at)
  const hb = await pool.query(`
    SELECT key, value, updated_at
    FROM v3.settings
    WHERE key IN ('observer_last_tick_at','observer_last_processed_at')
    ORDER BY key
  `);
  console.log('\n=== HEARTBEAT Observer ===');
  for (const r of hb.rows) {
    console.log(`  ${r.key} = ${JSON.stringify(r.value)}  (updated_at: ${r.updated_at})`);
  }
  if (hb.rows.length === 0) console.log('  (sem entradas — Observer nunca ticou ou settings vazio)');

  // 2) MENSAGENS — total, por estado, com cortes
  console.log('\n=== v3.messages — visão geral ===');
  const msgTotals = await pool.query(`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE llm_processed_at IS NOT NULL) AS processed,
      count(*) FILTER (WHERE llm_processed_at IS NULL)     AS pending,
      count(*) FILTER (WHERE processing_error IS NOT NULL) AS errored,
      max(slack_ts::numeric)                              AS max_msg_ts,
      max(llm_processed_at)                                 AS max_proc_at
    FROM v3.messages
  `);
  console.log('  ', msgTotals.rows[0]);

  // 3) Mensagens da TARDE de hoje (NY 12:00+ de 2026-05-25)
  console.log('\n=== v3.messages do dia ' + NY_DATE + ' depois de ' + NY_AFTERNOON_CUT + ' NY ===');
  const msgsPM = await pool.query(`
    WITH boundary AS (
      SELECT EXTRACT(epoch FROM (
        ($1::date + $2::time) AT TIME ZONE 'America/New_York'
      )) AS pm_epoch
    )
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE llm_processed_at IS NOT NULL) AS processed,
      count(*) FILTER (WHERE llm_processed_at IS NULL)     AS pending,
      count(*) FILTER (WHERE processing_error IS NOT NULL) AS errored
    FROM v3.messages m, boundary b
    WHERE m.slack_ts::numeric >= b.pm_epoch
  `, [NY_DATE, NY_AFTERNOON_CUT]);
  console.log('  ', msgsPM.rows[0]);

  // 4) ÚLTIMAS 15 mensagens (qualquer hora) — pra ver se tarde chegou
  console.log('\n=== últimas 15 v3.messages (mais recentes) ===');
  const last = await pool.query(`
    SELECT
      id,
      slack_ts,
      to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York' AS ny_ts,
      CASE WHEN llm_processed_at IS NULL THEN '·pending·' ELSE 'OK' END AS state,
      COALESCE(processing_error, '') AS error,
      LEFT(COALESCE(raw_text, ''), 80) AS preview
    FROM v3.messages
    ORDER BY slack_ts::numeric DESC
    LIMIT 15
  `);
  for (const r of last.rows) {
    console.log(`  id=${r.id} ts=${r.slack_ts} ny=${r.ny_ts.toISOString()} ${r.state} err="${r.error}" :: "${r.preview}"`);
  }

  // 5) EVENTOS do dia
  console.log('\n=== v3.events do dia ' + NY_DATE + ' ===');
  const evDay = await pool.query(`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE ended_at IS NULL) AS live,
      count(*) FILTER (WHERE (started_at AT TIME ZONE 'America/New_York')::time >= $2::time) AS afternoon,
      min(started_at AT TIME ZONE 'America/New_York') AS first_start_ny,
      max(started_at AT TIME ZONE 'America/New_York') AS last_start_ny
    FROM v3.events
    WHERE deleted_at IS NULL
      AND (started_at AT TIME ZONE 'America/New_York')::date = $1::date
  `, [NY_DATE, NY_AFTERNOON_CUT]);
  console.log('  ', evDay.rows[0]);

  // 6) ÚLTIMOS 15 eventos do dia (mais recentes por started_at)
  console.log('\n=== últimos 15 v3.events do dia (mais recentes started_at) ===');
  const lastEvs = await pool.query(`
    SELECT e.id, e.person_id, p.display_name,
           e.started_at AT TIME ZONE 'America/New_York' AS ny_start,
           e.ended_at   AT TIME ZONE 'America/New_York' AS ny_end,
           at.slug AS activity, e.source_message_ts
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
    ORDER BY e.started_at DESC
    LIMIT 15
  `, [NY_DATE]);
  for (const r of lastEvs.rows) {
    console.log(`  ev${r.id} | ${r.display_name} | ${r.ny_start.toISOString()} → ${r.ny_end ? r.ny_end.toISOString() : 'LIVE'} | ${r.activity} | msg_ts=${r.source_message_ts}`);
  }

  // 7) ERROS — quais foram, recentes
  console.log('\n=== últimos 10 v3.messages com processing_error ===');
  const errs = await pool.query(`
    SELECT id, slack_ts,
           to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York' AS ny_ts,
           processing_error,
           LEFT(COALESCE(raw_text, ''), 80) AS preview
    FROM v3.messages
    WHERE processing_error IS NOT NULL
    ORDER BY slack_ts::numeric DESC
    LIMIT 10
  `);
  if (errs.rows.length === 0) console.log('  (sem erros recentes)');
  for (const r of errs.rows) {
    console.log(`  id=${r.id} ny=${r.ny_ts.toISOString()} err="${r.processing_error}" :: "${r.preview}"`);
  }

  // 8) Snapshot endpoint usa /metrics — replica essa query pra ver os "errors:2"
  console.log('\n=== métricas do dia (mesma fonte que /api/v3/data/metrics) ===');
  const metrics = await pool.query(`
    SELECT
      count(*)                                                  AS msgs_total,
      count(*) FILTER (WHERE llm_processed_at IS NOT NULL)      AS processed,
      count(*) FILTER (WHERE processing_error IS NOT NULL)      AS errors,
      count(*) FILTER (WHERE (llm_result->>'confidence') = 'high')   AS conf_high,
      count(*) FILTER (WHERE (llm_result->>'confidence') = 'medium') AS conf_medium,
      count(*) FILTER (WHERE (llm_result->>'confidence') = 'low')    AS conf_low
    FROM v3.messages
    WHERE to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York' BETWEEN
      ($1::date)::timestamp AND ($1::date + interval '1 day')::timestamp
  `, [NY_DATE]);
  console.log('  ', metrics.rows[0]);

  await pool.end();
}

main().then(
  () => process.exit(0),
  (e) => { console.error('DIAG ERROR:', e.message, '\n', e.stack); process.exit(1); },
);
