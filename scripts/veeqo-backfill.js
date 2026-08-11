'use strict';
/**
 * Centro de Estoque — backfill Veeqo (Bruno 08-01: "pull everything from veeqo
 * without affecting any of the entries currently there").
 *
 * READ-ONLY na Veeqo (só GET — o client nem tem escrita). No nosso lado, SÓ
 * tabelas novas recebem linhas, NADA existente muda:
 *  1. Catálogo: SKUs da Veeqo casados com nossos produtos (matcher canônico do
 *     /api/v3/data/inventory — sem 4ª cópia da lógica) → v3.product_skus como
 *     UNCONFIRMED (confirmed_at NULL). Não movem estoque até alguém confirmar.
 *     ON CONFLICT DO NOTHING → linha já existente (confirmada ou não) fica INTACTA.
 *  2. Pedidos: ~35 dias de shipped + abertos + cancelados → v3.pnp_order_lines
 *     (upsert idempotente do worker; status nunca regride). ZERO dedução
 *     (deductMode 'dry' + stock=null) — o estoque físico não é tocado.
 *
 * Idempotente: rodar de novo é seguro. Rate limit Veeqo (5 req/s): pausa entre
 * páginas. Rodar: railway run --service ProductionLineService node scripts/veeqo-backfill.js
 */
const { Pool } = require('pg');
const { veeqo } = require('../src/v3/services/veeqo-api');
const { VeeqoOrderSync } = require('../src/workers/veeqo-order-sync');

const DAYS = parseInt(process.env.BACKFILL_DAYS || '35', 10);
const BASE = process.env.SELF_BASE_URL || 'https://productionlineservice-production.up.railway.app';
const PIN = process.env.ADMIN_PIN || '510510';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!veeqo.configured()) { console.error('VEEQO_API_KEY ausente'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // ── 1. catálogo → product_skus (unconfirmed, nunca sobrescreve) ────────────
  console.log('1/2 catálogo: matcher canônico via /api/v3/data/inventory …');
  const invRes = await fetch(`${BASE}/api/v3/data/inventory?pin=${PIN}`);
  if (!invRes.ok) { console.error('inventory endpoint HTTP', invRes.status); process.exit(1); }
  const inv = (await invRes.json()).data || {};
  const matched = inv.matched || [];
  let insSku = 0, keptSku = 0;
  for (const m of matched) {
    if (!m.product_id || !m.veeqo_sku) continue;
    const pack = (/-C(\d)\b/.exec(m.veeqo_sku) || [])[1];
    const r = await pool.query(
      `INSERT INTO v3.product_skus (product_id, sku, channel, units_per_pack)
       VALUES ($1, $2, 'veeqo', COALESCE($3, 1))
       ON CONFLICT (channel, sku) DO NOTHING RETURNING id`,
      [m.product_id, m.veeqo_sku, pack ? Number(pack) : null]);
    if (r.rows[0]) insSku++; else keptSku++;
  }
  console.log(`   product_skus: +${insSku} novos (unconfirmed), ${keptSku} já existiam (intactos), ${matched.length} casados no matcher`);

  // ── 2. pedidos → pnp_order_lines (sem NENHUMA dedução) ─────────────────────
  console.log(`2/2 pedidos: ${DAYS} dias de shipped + abertos + cancelados …`);
  const w = new VeeqoOrderSync({ db: pool, veeqo, stock: null, enabled: true, deductMode: 'dry', maxPages: 150 });
  const skuMap = await w._skuMap();          // só confirmados — irrelevante aqui (sem dedução);
  // pro backfill queremos product_id preenchido mesmo unconfirmed → mapa próprio:
  const allSkus = await pool.query(`SELECT sku, product_id, units_per_pack FROM v3.product_skus WHERE channel='veeqo'`);
  const fullMap = new Map(allSkus.rows.map((r) => [r.sku, r]));
  const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString();
  const counts = {};
  for (const [veeqoStatus, ourStatus] of [['shipped', 'shipped'], ['awaiting_fulfillment', 'pending'], ['cancelled', 'cancelled']]) {
    let n = 0;
    try {
      for (let page = 1; page <= 150; page++) {
        const rows = await veeqo.getOrdersPage({ status: veeqoStatus, updatedSince: since, page, pageSize: 100 });
        if (!rows.length) break;
        for (const o of rows) {
          for (const l of w._lines(o, ourStatus)) {
            if (!l.qty) continue;
            const map = l.sku ? fullMap.get(l.sku) : null;
            l.product_id = map ? map.product_id : null;
            l.error_note = map ? null : (l.sku ? 'SKU sem mapeamento' : 'linha sem SKU');
            await w._upsertLine(l);
            n++;
          }
        }
        if (rows.length < 100) break;
        await sleep(300);                    // 5 req/s com folga
      }
    } catch (e) { console.log(`   (${veeqoStatus}: parou em "${e.message}" — segue)`); }
    counts[veeqoStatus] = n;
    console.log(`   ${veeqoStatus}: ${n} linhas upsert`);
  }

  // resumo final honesto
  const sum = (await pool.query(`
    SELECT status, COUNT(*)::int n, COALESCE(SUM(qty),0)::int units,
           MIN(order_date) AS from_d, MAX(order_date) AS to_d
      FROM v3.pnp_order_lines GROUP BY status ORDER BY status`)).rows;
  const unmapped = (await pool.query(
    `SELECT COUNT(*)::int n FROM v3.pnp_order_lines WHERE product_id IS NULL`)).rows[0].n;
  const deducted = (await pool.query(
    `SELECT COUNT(*)::int n FROM v3.stock_movements`)).rows[0].n;
  console.log('── RESUMO ──');
  for (const s of sum) console.log(`   ${s.status}: ${s.n} linhas / ${s.units} unidades (${s.from_d} → ${s.to_d})`);
  console.log(`   sem mapeamento (quarentena): ${unmapped}`);
  console.log(`   movimentos de estoque criados: ${deducted} (tem que ser 0 — backfill NUNCA deduz)`);
  console.log(`   skuMap confirmado (worker usaria p/ deduzir): ${skuMap.size} — dedução continua OFF`);
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
