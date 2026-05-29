'use strict';
/* DIAG read-only — incidente do worker 29/mai 17:27+ PM.
   5+ msgs S:/F: deixaram de criar events. Investigar causa-raiz. */
const { Pool } = require('pg');

const TODAY = '2026-05-29';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' 0. Colunas de v3.messages disponíveis');
  console.log('═══════════════════════════════════════════════════════════');
  const cols = (await pool.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='v3' AND table_name='messages'
    ORDER BY ordinal_position`)).rows;
  for (const c of cols) console.log(`  ${c.column_name.padEnd(28)} ${c.data_type}`);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 1. MSGS 724-735 — estado completo');
  console.log('═══════════════════════════════════════════════════════════');
  const msgs = (await pool.query(`
    SELECT m.id, m.slack_user_id, m.slack_ts,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS ny_t,
      m.created_at,
      m.claimed_at,
      m.llm_processed_at,
      m.processing_error,
      m.llm_provider_used,
      m.events_created,
      m.events_updated,
      m.llm_result IS NULL AS llm_null,
      LEFT(m.raw_text, 100) AS txt
    FROM v3.messages m
    WHERE m.id BETWEEN 720 AND 740
    ORDER BY m.id`)).rows;
  for (const m of msgs) {
    console.log(`\n  msg${m.id} ${m.ny_t} slack=${m.slack_user_id}`);
    console.log(`    txt: "${m.txt}"`);
    console.log(`    created_at:       ${m.created_at}`);
    console.log(`    claimed_at:       ${m.claimed_at || 'NULL'}`);
    console.log(`    llm_processed_at: ${m.llm_processed_at || 'NULL'}`);
    console.log(`    llm_result NULL:  ${m.llm_null}`);
    console.log(`    llm_provider:     ${m.llm_provider_used || 'NULL'}`);
    console.log(`    processing_error: ${m.processing_error || 'NULL'}`);
    console.log(`    events_created:   ${JSON.stringify(m.events_created || [])}`);
    console.log(`    events_updated:   ${JSON.stringify(m.events_updated || [])}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 2. Comparativo: msgs 720-723 (que DEU certo) vs 724-735 (deu ruim)');
  console.log('═══════════════════════════════════════════════════════════');
  // Conta quantas msgs no dia foram processadas vs não-processadas, divididas
  // entre antes e depois das 17:27.
  const stats = (await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York' < '${TODAY} 17:27:00-04')::int AS antes_total,
      COUNT(*) FILTER (WHERE to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York' < '${TODAY} 17:27:00-04' AND llm_processed_at IS NULL)::int AS antes_unprocessed,
      COUNT(*) FILTER (WHERE to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York' < '${TODAY} 17:27:00-04' AND processing_error IS NOT NULL)::int AS antes_error,
      COUNT(*) FILTER (WHERE to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York' >= '${TODAY} 17:27:00-04')::int AS depois_total,
      COUNT(*) FILTER (WHERE to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York' >= '${TODAY} 17:27:00-04' AND llm_processed_at IS NULL)::int AS depois_unprocessed,
      COUNT(*) FILTER (WHERE to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York' >= '${TODAY} 17:27:00-04' AND processing_error IS NOT NULL)::int AS depois_error
    FROM v3.messages
    WHERE (to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1`, [TODAY])).rows[0];
  console.log(`  ANTES 17:27 — total=${stats.antes_total} unprocessed=${stats.antes_unprocessed} com_erro=${stats.antes_error}`);
  console.log(`  DEPOIS 17:27 — total=${stats.depois_total} unprocessed=${stats.depois_unprocessed} com_erro=${stats.depois_error}`);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 3. Audit log — eventos LLM/system 17:27-18:30');
  console.log('═══════════════════════════════════════════════════════════');
  const audit = (await pool.query(`
    SELECT id, action, actor_type, created_at,
      LEFT(COALESCE(metadata->>'reason', metadata::text), 100) AS info
    FROM v3.audit_log
    WHERE created_at >= '${TODAY} 17:25:00-04'
      AND created_at <= '${TODAY} 18:30:00-04'
    ORDER BY created_at`)).rows;
  for (const a of audit) {
    console.log(`  ${a.created_at.toISOString()} #${a.id} ${a.action} actor=${a.actor_type}`);
    if (a.info) console.log(`    info: ${a.info}`);
  }
  if (audit.length === 0) console.log('  (nenhum entry)');

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 4. Worker ticks — última msg processada antes do "buraco"');
  console.log('═══════════════════════════════════════════════════════════');
  // Vê llm_processed_at das últimas msgs do dia ordenadas por slack_ts
  const ticks = (await pool.query(`
    SELECT id, slack_ts,
      TO_CHAR(to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS ny_t,
      created_at, claimed_at, llm_processed_at,
      llm_processed_at IS NULL AS unprocessed,
      processing_error
    FROM v3.messages
    WHERE id BETWEEN 715 AND 740
    ORDER BY id`)).rows;
  for (const t of ticks) {
    const flag = t.unprocessed ? '⚠ NÃO PROCESSADA' : '✓';
    console.log(`  ${flag} msg${t.id} slack=${t.ny_t} created=${t.created_at.toISOString()}`);
    console.log(`    claimed=${t.claimed_at?.toISOString() || 'NULL'}  llm_processed=${t.llm_processed_at?.toISOString() || 'NULL'}`);
    if (t.processing_error) console.log(`    err: ${t.processing_error}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 5. Procura por processing_error não-null no dia inteiro');
  console.log('═══════════════════════════════════════════════════════════');
  const errs = (await pool.query(`
    SELECT id, TO_CHAR(to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS ny_t,
      processing_error, claimed_at, llm_processed_at
    FROM v3.messages
    WHERE (to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1
      AND processing_error IS NOT NULL
    ORDER BY id`, [TODAY])).rows;
  if (errs.length === 0) console.log('  ✓ Zero processing_error no dia');
  for (const e of errs) {
    console.log(`  msg${e.id} ${e.ny_t} err: "${e.processing_error}"`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 6. Fila atual / msgs LIVE não-processadas (não só do dia)');
  console.log('═══════════════════════════════════════════════════════════');
  const queue = (await pool.query(`
    SELECT id,
      TO_CHAR(to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS ny_t,
      created_at, claimed_at, llm_processed_at, processing_error,
      LEFT(raw_text, 60) AS txt
    FROM v3.messages
    WHERE llm_processed_at IS NULL
    ORDER BY id DESC
    LIMIT 30`)).rows;
  console.log(`  ${queue.length} msgs llm_processed_at=NULL (mais recentes):`);
  for (const q of queue) {
    console.log(`  msg${q.id} ${q.ny_t} claimed=${q.claimed_at ? 'YES' : 'NO'} err=${q.processing_error || '—'}`);
    console.log(`    "${q.txt}"`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
