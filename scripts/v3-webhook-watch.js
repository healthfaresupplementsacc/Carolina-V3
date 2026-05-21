'use strict';
// HEALTHFARE V3 — observa a chegada de mensagem nova via webhook ao vivo. Read-only.
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    const base = parseInt((await p.query('SELECT COALESCE(MAX(id),0) m FROM v3.messages')).rows[0].m, 10);
    console.log('baseline max(id) em v3.messages:', base, '— esperando mensagem nova via webhook...');

    let waited = 0;
    let novo = null;
    while (waited < 240) {
      await new Promise((r) => setTimeout(r, 10000));
      waited += 10;
      const rows = (await p.query(
        'SELECT id, slack_ts, slack_user_id, raw_text, created_at, llm_processed_at FROM v3.messages WHERE id > $1 ORDER BY id',
        [base])).rows;
      if (rows.length) {
        novo = rows;
        console.log(`\n✅ ${rows.length} mensagem(ns) NOVA(S) chegou via webhook (${waited}s):`);
        for (const m of rows) {
          console.log(`  id=${m.id} ts=${m.slack_ts} user=${m.slack_user_id} created=${m.created_at.toISOString()}`);
          console.log(`     "${(m.raw_text || '').replace(/\n/g, ' ').slice(0, 70)}"`);
          console.log(`     processada pelo worker: ${m.llm_processed_at ? 'SIM @ ' + m.llm_processed_at.toISOString() : 'ainda não'}`);
        }
        break;
      }
      if (waited % 30 === 0) console.log(`  ...sem mensagem nova ainda (${waited}s)`);
    }

    if (!novo) {
      console.log('\n⚠️ NENHUMA mensagem nova em 240s. Webhook pode não estar entregando.');
      return;
    }

    // espera o worker processar a(s) nova(s)
    const ids = novo.map((m) => m.id);
    let w2 = 0;
    let pend = ids.length;
    while (pend > 0 && w2 < 90) {
      await new Promise((r) => setTimeout(r, 5000));
      w2 += 5;
      pend = parseInt((await p.query(
        'SELECT COUNT(*) c FROM v3.messages WHERE id = ANY($1) AND llm_processed_at IS NULL', [ids])).rows[0].c, 10);
    }
    const done = (await p.query(
      `SELECT id, llm_result->>'categorization' cat, llm_result->>'confidence_overall' conf, llm_provider_used
       FROM v3.messages WHERE id = ANY($1) ORDER BY id`, [ids])).rows;
    console.log('\nresultado do worker:');
    for (const r of done.rows || done) {
      console.log(`  id=${r.id} categorization=${r.cat} confidence=${r.conf} provider=${r.llm_provider_used}`);
    }
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end().catch(() => {});
  }
})();
