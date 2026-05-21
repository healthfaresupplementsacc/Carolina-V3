'use strict';
/**
 * HEALTHFARE V3 — FIX F — força re-claim das mensagens presas.
 *
 * Zera claimed_at das mensagens não-processadas → o worker re-pega
 * no próximo tick (sem esperar o claim de 2min expirar). Usado
 * depois de recarregar o crédito Anthropic. Espera a fila drenar.
 *
 *   railway run ... node scripts/v3-fix-f-reclaim.js
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    const r = await p.query(
      'UPDATE v3.messages SET claimed_at = NULL WHERE llm_processed_at IS NULL RETURNING id');
    console.log(`re-claim forçado: ${r.rowCount} mensagens (claimed_at=NULL)`);
    if (r.rowCount === 0) { console.log('fila já vazia.'); return; }
    const ids = r.rows.map((x) => x.id);

    let waited = 0;
    let pending = ids.length;
    while (pending > 0 && waited < 240) {
      await new Promise((res) => setTimeout(res, 10000));
      waited += 10;
      pending = parseInt((await p.query(
        'SELECT COUNT(*) c FROM v3.messages WHERE id = ANY($1) AND llm_processed_at IS NULL',
        [ids])).rows[0].c, 10);
      console.log(`  ...drenando: ${pending} na fila (${waited}s)`);
    }

    // estado das que sobraram (se houver)
    const left = await p.query(
      `SELECT id, processing_error FROM v3.messages
       WHERE id = ANY($1) AND llm_processed_at IS NULL`, [ids]);
    if (left.rows.length) {
      console.log(`\n⚠️ ${left.rows.length} ainda na fila:`);
      for (const m of left.rows) console.log(`  id=${m.id}: ${String(m.processing_error || '-').slice(0, 120)}`);
    } else {
      console.log('\n✅ fila drenada — todas processadas.');
    }
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end().catch(() => {});
  }
})();
