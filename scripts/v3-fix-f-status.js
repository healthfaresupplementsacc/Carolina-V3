'use strict';
// HEALTHFARE V3 — FIX F — status da fila + distribuição. Read-only.
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    const fila = await p.query('SELECT COUNT(*) c FROM v3.messages WHERE llm_processed_at IS NULL');
    const claimed = await p.query(
      'SELECT COUNT(*) c FROM v3.messages WHERE llm_processed_at IS NULL AND claimed_at IS NOT NULL');
    const err = await p.query(
      'SELECT COUNT(*) c FROM v3.messages WHERE processing_error IS NOT NULL AND llm_processed_at IS NULL');
    const hb = await p.query("SELECT value FROM v3.settings WHERE key = 'observer_last_tick_at'");
    console.log('fila:', fila.rows[0].c, '| claimed-pendentes:', claimed.rows[0].c, '| com erro:', err.rows[0].c);
    console.log('heartbeat:', hb.rows[0] && hb.rows[0].value);

    const er = await p.query(
      `SELECT id, slack_ts, processing_error FROM v3.messages
       WHERE processing_error IS NOT NULL AND llm_processed_at IS NULL ORDER BY id LIMIT 15`);
    for (const r of er.rows) {
      console.log('  err id=' + r.id + ' ts=' + r.slack_ts + ': ' + String(r.processing_error).slice(0, 120));
    }

    const dist = await p.query(
      `SELECT COALESCE(llm_result->>'confidence_overall', 'skipped/prefilter') conf, COUNT(*) n
       FROM v3.messages WHERE llm_processed_at IS NOT NULL GROUP BY 1 ORDER BY 1`);
    console.log('distribuição confidence (processadas):');
    for (const r of dist.rows) console.log('  ' + String(r.conf).padEnd(20) + r.n);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end().catch(() => {});
  }
})();
