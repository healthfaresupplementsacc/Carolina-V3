'use strict';
const BASE = 'https://productionlineservice-production.up.railway.app';
const PIN = process.env.SANDBOX_PIN; const PW = process.env.ADMIN_PASSWORD;
(async () => {
  const out = {};
  // ITEM 1 — estimated bottles + warning (sandbox)
  const cfg = await (await fetch(BASE + '/op/config.js')).text();
  const tok = (cfg.match(/"pageToken":"([^"]+)"/) || [])[1];
  const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
  const lj = await (await fetch(BASE + '/api/v3/op/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ pin: PIN }) })).json();
  const SH = Object.assign({}, H, { 'X-Session-Token': lj.session_token });
  const st = await (await fetch(BASE + '/api/v3/op/event/start', { method: 'POST', headers: SH, body: JSON.stringify({ activity_slug: 'production_line', batch_number: 'BR-2026-0218' })})).json();
  const id = st.event && st.event.id;
  const pv = await (await fetch(BASE + '/api/v3/op/event/' + id + '/finish-preview', { headers: SH })).json();
  out.estimated_bottles = pv.estimated_bottles;
  // termina com contagem MUITO fora (1) → warning
  const end = await (await fetch(BASE + '/api/v3/op/event/' + id + '/end', { method: 'POST', headers: SH, body: JSON.stringify({ bottles: 1 })})).json();
  out.bottle_warning = end.bottle_warning;
  // ADMIN — cleaning + review-rate
  if (PW) {
    const al = await (await fetch(BASE + '/api/adminpanel/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW })})).json();
    const AH = { Authorization: 'Bearer ' + al.token };
    const cl = await (await fetch(BASE + '/api/adminpanel/metrics/cleaning', { headers: AH })).json();
    out.cleaning_machines = (cl.per_machine || []).map((m) => m.machine + ':' + (m.cleaning_type || '?') + ' por ' + (m.cleaned_by_name || '?'));
    const rr = await (await fetch(BASE + '/api/adminpanel/metrics/review-rate?range=30d', { headers: AH })).json();
    out.review_rate = { avg_cps: rr.avg_capsules_per_sec, avg_bpm: rr.avg_bottles_per_min, n: rr.n };
  }
  console.log(JSON.stringify(out, null, 2));
  const pass = ('estimated_bottles' in out) && out.cleaning_machines && out.review_rate;
  console.log(pass ? '\nSMOKE ITENS 1-4: OK (ver acima)' : '\nFAIL');
})().catch((e) => { console.error('ERRO', e.message); process.exit(2); });
