'use strict';
const { Pool } = require('pg');
const EDT = 'America/New_York';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s,p) => pool.query(s,p).then(r=>r.rows).catch(e=>[{ERRO:e.message}]);
  const dayFilter = `(e.started_at AT TIME ZONE '${EDT}')::date >= (NOW() AT TIME ZONE '${EDT}')::date - 1`;

  console.log('=== PART A: events hoje+ontem com lote NA DESCRIÇÃO mas product_batch_id NULL ===');
  console.log(JSON.stringify(await q(`SELECT COUNT(*)::int n FROM v3.events e WHERE ${dayFilter} AND e.deleted_at IS NULL AND e.product_batch_id IS NULL AND e.description ~ 'BR-2026-[0-9]+|lote digitado'`)));
  console.log('amostra: ' + JSON.stringify(await q(`SELECT e.id, at.slug, e.description FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id WHERE ${dayFilter} AND e.deleted_at IS NULL AND e.product_batch_id IS NULL AND e.description ~ 'BR-2026-[0-9]+|lote digitado' ORDER BY e.started_at DESC LIMIT 8`,), null, 1));

  console.log('\n=== PART B: production_counts por kind (ontem+hoje) ===');
  console.log(JSON.stringify(await q(`SELECT COALESCE(kind,'(null)') kind, COUNT(*)::int n, SUM(bottles)::int total FROM v3.production_counts WHERE deleted_at IS NULL AND production_date >= (NOW() AT TIME ZONE '${EDT}')::date - 1 GROUP BY 1`)));

  console.log('\n=== PART B: events de P&P (counts_as_pp/requires_order_count) FECHADOS ontem+hoje ===');
  console.log(JSON.stringify(await q(`SELECT at.slug, at.requires_order_count, at.counts_as_pp, COUNT(*)::int fechados,
      COUNT(*) FILTER (WHERE e.orders_printed IS NOT NULL)::int com_orders_printed,
      COUNT(pc.id)::int com_count_orders
    FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id
    LEFT JOIN v3.production_counts pc ON pc.source_event_id=e.id AND pc.kind='orders' AND pc.deleted_at IS NULL
    WHERE (at.requires_order_count OR at.counts_as_pp) AND e.ended_at IS NOT NULL AND ${dayFilter} AND e.deleted_at IS NULL
    GROUP BY 1,2,3 ORDER BY 1`,), null, 1));

  console.log('\n=== PART B: events.orders_printed preenchido (ontem+hoje) ===');
  console.log(JSON.stringify(await q(`SELECT at.slug, e.source, e.orders_printed, e.id, to_char(e.started_at AT TIME ZONE '${EDT}','MM-DD HH24:MI') st FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id WHERE e.orders_printed IS NOT NULL AND ${dayFilter} AND e.deleted_at IS NULL ORDER BY e.started_at DESC LIMIT 10`,), null, 1));
  await pool.end();
})().catch(e=>{console.error('ERRO',e.message);process.exit(1);});
