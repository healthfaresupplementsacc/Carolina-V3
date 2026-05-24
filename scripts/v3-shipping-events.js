'use strict';
const { makeV3Pool } = require('../src/v3/utils/v3-pool');
(async () => {
  const p = makeV3Pool();
  try {
    const r = (await p.query(
      `SELECT e.id, e.person_id, pn.display_name AS person,
              e.started_at, e.ended_at, e.product_batch_id,
              pb.batch_number, pr.canonical_name AS product,
              m.raw_text
       FROM v3.events e
       LEFT JOIN v3.persons pn ON pn.id = e.person_id
       LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
       LEFT JOIN v3.products pr ON pr.id = pb.product_id
       LEFT JOIN v3.messages m ON m.slack_ts = e.source_message_ts
       WHERE e.activity_type_id = 9 AND e.deleted_at IS NULL
       ORDER BY e.started_at`)).rows;
    console.log(`events com activity_type_id=9 (shipping/Envio): ${r.length}`);
    for (const x of r) {
      const txt = (x.raw_text || '').slice(0, 100).replace(/\n/g, ' ');
      const prod = x.product_batch_id
        ? `${x.product || '?'}/${x.batch_number || '?'}`
        : '—';
      console.log(`  ev ${x.id} ${x.person} (${x.person_id}) started=${x.started_at && new Date(x.started_at).toISOString()} ended=${x.ended_at && new Date(x.ended_at).toISOString()} batch=${prod}`);
      console.log(`     msg: "${txt}"`);
    }
  } catch (e) { console.error('ERRO:', e.message); process.exitCode = 1; }
  finally { await p.end(); }
})();
