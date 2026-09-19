'use strict';
/**
 * Preenche events.quantity das "Impressão de Labels" antigas a partir de v3.print_jobs
 * (Bruno 09-12: "isso é um sistema de gravar records"). Contagem da máquina vence o spooler.
 * Idempotente: recalcula sempre a partir das impressões; só mexe em label_printing.
 *   railway run node scripts/backfill-label-quantities.js [--dry]
 */
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const dry = process.argv.includes('--dry');
  const rows = (await p.query(`
    SELECT e.id, e.quantity, SUM(COALESCE((pj.raw->>'machine_labels')::int, pj.sheets, 0))::int AS labels, COUNT(pj.id)::int AS jobs
      FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
      JOIN v3.print_jobs pj ON pj.label_event_id = e.id
     WHERE at.slug = 'label_printing' AND e.deleted_at IS NULL
     GROUP BY e.id, e.quantity HAVING SUM(COALESCE((pj.raw->>'machine_labels')::int, pj.sheets, 0)) > 0`)).rows;
  let changed = 0;
  for (const r of rows) {
    if (Number(r.quantity) === Number(r.labels)) continue;
    changed++;
    if (!dry) await p.query(`UPDATE v3.events SET quantity = $2, quantity_unit = 'label', updated_at = NOW() WHERE id = $1`, [r.id, r.labels]);
  }
  console.log(JSON.stringify({ dry, events_with_prints: rows.length, updated: changed }));
  await p.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
