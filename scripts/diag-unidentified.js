'use strict';
// Investiga itens "(?)" / "aged black garlic 0" / falta de info sem aviso.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TODAY = "(NOW() AT TIME ZONE 'America/New_York')::date";
(async () => {
  // 1) Lotes trabalhados HOJE (production flow) — produto vinculado?
  const lotes = await pool.query(
    `SELECT DISTINCT pb.id AS batch_id, pb.batch_number, pb.product_id, pr.canonical_name AS product,
            pb.origin, pb.created_via,
            to_char(pb.started_at AT TIME ZONE 'America/New_York','MM-DD HH24:MI') AS batch_started
     FROM v3.events e
     JOIN v3.product_batches pb ON pb.id = e.product_batch_id
     LEFT JOIN v3.products pr ON pr.id = pb.product_id
     WHERE e.deleted_at IS NULL AND (e.started_at AT TIME ZONE 'America/New_York')::date = ${TODAY}
     ORDER BY pb.id`);
  console.log('=== LOTES trabalhados HOJE ===');
  lotes.rows.forEach((l) => console.log(`  batch ${l.batch_id} "${l.batch_number}" product_id=${l.product_id} product=${l.product || '(?) SEM PRODUTO'} origin=${l.origin}/${l.created_via}`));

  // 2) production_counts hoje por kind (garrafas/ordens/clinic) + produto
  const counts = await pool.query(
    `SELECT pc.kind, COALESCE(pr.canonical_name,'(?) SEM PRODUTO') AS product, pc.product_batch_id,
            SUM(pc.bottles)::int AS total
     FROM v3.production_counts pc
     LEFT JOIN v3.product_batches pb ON pb.id = pc.product_batch_id
     LEFT JOIN v3.products pr ON pr.id = pb.product_id
     WHERE pc.deleted_at IS NULL AND pc.superseded_by IS NULL AND pc.production_date = ${TODAY}
     GROUP BY pc.kind, pr.canonical_name, pc.product_batch_id ORDER BY pc.kind, total DESC`);
  console.log('\n=== CONTAGENS HOJE (kind / produto / lote / total) ===');
  counts.rows.forEach((c) => console.log(`  ${c.kind} · ${c.product} · lote ${c.product_batch_id} · ${c.total}`));

  // 3) Goals/metas hoje sem produto
  const goals = await pool.query(
    `SELECT g.id, g.batch_number, g.product_id, pr.canonical_name AS product, g.expected_quantity, g.source
     FROM v3.production_goals g LEFT JOIN v3.products pr ON pr.id = g.product_id
     WHERE g.deleted_at IS NULL AND g.production_date = ${TODAY} ORDER BY g.id`);
  console.log('\n=== METAS HOJE ===');
  goals.rows.forEach((g) => console.log(`  goal ${g.id} batch=${g.batch_number} product=${g.product || '(?) SEM PRODUTO'} exp=${g.expected_quantity} src=${g.source}`));

  // 4) "aged black garlic" em qualquer lugar
  const abg = await pool.query(
    `SELECT 'product' AS t, id::text, canonical_name AS name FROM v3.products WHERE canonical_name ILIKE '%black garlic%'
     UNION ALL SELECT 'batch', id::text, batch_number FROM v3.product_batches WHERE batch_number ILIKE '%garlic%'`);
  console.log('\n=== "black garlic" no catálogo/lotes ===', JSON.stringify(abg.rows));

  // 5) lotes auto-criados SEM produto (a fonte dos "(?)") + notificação disparada?
  const orphans = await pool.query(
    `SELECT pb.id, pb.batch_number, pb.origin, pb.created_via, pb.created_by_person_id,
            to_char(pb.created_at AT TIME ZONE 'America/New_York','MM-DD HH24:MI') AS created
     FROM v3.product_batches pb
     WHERE pb.product_id IS NULL AND pb.created_at > NOW() - INTERVAL '3 days' ORDER BY pb.id DESC LIMIT 20`);
  console.log('\n=== LOTES SEM PRODUTO (origem do "(?)", últimos 3 dias) ===');
  orphans.rows.forEach((o) => console.log(`  batch ${o.id} "${o.batch_number}" origin=${o.origin}/${o.created_via} by_person=${o.created_by_person_id} criado ${o.created}`));

  // 6) notificações de lote desconhecido / falta de info (últimos 3 dias) + entregue?
  const notifs = await pool.query(
    `SELECT id, type, status, delivery_method, to_char(created_at AT TIME ZONE 'America/New_York','MM-DD HH24:MI') AS at
     FROM v3.notifications WHERE created_at > NOW() - INTERVAL '3 days'
       AND (type ILIKE '%batch%' OR type ILIKE '%unknown%' OR type ILIKE '%unfilled%' OR type ILIKE '%missing%')
     ORDER BY id DESC LIMIT 20`);
  console.log('\n=== NOTIFICAÇÕES (lote desconhecido / falta de contagem) ===');
  notifs.rows.forEach((n) => console.log(`  notif ${n.id} ${n.type} status=${n.status} delivery=${n.delivery_method} ${n.at}`));
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
