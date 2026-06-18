'use strict';
/* Smoke REAL do sandbox (PIN via env SANDBOX_PIN) contra o backend LIVE:
   login sandbox → is_sandbox=true; cria task (is_test); termina. Imprime o event_id
   pra checagem de limpeza (rodar scripts/verify-sandbox-clean.js depois).
   SANDBOX_PIN=9999 node scripts/smoke-real-sandbox.js [url] */
const BASE = (process.argv[2] || 'https://productionlineservice-production.up.railway.app').replace(/\/+$/, '');
const PIN = process.env.SANDBOX_PIN || '9999';
(async () => {
  const cfg = await (await fetch(BASE + '/op/config.js')).text();
  const pageToken = (cfg.match(/"pageToken":"([^"]+)"/) || [])[1];
  if (!pageToken) { console.error('sem pageToken'); process.exit(2); }
  const H = { Authorization: 'Bearer ' + pageToken, 'Content-Type': 'application/json' };

  const lj = await (await fetch(BASE + '/api/v3/op/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ pin: PIN }) })).json();
  if (!lj.session_token) { console.error('login falhou', JSON.stringify(lj)); process.exit(1); }
  console.log('login: ' + lj.person.display_name + ' is_sandbox=' + lj.person.is_sandbox);
  const SH = Object.assign({}, H, { 'X-Session-Token': lj.session_token });

  // cria task de produção (auto-cria lote desconhecido — NÃO pode ir pro Slack)
  const st = await (await fetch(BASE + '/api/v3/op/event/start', { method: 'POST', headers: SH, body: JSON.stringify({ activity_slug: 'production_line', batch_number: 'SBX-TESTE-1', product_id: 56, product_name: 'Plant Sterols' }) })).json();
  console.log('start: event_id=' + (st.event && st.event.id) + ' batch=' + (st.event && st.event.batch_number));
  // termina já (vira "vencido" em 15s)
  if (st.event) {
    const end = await (await fetch(BASE + '/api/v3/op/event/' + st.event.id + '/end', { method: 'POST', headers: SH, body: JSON.stringify({ bottles: 123 }) })).json();
    console.log('end: ' + JSON.stringify(end));
  }
  const ok = lj.person.is_sandbox === true && st.event && st.event.id;
  console.log(ok ? '\nSANDBOX REAL: login+start OK (event ' + st.event.id + ' — checar limpeza em ~20s)' : '\nSANDBOX REAL: FAIL');
  console.log('SANDBOX_EVENT_ID=' + (st.event && st.event.id));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERRO', e.message); process.exit(2); });
