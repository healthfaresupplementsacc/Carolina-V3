'use strict';
/* Smoke REAL: lote conhecido no EMS (BR-2026-0221 = Myo Inositol) iniciado SÓ com o
   número deve LINKAR o produto (caso exato do Bruno). SANDBOX_PIN=9999 node ... */
const BASE = (process.argv[2] || 'https://productionlineservice-production.up.railway.app').replace(/\/+$/, '');
const PIN = process.env.SANDBOX_PIN;
(async () => {
  if (!PIN) { console.error('falta SANDBOX_PIN'); process.exit(2); }
  const cfg = await (await fetch(BASE + '/op/config.js')).text();
  const tok = (cfg.match(/"pageToken":"([^"]+)"/) || [])[1];
  const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
  const lj = await (await fetch(BASE + '/api/v3/op/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ pin: PIN }) })).json();
  const SH = Object.assign({}, H, { 'X-Session-Token': lj.session_token });
  const out = { t: {} };
  // caso Bruno: só o número, sem product_id, sem nome
  for (const [lot, label] of [['BR-2026-0221', 'Myo Inositol'], ['BR-2026-0219', 'Melatonin']]) {
    const st = await (await fetch(BASE + '/api/v3/op/event/start', { method: 'POST', headers: SH, body: JSON.stringify({ activity_slug: 'production_line', batch_number: lot }) })).json();
    const ev = st.event || {};
    out.t[lot] = { batch: ev.batch_number, product: ev.product || null, linked: !!ev.product };
    if (ev.id) await fetch(BASE + '/api/v3/op/event/' + ev.id + '/end', { method: 'POST', headers: SH, body: JSON.stringify({ bottles: 1 }) });
  }
  const pass = out.t['BR-2026-0221'].linked && out.t['BR-2026-0219'].linked;
  console.log(JSON.stringify(out, null, 2));
  console.log(pass ? '\nSMOKE LOT-LINK REAL: PASS (lote do EMS linkou produto)' : '\nSMOKE LOT-LINK REAL: FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('ERRO', e.message); process.exit(2); });
