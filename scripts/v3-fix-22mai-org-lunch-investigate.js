'use strict';
const { makeV3Pool } = require('../src/v3/utils/v3-pool');
(async () => {
  const p = makeV3Pool();
  try {
    const ev123 = await p.query('SELECT * FROM v3.events WHERE id = 123');
    console.log('ev 123 atual:', JSON.stringify(ev123.rows[0], null, 2));
    const ev125 = await p.query('SELECT id, started_at, ended_at, activity_type_id FROM v3.events WHERE id = 125');
    console.log('ev 125 (lunch):', JSON.stringify(ev125.rows[0], null, 2));
    const at = await p.query(
      "SELECT id, slug, display_name, category, flow FROM v3.activity_types WHERE slug = 'organization'");
    console.log('activity_type organization:', at.rows[0]);

    // overlap check pro novo event 13:11→13:45 (UTC: 17:11→17:45)
    const overlap = await p.query(`
      SELECT id, activity_type_id, started_at, ended_at FROM v3.events
      WHERE person_id = 4 AND id NOT IN (123, 125) AND deleted_at IS NULL
        AND tstzrange(started_at, COALESCE(ended_at, NOW())) &&
            tstzrange('2026-05-22 17:11:00+00'::timestamptz, '2026-05-22 17:45:00+00'::timestamptz)`);
    console.log(`\nVitor events sobrepostos a 13:11-13:45 (excl. ev 123/125): ${overlap.rows.length}`);
    for (const r of overlap.rows) console.log(`  ev ${r.id} at=${r.activity_type_id} ${r.started_at} → ${r.ended_at}`);
  } catch (e) { console.error('ERRO:', e.message); process.exitCode = 1; }
  finally { await p.end(); }
})();
