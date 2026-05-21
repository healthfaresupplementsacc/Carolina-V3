'use strict';
// HEALTHFARE V3 — FIX F — relatório final comparativo. Read-only.
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    const tot = (await p.query('SELECT COUNT(*) n FROM v3.messages')).rows[0].n;
    const proc = (await p.query('SELECT COUNT(*) n FROM v3.messages WHERE llm_processed_at IS NOT NULL')).rows[0].n;
    const fila = (await p.query('SELECT COUNT(*) n FROM v3.messages WHERE llm_processed_at IS NULL')).rows[0].n;
    console.log(`mensagens: ${tot} total | ${proc} processadas | ${fila} na fila\n`);

    const dist = (await p.query(
      `SELECT COALESCE(llm_result->>'confidence_overall', 'skipped/prefilter') conf, COUNT(*) n
       FROM v3.messages WHERE llm_processed_at IS NOT NULL GROUP BY 1 ORDER BY 1`)).rows;
    console.log('distribuição de confidence (processadas):');
    for (const r of dist) console.log('  ' + String(r.conf).padEnd(20) + r.n);

    const cost = (await p.query(
      `SELECT COALESCE(SUM((llm_result->>'cost_estimate_usd')::numeric),0) c, COUNT(*) n
       FROM v3.messages WHERE llm_result->>'cost_estimate_usd' IS NOT NULL`)).rows[0];
    const avg = cost.n > 0 ? Number(cost.c) / cost.n : 0;
    console.log(`\ncusto total processado: $${Number(cost.c).toFixed(4)} (${cost.n} msgs c/ custo, $${avg.toFixed(5)}/msg)`);

    // cross-account "Bruno" — só a resolução MAIS RECENTE de cada mensagem
    const bruno = (await p.query(
      `SELECT DISTINCT ON (prl.message_id) m.raw_text, pe.display_name,
              prl.resolution_method, prl.confidence
       FROM v3.prefix_resolution_log prl
       JOIN v3.messages m ON m.id = prl.message_id
       LEFT JOIN v3.persons pe ON pe.id = prl.resolved_person_id
       WHERE m.raw_text ILIKE '%bruno%'
       ORDER BY prl.message_id, prl.id DESC`)).rows;
    console.log(`\ncross-account "Bruno" — resolução atual (${bruno.length} mensagens):`);
    for (const r of bruno) {
      console.log(`  "${r.raw_text.replace(/\n/g, ' ').slice(0, 52)}" → ${r.display_name || '?'} (${r.resolution_method}, ${r.confidence})`);
    }

    const admins = (await p.query(
      `SELECT m.slack_user_id, pe.display_name,
              m.llm_result->>'categorization' cat, COUNT(*) n
       FROM v3.messages m LEFT JOIN v3.persons pe ON pe.slack_user_id = m.slack_user_id
       WHERE m.slack_user_id IN ('U03S46L2EUA','U085SDY3F4Z')
       GROUP BY 1,2,3 ORDER BY 1,3`)).rows;
    console.log('\nmensagens dos admins:');
    for (const r of admins) {
      console.log(`  ${r.display_name || r.slack_user_id}: ${r.cat || '(não processada)'} × ${r.n}`);
    }

    for (const name of ['Vitamin B2', 'Potassium Iodide', 'Plant Sterols']) {
      const ev = (await p.query(
        `SELECT COUNT(*) n FROM v3.events e JOIN v3.product_batches b ON b.id = e.product_batch_id
         JOIN v3.products pr ON pr.id = b.product_id WHERE pr.canonical_name = $1`, [name])).rows[0].n;
      const ct = (await p.query(
        `SELECT COUNT(*) n FROM v3.production_counts pc JOIN v3.products pr ON pr.id = pc.product_id
         WHERE pr.canonical_name = $1`, [name])).rows[0].n;
      console.log(`\n${name}: ${ev} events, ${ct} production_counts`);
    }

    const t = (await p.query(
      `SELECT (SELECT COUNT(*) FROM v3.events) ev, (SELECT COUNT(*) FROM v3.production_counts) ct,
              (SELECT COUNT(*) FROM v3.product_batches) b`)).rows[0];
    console.log(`\ntotais v3: ${t.ev} events, ${t.ct} production_counts, ${t.b} batches`);

    // mensagens bloqueadas e por quê
    const blocked = (await p.query(
      `SELECT id, processing_error FROM v3.messages
       WHERE llm_processed_at IS NULL AND processing_error IS NOT NULL ORDER BY id`)).rows;
    if (blocked.length) {
      console.log(`\n⚠️ ${blocked.length} bloqueadas: ${String(blocked[0].processing_error).slice(0, 80)}...`);
    }
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end().catch(() => {});
  }
})();
