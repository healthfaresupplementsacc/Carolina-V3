'use strict';
// HEALTHFARE V3 — checa o contador de erro + as 3 mensagens "Bruno" com llm_error no log. Read-only.
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    const errCnt = await p.query(
      'SELECT COUNT(*) c FROM v3.messages WHERE processing_error IS NOT NULL');
    const errNull = await p.query(
      'SELECT COUNT(*) c FROM v3.messages WHERE processing_error IS NOT NULL AND llm_processed_at IS NULL');
    console.log('messages com processing_error != NULL:', errCnt.rows[0].c,
      '| dessas, ainda na fila:', errNull.rows[0].c);

    const er = await p.query(
      `SELECT id, slack_ts, LEFT(processing_error, 90) err, llm_processed_at IS NOT NULL done
       FROM v3.messages WHERE processing_error IS NOT NULL ORDER BY id`);
    for (const m of er.rows) console.log(`  id=${m.id} done=${m.done} err="${m.err}"`);

    // as 3 mensagens cujo prefix_resolution_log mais recente é llm_error
    const stale = await p.query(
      `SELECT m.id, m.slack_ts, LEFT(m.raw_text,55) txt,
              m.llm_result->>'categorization' cat,
              m.llm_result->>'confidence_overall' conf,
              m.processing_error IS NOT NULL has_err
       FROM v3.messages m
       WHERE m.raw_text ILIKE '%bruno%' AND m.raw_text ILIKE '%vitamin b2%'
       ORDER BY m.id`);
    console.log('\nmensagens "Bruno"+"Vitamin B2":');
    for (const m of stale.rows) {
      console.log(`  id=${m.id} cat=${m.cat} conf=${m.conf} processing_error=${m.has_err} :: "${m.txt}"`);
    }
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end().catch(() => {});
  }
})();
