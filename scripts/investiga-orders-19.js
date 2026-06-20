'use strict';
const { Pool } = require('pg');
const EDT = 'America/New_York';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s) => pool.query(s).then(r=>r.rows).catch(e=>[{ERRO:e.message}]);
  const D19 = `'2026-06-19'::date`; const D20 = `'2026-06-20'::date`;
  for (const [lbl, d] of [['ONTEM 19', D19], ['HOJE 20', D20]]) {
    console.log(`\n===== ${lbl} =====`);
    console.log('production_counts kind=orders: ' + JSON.stringify(await q(`SELECT COUNT(*)::int n, COALESCE(SUM(bottles),0)::int total, array_agg(DISTINCT marketplace) mkts FROM v3.production_counts WHERE kind='orders' AND deleted_at IS NULL AND production_date=${d}`)));
    console.log('events.orders_printed (order_printing no START): ' + JSON.stringify(await q(`SELECT COALESCE(SUM(orders_printed),0)::int total, COUNT(*) FILTER (WHERE orders_printed IS NOT NULL)::int n FROM v3.events WHERE deleted_at IS NULL AND (started_at AT TIME ZONE '${EDT}')::date=${d}`)));
    console.log('P&P (counts_as_pp) events fechados + tem orders count: ' + JSON.stringify(await q(`SELECT at.slug, COUNT(*)::int fechados, COUNT(pc.id)::int com_orders, COALESCE(SUM(pc.bottles),0)::int orders_total
      FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id AND at.counts_as_pp=true
      LEFT JOIN v3.production_counts pc ON pc.source_event_id=e.id AND pc.kind='orders' AND pc.deleted_at IS NULL
      WHERE e.ended_at IS NOT NULL AND e.deleted_at IS NULL AND (e.ended_at AT TIME ZONE '${EDT}')::date=${d} GROUP BY 1`)));
    console.log('P&P fechados SEM orders count nem orders_printed (perdidos): ' + JSON.stringify(await q(`SELECT e.id, at.slug, e.source, e.exception_no_count FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id AND at.counts_as_pp=true LEFT JOIN v3.production_counts pc ON pc.source_event_id=e.id AND pc.kind='orders' AND pc.deleted_at IS NULL WHERE e.ended_at IS NOT NULL AND e.deleted_at IS NULL AND (e.ended_at AT TIME ZONE '${EDT}')::date=${d} AND pc.id IS NULL`)));
  }
  await pool.end();
})().catch(e=>{console.error('ERRO',e.message);process.exit(1);});
