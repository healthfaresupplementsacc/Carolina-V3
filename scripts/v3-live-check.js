'use strict';
// HEALTHFARE V3 — checagem do estado AO VIVO pós-troca de webhook. Read-only.
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    const now = new Date();
    console.log('AGORA (UTC):', now.toISOString());

    const hb = await p.query("SELECT value, updated_at FROM v3.settings WHERE key = 'observer_last_tick_at'");
    console.log('heartbeat observer_last_tick_at:', hb.rows[0] && hb.rows[0].value);

    const fila = await p.query('SELECT COUNT(*) c FROM v3.messages WHERE llm_processed_at IS NULL');
    const err = await p.query('SELECT COUNT(*) c FROM v3.messages WHERE processing_error IS NOT NULL');
    const errFila = await p.query(
      'SELECT COUNT(*) c FROM v3.messages WHERE processing_error IS NOT NULL AND llm_processed_at IS NULL');
    console.log('fila (llm_processed_at NULL):', fila.rows[0].c);
    console.log('com processing_error != NULL:', err.rows[0].c, '| dessas na fila:', errFila.rows[0].c);

    const errRows = await p.query(
      `SELECT id, slack_ts, llm_processed_at IS NOT NULL done, LEFT(processing_error,70) e
       FROM v3.messages WHERE processing_error IS NOT NULL ORDER BY id`);
    for (const r of errRows.rows) console.log(`  err id=${r.id} done=${r.done} :: ${r.e}`);

    const total = await p.query('SELECT COUNT(*) c FROM v3.messages');
    console.log('total v3.messages:', total.rows[0].c);

    // últimas mensagens inseridas (created_at = ts do Slack; id alto = inserida recente)
    const recent = await p.query(
      `SELECT id, slack_ts, slack_user_id, created_at, llm_processed_at,
              LEFT(raw_text,55) txt
       FROM v3.messages ORDER BY id DESC LIMIT 10`);
    console.log('\núltimas 10 mensagens (id desc):');
    for (const r of recent.rows) {
      console.log(`  id=${r.id} ts=${r.slack_ts} user=${r.slack_user_id}`
        + ` created=${r.created_at.toISOString()} proc=${r.llm_processed_at ? 'sim' : 'NÃO'}`);
      console.log(`     "${(r.txt || '').replace(/\n/g, ' ')}"`);
    }
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end().catch(() => {});
  }
})();
