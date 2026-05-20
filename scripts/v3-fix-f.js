'use strict';
/**
 * HEALTHFARE V3 — FIX F (pós-backfill §2.13) — re-processar falhas.
 *
 * Depois de A-E (claim, throttle, admins, cross-account) e B (catálogo
 * completo), re-processa as mensagens que deram unclear/unconfirmed/low
 * no backfill — agora com catálogo de 64 produtos e prompts corrigidos.
 *
 * Passos:
 *   1. seleciona o set: llm_processed_at preenchido E
 *      (confidence_overall ∈ {low,unconfirmed} OU categorization=unclear)
 *   2. remove events/production_counts órfãos desse set (por
 *      source_message_ts) — transação única
 *   3. zera llm_processed_at/claimed_at/llm_result → o worker SHADOW
 *      re-processa (claim do FIX A + throttle do FIX C)
 *   4. espera a fila drenar e imprime o relatório comparativo
 *
 * Idempotente: re-rodar só re-seleciona o que voltou a ser low/unconf.
 *
 *   railway run ... node scripts/v3-fix-f.js
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

const REPROCESS_WHERE = `llm_processed_at IS NOT NULL
  AND ( llm_result->>'confidence_overall' IN ('low','unconfirmed')
        OR llm_result->>'categorization' = 'unclear' )`;

async function main() {
  const pool = makeV3Pool();
  const client = await pool.connect();
  try {
    console.log('==== V3 FIX F — re-processar unclear/unconfirmed/low ====');

    // ── 1. set a re-processar ──
    const set = (await client.query(
      `SELECT id, slack_ts FROM v3.messages WHERE ${REPROCESS_WHERE} ORDER BY created_at`)).rows;
    const ids = set.map((r) => r.id);
    const tsList = set.map((r) => r.slack_ts);
    console.log(`mensagens a re-processar: ${ids.length}`);
    if (ids.length === 0) {
      console.log('nada a fazer — zero mensagens low/unconfirmed/unclear.');
      return;
    }

    // ── 2. remove events/counts órfãos do set (transação) ──
    await client.query('BEGIN');
    const delEv = await client.query(
      'DELETE FROM v3.events WHERE source_message_ts = ANY($1) RETURNING id', [tsList]);
    const delCt = await client.query(
      `DELETE FROM v3.production_counts
       WHERE split_part(source_message_ts, '#', 1) = ANY($1) RETURNING id`, [tsList]);
    const reset = await client.query(
      `UPDATE v3.messages
         SET llm_processed_at = NULL, claimed_at = NULL, processing_error = NULL,
             llm_result = NULL, llm_provider_used = NULL,
             events_created = '{}', events_updated = '{}'
       WHERE id = ANY($1) RETURNING id`, [ids]);
    await client.query(
      `INSERT INTO v3.audit_log (actor_type, action, target_type, after_data)
       VALUES ('system', 'fix_f.reprocess_reset', 'message', $1::jsonb)`,
      [JSON.stringify({ messages: ids.length, events_removed: delEv.rowCount, counts_removed: delCt.rowCount })]);
    await client.query('COMMIT');
    console.log(`events órfãos removidos: ${delEv.rowCount} | counts órfãos removidos: ${delCt.rowCount}`);
    console.log(`mensagens resetadas (fila): ${reset.rowCount}`);

    // ── 3. espera o worker SHADOW drenar (claim FIX A + throttle FIX C) ──
    let waited = 0;
    let pending = ids.length;
    while (pending > 0 && waited < 600) {
      await new Promise((res) => setTimeout(res, 10000));
      waited += 10;
      pending = parseInt((await client.query(
        'SELECT COUNT(*) c FROM v3.messages WHERE id = ANY($1) AND llm_processed_at IS NULL',
        [ids])).rows[0].c, 10);
      if (waited % 30 === 0 || pending === 0) console.log(`  ...drenando: ${pending} na fila (${waited}s)`);
    }

    // ── 4. relatório ──
    await report(client, ids, pending);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* */ }
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

async function report(client, ids, pending) {
  console.log('\n==== FIX F REPORT ====');
  console.log(`mensagens re-processadas: ${ids.length - pending}` + (pending ? ` (${pending} ainda na fila!)` : ''));

  // distribuição de confidence — TODAS as mensagens com resultado
  const dist = (await client.query(
    `SELECT COALESCE(llm_result->>'confidence_overall', 'skipped/prefilter') conf, COUNT(*) n
     FROM v3.messages WHERE llm_processed_at IS NOT NULL
     GROUP BY 1 ORDER BY 1`)).rows;
  console.log('\ndistribuição de confidence (todas as mensagens):');
  for (const r of dist) console.log(`  ${String(r.conf).padEnd(20)} ${r.n}`);

  // custo do re-processamento (só o set)
  const cost = (await client.query(
    `SELECT COALESCE(SUM((llm_result->>'cost_estimate_usd')::numeric), 0) c,
            COUNT(*) n
     FROM v3.messages WHERE id = ANY($1) AND llm_processed_at IS NOT NULL`, [ids])).rows[0];
  const avg = cost.n > 0 ? (Number(cost.c) / cost.n) : 0;
  console.log(`\ncusto do re-processamento: $${Number(cost.c).toFixed(4)} (${cost.n} msgs, $${avg.toFixed(5)}/msg)`);

  // cross-account: resolução das mensagens "Bruno" via prefix_resolution_log
  const bruno = (await client.query(
    `SELECT m.raw_text, prl.resolved_person_id, p.display_name, prl.resolution_method, prl.confidence
     FROM v3.messages m
     JOIN v3.prefix_resolution_log prl ON prl.message_id = m.id
     LEFT JOIN v3.persons p ON p.id = prl.resolved_person_id
     WHERE m.raw_text ILIKE '%bruno%'
     ORDER BY m.created_at`)).rows;
  console.log(`\ncross-account "Bruno" (${bruno.length} resoluções):`);
  for (const r of bruno) {
    console.log(`  "${r.raw_text.replace(/\n/g, ' ').slice(0, 60)}" → ${r.display_name || '?'}`
      + ` (${r.resolution_method}, ${r.confidence})`);
  }

  // admins reconhecidos como admin_intervention
  const admins = (await client.query(
    `SELECT m.slack_user_id, m.llm_result->>'categorization' cat,
            m.llm_result->>'admin_context' adminctx, COUNT(*) n
     FROM v3.messages m
     WHERE m.slack_user_id IN ('U03S46L2EUA','U085SDY3F4Z') AND m.llm_processed_at IS NOT NULL
     GROUP BY 1,2,3 ORDER BY 1`)).rows;
  console.log(`\nmensagens dos admins (Thassio/Henrique):`);
  if (!admins.length) console.log('  (nenhuma mensagem de admin no backfill)');
  for (const r of admins) {
    console.log(`  ${r.slack_user_id}: categorization=${r.cat} admin_context=${r.adminctx} (${r.n})`);
  }

  // Vitamin B2 / Potassium → viram events de verdade?
  for (const name of ['Vitamin B2', 'Potassium Iodide']) {
    const ev = (await client.query(
      `SELECT COUNT(*) n FROM v3.events e
       JOIN v3.product_batches b ON b.id = e.product_batch_id
       JOIN v3.products pr ON pr.id = b.product_id
       WHERE pr.canonical_name = $1`, [name])).rows[0].n;
    const ct = (await client.query(
      `SELECT COUNT(*) n FROM v3.production_counts pc
       JOIN v3.products pr ON pr.id = pc.product_id
       WHERE pr.canonical_name = $1`, [name])).rows[0].n;
    console.log(`\n${name}: ${ev} events, ${ct} production_counts`);
  }

  // totais
  const tot = (await client.query(
    `SELECT (SELECT COUNT(*) FROM v3.events) ev,
            (SELECT COUNT(*) FROM v3.production_counts) ct,
            (SELECT COUNT(*) FROM v3.messages WHERE llm_processed_at IS NULL) fila`)).rows[0];
  console.log(`\ntotais v3: ${tot.ev} events, ${tot.ct} production_counts, fila=${tot.fila}`);
  if (pending > 0) console.log(`\n⚠️ ${pending} ainda na fila — confira /api/admin/v3/health`);
}

main();
