'use strict';
/**
 * HEALTHFARE V3 — FIX 4 (pós-shadow 21/mai) — re-processa o dia.
 *
 * Depois do FIX 1 (prompt S:/F:) deployado e do FIX 2 (aliases)
 * aplicado, re-processa TODAS as mensagens de hoje (NY) — o worker
 * re-resolve o autor com os fixes. Resolve a mis-atribuição das
 * "S:" do Vitor que viraram Simone.
 *
 * Remove events/counts órfãos por source_message_ts; idempotência
 * protege. Throttle do FIX C evita 429.
 *
 *   railway run ... node scripts/v3-fix4-reprocess-today.js [YYYY-MM-DD]
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

function nyDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

async function evByPerson(client, date) {
  return (await client.query(
    `SELECT pe.display_name, COUNT(*) n
     FROM v3.events e LEFT JOIN v3.persons pe ON pe.id = e.person_id
     WHERE e.deleted_at IS NULL AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
     GROUP BY pe.display_name ORDER BY n DESC`, [date])).rows;
}

async function main() {
  const date = process.argv[2] || nyDate();
  const pool = makeV3Pool();
  const client = await pool.connect();
  try {
    console.log(`==== V3 FIX 4 — re-processar o dia ${date} ====`);

    const before = await evByPerson(client, date);
    console.log('events por pessoa ANTES:', before.map((r) => `${r.display_name}:${r.n}`).join(' ') || '(nenhum)');

    const set = (await client.query(
      `SELECT id, slack_ts FROM v3.messages
       WHERE (created_at AT TIME ZONE 'America/New_York')::date = $1 ORDER BY created_at`, [date])).rows;
    const ids = set.map((r) => r.id);
    const tsList = set.map((r) => r.slack_ts);
    console.log(`mensagens de ${date} a re-processar: ${ids.length}`);
    if (!ids.length) { console.log('nada a fazer.'); return; }

    await client.query('BEGIN');
    const delEv = await client.query(
      'DELETE FROM v3.events WHERE source_message_ts = ANY($1) RETURNING id', [tsList]);
    const delCt = await client.query(
      `DELETE FROM v3.production_counts WHERE split_part(source_message_ts,'#',1) = ANY($1) RETURNING id`, [tsList]);
    await client.query(
      `UPDATE v3.messages SET llm_processed_at = NULL, claimed_at = NULL, processing_error = NULL,
         llm_result = NULL, llm_provider_used = NULL, events_created = '{}', events_updated = '{}'
       WHERE id = ANY($1)`, [ids]);
    await client.query(
      `INSERT INTO v3.audit_log (actor_type, action, target_type, after_data)
       VALUES ('system','fix4.reprocess_today','message',$1::jsonb)`,
      [JSON.stringify({ date, messages: ids.length, events_removed: delEv.rowCount, counts_removed: delCt.rowCount })]);
    await client.query('COMMIT');
    console.log(`events removidos: ${delEv.rowCount} | counts removidos: ${delCt.rowCount} | ${ids.length} resetadas`);

    let waited = 0;
    let pending = ids.length;
    while (pending > 0 && waited < 600) {
      await new Promise((res) => setTimeout(res, 10000));
      waited += 10;
      pending = parseInt((await client.query(
        'SELECT COUNT(*) c FROM v3.messages WHERE id = ANY($1) AND llm_processed_at IS NULL', [ids])).rows[0].c, 10);
      if (waited % 30 === 0 || pending === 0) console.log(`  ...drenando: ${pending} (${waited}s)`);
    }

    const after = await evByPerson(client, date);
    const proc = (await client.query(
      `SELECT COALESCE(SUM((llm_result->>'cost_estimate_usd')::numeric),0) cost
       FROM v3.messages WHERE id = ANY($1) AND llm_processed_at IS NOT NULL`, [ids])).rows[0];
    const err = (await client.query(
      'SELECT COUNT(*) c FROM v3.messages WHERE id = ANY($1) AND processing_error IS NOT NULL', [ids])).rows[0].c;

    console.log('\n==== FIX 4 REPORT ====');
    console.log(`re-processadas: ${ids.length - pending}/${ids.length}` + (pending ? ` (${pending} na fila!)` : ''));
    console.log(`custo: $${Number(proc.cost).toFixed(4)} | com erro: ${err}`);
    console.log('events por pessoa DEPOIS:', after.map((r) => `${r.display_name}:${r.n}`).join(' ') || '(nenhum)');
    const vitor = after.find((r) => r.display_name === 'Vitor');
    console.log(vitor ? `✓ Vitor com ${vitor.n} event(s) no timeline` : '⚠️ Vitor ainda sem events — investigar');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* */ }
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main();
