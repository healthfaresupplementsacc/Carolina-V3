'use strict';
const { Pool } = require('pg');
const BASE = 'https://productionlineservice-production.up.railway.app';
const PW = process.env.ADMIN_PASSWORD;
const EDT = 'America/New_York';
(async () => {
  // 1) DB: backfill linkou os events de ontem/hoje?
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s) => pool.query(s).then((r) => r.rows);
  console.log('events ontem/hoje AINDA sem produto (era 20, agora?): ' + JSON.stringify(await q(`SELECT COUNT(*)::int n FROM v3.events e WHERE e.deleted_at IS NULL AND e.product_batch_id IS NULL AND e.description ~ 'lote digitado' AND (e.started_at AT TIME ZONE '${EDT}')::date >= (NOW() AT TIME ZONE '${EDT}')::date - 1`)));
  console.log('amostra backfilled (com produto agora): ' + JSON.stringify(await q(`SELECT e.id, at.slug, pb.batch_number, pr.canonical_name product FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id JOIN v3.product_batches pb ON pb.id=e.product_batch_id JOIN v3.products pr ON pr.id=pb.product_id WHERE pb.batch_number IN ('BR-2026-0221','BR-2026-0219') AND (e.started_at AT TIME ZONE '${EDT}')::date >= (NOW() AT TIME ZONE '${EDT}')::date - 1 LIMIT 4`)));
  await pool.end();
  // 2) API: pp-today ONTEM mostra as ordens?
  if (PW) {
    const lj = await (await fetch(BASE + '/api/adminpanel/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) })).json();
    const H = { Authorization: 'Bearer ' + lj.token };
    const ont = await (await fetch(BASE + '/api/adminpanel/metrics/pp-today?date=2026-06-19', { headers: H })).json();
    console.log('\nP&P ONTEM (19): ' + JSON.stringify({ orders: ont.total_orders, tasks: ont.total_tasks, is_past: ont.is_past, by_op: ont.by_operator }));
    const rt = await (await fetch(BASE + '/api/adminpanel/metrics/realtime', { headers: H })).json();
    console.log('realtime orders_today (canônico, hoje): ' + rt.orders_today);
  }
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
