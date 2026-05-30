'use strict';
/* DIAG TZ shift +1h no reprocesso pós-incidente Anthropic credit 29/mai.
   Investigação read-only — quais events tem started_at deslocado e por quê. */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // ─── 1. action.started_at emitido pelo LLM pras msgs afetadas ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' 1. LLM action.started_at vs slack_ts da msg (msgs 724/726/727)');
  console.log('═══════════════════════════════════════════════════════════');
  const msgs = (await pool.query(`
    SELECT m.id, m.slack_ts,
      to_timestamp(m.slack_ts::numeric) AS slack_ts_utc,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS slack_ny,
      m.created_at,
      m.llm_processed_at,
      m.llm_result->'actions' AS actions,
      LEFT(m.raw_text, 80) AS txt
    FROM v3.messages m
    WHERE m.id IN (724, 726, 727, 731, 732, 735, 736)
    ORDER BY m.id`)).rows;
  for (const m of msgs) {
    console.log(`\n  msg${m.id} ${m.slack_ny} (slack_ts_utc=${m.slack_ts_utc.toISOString()})`);
    console.log(`    created_at:       ${m.created_at.toISOString()}`);
    console.log(`    llm_processed_at: ${m.llm_processed_at ? m.llm_processed_at.toISOString() : 'NULL'}`);
    console.log(`    raw: "${m.txt}"`);
    if (m.actions && Array.isArray(m.actions)) {
      for (const a of m.actions) {
        console.log(`    action.type=${a.type}`);
        console.log(`      action.started_at  = ${a.started_at}`);
        console.log(`      action.ended_at    = ${a.ended_at}`);
        // Δ entre action.started_at e slack_ts
        if (a.started_at) {
          const startedMs = new Date(a.started_at).getTime();
          const slackMs = m.slack_ts_utc.getTime();
          const deltaMin = (startedMs - slackMs) / 60000;
          console.log(`      Δ(action.started_at − slack_ts) = ${deltaMin > 0 ? '+' : ''}${deltaMin.toFixed(1)}min`);
        }
      }
    }
  }

  // ─── 2. Varredura: events criados HOJE com started_at ≠ slack_ts > 30s ───
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 2. Events criados HOJE com Δ(started_at − slack_ts) > 30s');
  console.log('═══════════════════════════════════════════════════════════');
  // Note: source_message_ts pode ter sufixo '#a0' — strip antes do JOIN.
  const evs = (await pool.query(`
    WITH evs AS (
      SELECT e.id, e.started_at, e.source_message_ts, e.person_id,
        SPLIT_PART(e.source_message_ts, '#', 1) AS base_ts,
        at.slug, p.display_name AS person
      FROM v3.events e
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.persons p ON p.id = e.person_id
      WHERE e.deleted_at IS NULL
        AND (e.started_at AT TIME ZONE 'America/New_York')::date = '2026-05-29'
        AND e.source_message_ts IS NOT NULL
    )
    SELECT evs.*,
      to_timestamp(evs.base_ts::numeric) AS slack_ts_utc,
      EXTRACT(EPOCH FROM (evs.started_at - to_timestamp(evs.base_ts::numeric)))::int AS delta_sec
    FROM evs
    WHERE ABS(EXTRACT(EPOCH FROM (evs.started_at - to_timestamp(evs.base_ts::numeric)))) > 30
    ORDER BY evs.id`)).rows;
  console.log(`  ${evs.length} events com Δ > 30s:\n`);
  for (const e of evs) {
    const slackNy = new Date(e.slack_ts_utc).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
    const startedNy = new Date(e.started_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
    const deltaMin = e.delta_sec / 60;
    console.log(`  ev${e.id} ${e.person} ${e.slug} Δ=${deltaMin > 0 ? '+' : ''}${deltaMin.toFixed(1)}min`);
    console.log(`    slack=${slackNy} NY  started=${startedNy} NY  (base_ts=${e.base_ts})`);
  }

  // ─── 3. Hipótese: LLM emitiu started_at "now"? ───
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 3. Comparação: llm_processed_at vs action.started_at (msgs do incidente)');
  console.log('═══════════════════════════════════════════════════════════');
  const msgs2 = (await pool.query(`
    SELECT m.id, m.llm_processed_at,
      m.slack_ts,
      to_timestamp(m.slack_ts::numeric) AS slack_ts_utc,
      m.llm_result->'actions'->0->>'started_at' AS first_started_at
    FROM v3.messages m
    WHERE m.id IN (724, 726, 727, 731, 732, 735, 736)
    ORDER BY m.id`)).rows;
  for (const m of msgs2) {
    if (!m.first_started_at) continue;
    const startedMs = new Date(m.first_started_at).getTime();
    const procMs = m.llm_processed_at ? m.llm_processed_at.getTime() : null;
    const slackMs = m.slack_ts_utc.getTime();
    const dProc = procMs ? (startedMs - procMs) / 60000 : null;
    const dSlack = (startedMs - slackMs) / 60000;
    console.log(`  msg${m.id}: action.started_at=${m.first_started_at}`);
    console.log(`     Δ(action − llm_processed_at) = ${dProc != null ? (dProc > 0 ? '+' : '') + dProc.toFixed(1) + 'min' : '—'}`);
    console.log(`     Δ(action − slack_ts)         = ${(dSlack > 0 ? '+' : '') + dSlack.toFixed(1) + 'min'}`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
