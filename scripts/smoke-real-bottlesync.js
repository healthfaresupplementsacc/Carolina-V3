'use strict';
const BASE = 'https://productionlineservice-production.up.railway.app';
const PW = process.env.ADMIN_PASSWORD;
(async () => {
  if (!PW) { console.error('sem ADMIN_PASSWORD'); process.exit(2); }
  const lj = await (await fetch(BASE + '/api/adminpanel/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) })).json();
  const H = { Authorization: 'Bearer ' + lj.token };
  const pl = await (await fetch(BASE + '/api/adminpanel/metrics/production-line', { headers: H })).json();
  const rt = await (await fetch(BASE + '/api/adminpanel/metrics/realtime', { headers: H })).json();
  const out = {
    producao_hoje_total: pl.production_today.total,
    producao_hoje_por_produto: pl.production_today.by_product,
    bottles_today_realtime: rt.bottles_today,
    metas_em_curso: pl.goals_in_progress.length,
    ok: typeof pl.production_today.total === 'number' && typeof rt.bottles_today === 'number',
  };
  console.log(JSON.stringify(out, null, 2));
  console.log(out.ok ? '\nSMOKE BOTTLE-SYNC REAL: PASS (endpoints canônicos respondendo)' : '\nFAIL');
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.error('ERRO', e.message); process.exit(2); });
