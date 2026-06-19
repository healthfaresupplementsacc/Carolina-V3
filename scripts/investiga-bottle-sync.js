'use strict';
const { Pool } = require('pg');
const EDT = 'America/New_York';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s, p) => pool.query(s, p).then((r) => r.rows);
  const today = `(NOW() AT TIME ZONE '${EDT}')::date`;

  console.log('\n=== I1+I2: production_line events FECHADOS hoje + production_count vinculado ===');
  const rows = await q(`
    SELECT e.id AS event_id, e.person_id, p.display_name, e.product_batch_id, pb.product_id, pb.batch_number,
           e.cowork_group_id, e.exception_no_count,
           pc.id AS pc_id, pc.kind, pc.unit, pc.bottles, pc.source_event_id, pc.reported_by_person_id
    FROM v3.events e
    JOIN v3.activity_types at ON at.id = e.activity_type_id AND at.slug='production_line'
    JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.production_counts pc ON pc.source_event_id = e.id AND pc.deleted_at IS NULL
    WHERE e.deleted_at IS NULL AND e.ended_at IS NOT NULL
      AND (e.ended_at AT TIME ZONE '${EDT}')::date = ${today}
    ORDER BY e.ended_at DESC LIMIT 30`);
  let linked = 0, nullBatch = 0, nullProduct = 0, hasCount = 0, exc = 0;
  rows.forEach((r) => {
    if (r.pc_id) hasCount++;
    if (r.exception_no_count) exc++;
    if (!r.product_batch_id) nullBatch++;
    else if (r.product_id == null) nullProduct++;
    else linked++;
    console.log(`ev${r.event_id} ${r.display_name} batch=${r.batch_number || 'NULL'} pid=${r.product_id == null ? 'NULL' : r.product_id} | pc=${r.pc_id ? `#${r.pc_id} kind=${r.kind} unit=${r.unit} bottles=${r.bottles}` : 'SEM COUNT'}${r.exception_no_count ? ' [EXC]' : ''}`);
  });
  console.log(`\nresumo: ${rows.length} events fechados | ${hasCount} com count | ${exc} exceção | LINKADOS(batch+product)=${linked} batch_NULL=${nullBatch} product_NULL=${nullProduct}`);

  console.log('\n=== I3a: "Produção Hoje" (byProduct INNER JOIN products) — o que mostra ===');
  const byProduct = await q(`
    SELECT COALESCE(SUM(pc.bottles),0)::int AS total
    FROM v3.production_counts pc
    JOIN v3.events e ON e.id = pc.source_event_id
    JOIN v3.activity_types at ON at.id = e.activity_type_id
    JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    JOIN v3.products pr ON pr.id = pb.product_id
    WHERE at.slug='production_line' AND pc.deleted_at IS NULL AND e.deleted_at IS NULL
      AND (e.ended_at AT TIME ZONE '${EDT}')::date = ${today}`);
  console.log('  byProduct total (INNER JOIN) = ' + byProduct[0].total);

  console.log('\n=== I3b: o que DEVERIA mostrar (LEFT JOIN, kind=bottles) ===');
  const correct = await q(`
    SELECT COALESCE(SUM(pc.bottles),0)::int AS total, COUNT(*)::int AS n
    FROM v3.production_counts pc
    JOIN v3.events e ON e.id = pc.source_event_id
    JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE at.slug='production_line' AND pc.kind='bottles' AND pc.deleted_at IS NULL AND e.deleted_at IS NULL
      AND (e.ended_at AT TIME ZONE '${EDT}')::date = ${today}`);
  console.log('  correto (sem product join, kind=bottles) = ' + correct[0].total + ' (' + correct[0].n + ' counts)');
  console.log('  >>> PERDIDOS pelo INNER JOIN = ' + (correct[0].total - byProduct[0].total));

  console.log('\n=== I3c: bottles_today (realtime, SEM kind filter) — vaza orders? ===');
  const rt = await q(`SELECT COALESCE(SUM(bottles),0)::int AS total FROM v3.production_counts WHERE deleted_at IS NULL AND production_date = ${today}`);
  const byKind = await q(`SELECT COALESCE(kind,'(null)') AS kind, COUNT(*)::int n, SUM(bottles)::int total FROM v3.production_counts WHERE deleted_at IS NULL AND production_date = ${today} GROUP BY 1`);
  console.log('  bottles_today (SUM tudo) = ' + rt[0].total);
  console.log('  por kind: ' + JSON.stringify(byKind));

  console.log('\n=== I5: cowork — counts de events cowork hoje ===');
  const cw = await q(`
    SELECT e.cowork_group_id, COUNT(DISTINCT e.id)::int events, COUNT(pc.id)::int counts, COALESCE(SUM(pc.bottles),0)::int bottles
    FROM v3.events e
    JOIN v3.activity_types at ON at.id=e.activity_type_id AND at.slug='production_line'
    LEFT JOIN v3.production_counts pc ON pc.source_event_id=e.id AND pc.deleted_at IS NULL
    WHERE e.cowork_group_id IS NOT NULL AND e.deleted_at IS NULL AND e.ended_at IS NOT NULL
      AND (e.ended_at AT TIME ZONE '${EDT}')::date = ${today}
    GROUP BY e.cowork_group_id`);
  console.log('  grupos cowork hoje: ' + JSON.stringify(cw));
  await pool.end();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
