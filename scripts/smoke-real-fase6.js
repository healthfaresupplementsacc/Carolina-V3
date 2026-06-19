'use strict';
/* Smoke REAL FASE 6 (admin) — pp-today + unfinished. Roda via `railway run` p/
   pegar ADMIN_PASSWORD do env (NUNCA imprime a senha). */
const BASE = (process.argv[2] || 'https://productionlineservice-production.up.railway.app').replace(/\/+$/, '');
const PW = process.env.ADMIN_PASSWORD;
(async () => {
  if (!PW) { console.error('sem ADMIN_PASSWORD no env'); process.exit(2); }
  const lj = await (await fetch(BASE + '/api/adminpanel/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) })).json();
  if (!lj.token) { console.error('login admin falhou'); process.exit(1); }
  const H = { Authorization: 'Bearer ' + lj.token };
  const pp = await (await fetch(BASE + '/api/adminpanel/metrics/pp-today', { headers: H })).json();
  const unf = await (await fetch(BASE + '/api/adminpanel/metrics/unfinished', { headers: H })).json();
  const out = {
    pp_ok: pp && typeof pp.total_orders === 'number' && ['green', 'yellow', 'red'].includes(pp.cutoff_color),
    pp: { orders: pp.total_orders, sec_per_order: pp.sec_per_order, cutoff: pp.cutoff_color, open: pp.open_pp_tasks, mkts: (pp.by_marketplace || []).length },
    unfinished_ok: Array.isArray(unf.unfinished),
    unfinished_count: (unf.unfinished || []).length,
  };
  console.log(JSON.stringify(out, null, 2));
  console.log(out.pp_ok && out.unfinished_ok ? '\nSMOKE FASE6 REAL: PASS' : '\nSMOKE FASE6 REAL: FAIL');
  process.exit(out.pp_ok && out.unfinished_ok ? 0 : 1);
})().catch((e) => { console.error('ERRO', e.message); process.exit(2); });
