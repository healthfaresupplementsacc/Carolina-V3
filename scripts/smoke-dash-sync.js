'use strict';
const BASE = 'https://productionlineservice-production.up.railway.app';
const PIN = process.env.ADMIN_PIN;
(async () => {
  if (!PIN) { console.error('sem ADMIN_PIN'); process.exit(2); }
  const get = async (p) => (await (await fetch(BASE + p + (p.includes('?') ? '&' : '?') + 'pin=' + PIN)).json());
  for (const d of ['2026-06-19', '2026-06-20']) {
    const pp = (await get('/api/v3/data/pp?date=' + d)).data || {};
    const prod = (await get('/api/v3/data/production?date=' + d)).data || {};
    const counts = (await get('/api/v3/data/counts?date=' + d)).data || {};
    const cTot = Object.values(counts.totals_by_product || {}).reduce((s, v) => s + v, 0);
    console.log(`\n=== ${d} ===`);
    console.log('P&P: ordens=' + pp.orders + ' total_min=' + (pp.total_seconds ? Math.round(pp.total_seconds/60) : 0) + ' seg/ordem=' + pp.seconds_per_order);
    console.log('Produção: total_bottles=' + prod.total_bottles + ' lotes=' + (prod.lotes||[]).length);
    console.log('Counts (kind=bottles): total=' + cTot + ' por produto=' + JSON.stringify(counts.totals_by_product || {}));
  }
})().catch((e) => { console.error('ERRO', e.message); process.exit(2); });
