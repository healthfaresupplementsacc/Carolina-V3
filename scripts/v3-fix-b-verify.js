'use strict';
// HEALTHFARE V3 — verificação pós-apply do FIX B (catálogo). Read-only.
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    const cnt = await p.query('SELECT COUNT(*) n FROM v3.products');
    const ps = await p.query("SELECT id FROM v3.products WHERE canonical_name = 'Plant Sterols'");
    const psid = ps.rows[0] && ps.rows[0].id;
    const b = await p.query('SELECT COUNT(*) n FROM v3.product_batches WHERE product_id = $1', [psid]);
    const ev = await p.query(
      'SELECT COUNT(*) n FROM v3.events WHERE product_batch_id IN (SELECT id FROM v3.product_batches WHERE product_id = $1)', [psid]);
    const ct = await p.query('SELECT COUNT(*) n FROM v3.production_counts WHERE product_id = $1', [psid]);
    const orphB = await p.query(
      'SELECT COUNT(*) n FROM v3.product_batches pb LEFT JOIN v3.products pr ON pr.id = pb.product_id WHERE pr.id IS NULL');
    const orphC = await p.query(
      'SELECT COUNT(*) n FROM v3.production_counts pc LEFT JOIN v3.products pr ON pr.id = pc.product_id WHERE pr.id IS NULL');
    const vb2 = await p.query("SELECT id, canonical_name FROM v3.products WHERE canonical_name ILIKE 'vitamin b2'");
    const pot = await p.query("SELECT id, canonical_name FROM v3.products WHERE canonical_name ILIKE 'potassium%'");
    const aud = await p.query(
      "SELECT action, COUNT(*) n FROM v3.audit_log WHERE action LIKE 'fix_b.%' GROUP BY action ORDER BY action");
    console.log('total produtos:', cnt.rows[0].n);
    console.log('Plant Sterols id:', psid, '| batches:', b.rows[0].n, 'events:', ev.rows[0].n, 'counts:', ct.rows[0].n);
    console.log('batches orfaos:', orphB.rows[0].n, '| counts orfaos:', orphC.rows[0].n);
    console.log('Vitamin B2:', vb2.rows.map((r) => r.canonical_name + ' (id ' + r.id + ')').join(', ') || 'AUSENTE');
    console.log('Potassium:', pot.rows.map((r) => r.canonical_name + ' (id ' + r.id + ')').join(', ') || 'AUSENTE');
    console.log('audit fix_b:');
    for (const r of aud.rows) console.log('  ' + r.action + ': ' + r.n);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end().catch(() => {});
  }
})();
