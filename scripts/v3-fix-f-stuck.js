'use strict';
// HEALTHFARE V3 — FIX F — inspeciona as mensagens presas na fila. Read-only.
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    const r = await p.query(
      `SELECT id, slack_ts, slack_user_id, claimed_at, processing_error,
              NOW() - claimed_at AS claim_age, LEFT(raw_text, 90) txt
       FROM v3.messages WHERE llm_processed_at IS NULL ORDER BY id`);
    console.log('mensagens na fila:', r.rows.length);
    for (const m of r.rows) {
      console.log(`  id=${m.id} ts=${m.slack_ts} user=${m.slack_user_id}`);
      console.log(`     claimed_at=${m.claimed_at ? m.claimed_at.toISOString() : 'NULL'} age=${m.claim_age || '-'}`);
      console.log(`     err=${m.processing_error || '-'}`);
      console.log(`     txt="${(m.txt || '').replace(/\n/g, ' ')}"`);
    }
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end().catch(() => {});
  }
})();
