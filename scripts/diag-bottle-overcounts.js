'use strict';
// Bruno 07-08: batch multi-dia — dia 1 conta 600 de 800, dia 2 devia ser ~200,
// mas às vezes digitam 800 de novo → total estoura o alvo do EMS. Investiga os
// últimos dias procurando total contado >> target.
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const EDT = 'America/New_York';
const DAYS = parseInt(process.env.DAYS, 10) || 10;
(async () => {
  const r = await p.query(
    `SELECT pb.batch_number, pr.canonical_name AS product, pb.target_bottles AS target,
            SUM(pc.bottles)::int AS counted, COUNT(*)::int AS n,
            COUNT(DISTINCT (pc.production_date))::int AS days,
            array_agg(pc.bottles ORDER BY pc.created_at) AS counts,
            array_agg(to_char(pc.created_at AT TIME ZONE '${EDT}','MM-DD HH24:MI') ORDER BY pc.created_at) AS whens,
            array_agg(COALESCE(rp.display_name,'?') ORDER BY pc.created_at) AS whos
       FROM v3.production_counts pc
       JOIN v3.product_batches pb ON pb.id = pc.product_batch_id
       LEFT JOIN v3.products pr ON pr.id = pb.product_id
       LEFT JOIN v3.persons rp ON rp.id = pc.reported_by_person_id
      WHERE pc.kind = 'bottles' AND pc.deleted_at IS NULL AND pc.superseded_by IS NULL
        AND pc.created_at > NOW() - INTERVAL '${DAYS} days'
      GROUP BY pb.id, pb.batch_number, pr.canonical_name, pb.target_bottles
      ORDER BY pb.batch_number`);

  const over = [], multi = [];
  for (const b of r.rows) {
    const t = Number(b.target) || 0;
    const ratio = t > 0 ? b.counted / t : null;
    if (t > 0 && b.counted > t * 1.15) over.push({ ...b, ratio });
    if (b.days > 1) multi.push(b);
  }
  console.log('=== 🚩 SUSPEITOS: total contado > 115% do alvo do EMS (últimos ' + DAYS + ' dias) ===');
  if (!over.length) console.log('  (nenhum)');
  for (const b of over) {
    console.log(`  ${b.batch_number}  ${(b.product || '?').slice(0, 22).padEnd(22)} alvo=${b.target}  contado=${b.counted}  (${Math.round(b.ratio * 100)}%)  em ${b.days} dia(s)`);
    b.counts.forEach((c, i) => console.log(`       + ${String(c).padStart(5)}  ${b.whens[i]}  ${b.whos[i]}`));
  }
  console.log('\n=== TODOS os batches MULTI-DIA (pra ver o padrão do 2º dia) ===');
  for (const b of multi) {
    const t = Number(b.target) || 0;
    const flag = t > 0 && b.counted > t * 1.15 ? ' 🚩' : '';
    console.log(`  ${b.batch_number}  ${(b.product || '?').slice(0, 20).padEnd(20)} alvo=${b.target || '-'}  contado=${b.counted}  ${b.days}d${flag}  [${b.counts.join(' + ')}]`);
  }
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
