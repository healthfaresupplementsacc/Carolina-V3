'use strict';
// Estado completo da mensagem de teste 2. Read-only.
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    const r = (await p.query(
      `SELECT id, slack_ts, slack_channel_id, slack_user_id, raw_text, created_at,
              llm_processed_at, llm_provider_used, processing_error, claimed_at,
              llm_result->>'categorization' cat, llm_result->>'confidence_overall' conf,
              llm_result->>'interpretation' interp
       FROM v3.messages WHERE raw_text ILIKE '%teste v3 ao vivo 2%'`)).rows[0];
    if (!r) { console.log('mensagem não encontrada'); return; }
    console.log('=== teste v3 ao vivo 2 — caminho completo ===');
    console.log('id:                ', r.id);
    console.log('slack_ts:          ', r.slack_ts);
    console.log('slack_channel_id:  ', r.slack_channel_id);
    console.log('slack_user_id:     ', r.slack_user_id);
    console.log('raw_text:          ', JSON.stringify(r.raw_text));
    console.log('created_at:        ', r.created_at.toISOString(), '(ts do Slack)');
    console.log('— inserida via webhook ✓ (chegou em v3.messages)');
    console.log('llm_processed_at:  ', r.llm_processed_at ? r.llm_processed_at.toISOString() : 'NÃO PROCESSADA');
    console.log('llm_provider_used: ', r.llm_provider_used);
    console.log('processing_error:  ', r.processing_error || 'nenhum');
    console.log('categorization:    ', r.cat);
    console.log('confidence_overall:', r.conf);
    console.log('interpretation:    ', r.interp);
    if (r.llm_processed_at) {
      const lag = (new Date(r.llm_processed_at) - new Date(r.created_at)) / 1000;
      console.log(`— processada pelo worker ✓ (${lag.toFixed(0)}s após o ts da mensagem)`);
    }
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end().catch(() => {});
  }
})();
