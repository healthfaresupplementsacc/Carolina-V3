'use strict';
/**
 * HEALTHFARE V3 — re-processa TODAS as mensagens cuja resolução de
 * autor mais recente ficou presa em llm_error/llm_invalid_json por
 * causa do cache envenenado do PersonResolver (apagão de crédito).
 *
 * Auto-descobre o set (não depende de lista hardcoded). O fix do
 * _llmCache + redeploy já limparam o cache do worker; aqui zeramos
 * as mensagens e removemos events/counts órfãos — o worker re-resolve
 * o autor limpo.
 *
 *   railway run ... node scripts/v3-reprocess-stale.js
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  const client = await p.connect();
  try {
    // set = mensagens cuja resolução de autor MAIS RECENTE é erro
    const set = (await client.query(
      `SELECT m.id, m.slack_ts, LEFT(m.raw_text,50) txt
       FROM (
         SELECT DISTINCT ON (prl.message_id) prl.message_id, prl.resolution_method
         FROM v3.prefix_resolution_log prl
         ORDER BY prl.message_id, prl.id DESC
       ) latest
       JOIN v3.messages m ON m.id = latest.message_id
       WHERE latest.resolution_method IN ('llm_error','llm_invalid_json')
       ORDER BY m.id`)).rows;
    const ids = set.map((r) => r.id);
    const tsList = set.map((r) => r.slack_ts);
    console.log(`mensagens com resolução de autor presa em erro: ${ids.length}`);
    for (const r of set) console.log(`  id=${r.id} "${r.txt.replace(/\n/g, ' ')}"`);
    if (!ids.length) { console.log('nada a re-processar.'); return; }

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
       VALUES ('system','reprocess.stale_resolution','message',$1::jsonb)`,
      [JSON.stringify({ messages: ids.length, events_removed: delEv.rowCount, counts_removed: delCt.rowCount })]);
    await client.query('COMMIT');
    console.log(`events removidos: ${delEv.rowCount} | counts removidos: ${delCt.rowCount} | ${ids.length} resetadas`);

    let waited = 0;
    let pending = ids.length;
    while (pending > 0 && waited < 360) {
      await new Promise((res) => setTimeout(res, 10000));
      waited += 10;
      pending = parseInt((await client.query(
        'SELECT COUNT(*) c FROM v3.messages WHERE id = ANY($1) AND llm_processed_at IS NULL', [ids])).rows[0].c, 10);
      if (waited % 30 === 0 || pending === 0) console.log(`  ...drenando: ${pending} (${waited}s)`);
    }

    const res = await client.query(
      `SELECT DISTINCT ON (prl.message_id) prl.message_id, pe.display_name,
              prl.resolution_method, prl.confidence
       FROM v3.prefix_resolution_log prl
       LEFT JOIN v3.persons pe ON pe.id = prl.resolved_person_id
       WHERE prl.message_id = ANY($1)
       ORDER BY prl.message_id, prl.id DESC`, [ids]);
    console.log('\nresolução de autor (mais recente) após re-processar:');
    let stillErr = 0;
    for (const r of res.rows) {
      if (r.resolution_method === 'llm_error' || r.resolution_method === 'llm_invalid_json') stillErr++;
      console.log(`  id=${r.message_id} → ${r.display_name || '?'} (${r.resolution_method}, ${r.confidence})`);
    }
    console.log(`\n${stillErr === 0 ? '✅ nenhuma resolução presa em erro' : '⚠️ ' + stillErr + ' ainda em erro'}`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* */ }
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await p.end().catch(() => {});
  }
})();
