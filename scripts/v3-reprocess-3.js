'use strict';
/**
 * HEALTHFARE V3 — re-processa as 3 mensagens (id 43, 46, 77) cuja
 * resolução de autor ficou presa em llm_error por causa do cache
 * envenenado do PersonResolver (apagão de crédito).
 *
 * O fix do _llmCache + redeploy já limparam o cache do worker. Aqui
 * só zeramos as 3 e removemos events/counts órfãos delas — o worker
 * re-processa com resolução de autor limpa.
 *
 *   railway run ... node scripts/v3-reprocess-3.js
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

const IDS = [43, 46, 77];

(async () => {
  const p = makeV3Pool();
  const client = await p.connect();
  try {
    const set = (await client.query(
      'SELECT id, slack_ts, LEFT(raw_text,55) txt FROM v3.messages WHERE id = ANY($1) ORDER BY id', [IDS])).rows;
    const tsList = set.map((r) => r.slack_ts);
    console.log('re-processando:', set.map((r) => `id=${r.id} "${r.txt}"`).join(' | '));

    await client.query('BEGIN');
    const delEv = await client.query(
      'DELETE FROM v3.events WHERE source_message_ts = ANY($1) RETURNING id', [tsList]);
    const delCt = await client.query(
      `DELETE FROM v3.production_counts WHERE split_part(source_message_ts,'#',1) = ANY($1) RETURNING id`, [tsList]);
    await client.query(
      `UPDATE v3.messages SET llm_processed_at = NULL, claimed_at = NULL, processing_error = NULL,
         llm_result = NULL, llm_provider_used = NULL, events_created = '{}', events_updated = '{}'
       WHERE id = ANY($1)`, [IDS]);
    await client.query('COMMIT');
    console.log(`events removidos: ${delEv.rowCount} | counts removidos: ${delCt.rowCount} | 3 resetadas`);

    let waited = 0;
    let pending = IDS.length;
    while (pending > 0 && waited < 240) {
      await new Promise((res) => setTimeout(res, 10000));
      waited += 10;
      pending = parseInt((await client.query(
        'SELECT COUNT(*) c FROM v3.messages WHERE id = ANY($1) AND llm_processed_at IS NULL', [IDS])).rows[0].c, 10);
      console.log(`  ...drenando: ${pending} (${waited}s)`);
    }

    // resolução de autor MAIS RECENTE de cada uma
    const res = await client.query(
      `SELECT DISTINCT ON (prl.message_id) prl.message_id, pe.display_name,
              prl.resolution_method, prl.confidence
       FROM v3.prefix_resolution_log prl
       LEFT JOIN v3.persons pe ON pe.id = prl.resolved_person_id
       WHERE prl.message_id = ANY($1)
       ORDER BY prl.message_id, prl.id DESC`, [IDS]);
    console.log('\nresolução de autor (mais recente):');
    for (const r of res.rows) {
      console.log(`  id=${r.message_id} → ${r.display_name || '?'} (${r.resolution_method}, ${r.confidence})`);
    }
    const cat = await client.query(
      `SELECT id, llm_result->>'categorization' c, llm_result->>'confidence_overall' conf
       FROM v3.messages WHERE id = ANY($1) ORDER BY id`, [IDS]);
    console.log('resultado do classify:');
    for (const r of cat.rows) console.log(`  id=${r.id} categorization=${r.c} confidence=${r.conf}`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* */ }
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await p.end().catch(() => {});
  }
})();
