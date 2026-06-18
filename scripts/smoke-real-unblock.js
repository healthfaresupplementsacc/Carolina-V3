'use strict';
/* Smoke REAL (PIN real via env OP_TEST_PIN) contra o backend LIVE: prova que um lote
   desconhecido NÃO bloqueia — auto-cria + inicia. Usa um batch de TESTE (limpo depois).
   OP_TEST_PIN=**** node scripts/smoke-real-unblock.js [url] */
const BASE = (process.argv[2] || 'https://productionlineservice-production.up.railway.app').replace(/\/+$/, '');
const PIN = process.env.OP_TEST_PIN;
const TEST_BATCH = 'ZZSMOKE-' + '019';     // claramente de teste → fácil de limpar
const PLANT_STEROLS_PID = 56;              // prod#56 (confirmado em prod)

(async () => {
  if (!PIN) { console.error('faltou OP_TEST_PIN'); process.exit(2); }
  const cfg = await (await fetch(BASE + '/op/config.js')).text();
  const m = cfg.match(/"pageToken":"([^"]+)"/);
  const pageToken = m && m[1];
  if (!pageToken) { console.error('sem pageToken'); process.exit(2); }
  const H = { Authorization: 'Bearer ' + pageToken, 'Content-Type': 'application/json' };

  const login = await fetch(BASE + '/api/v3/op/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ pin: PIN }) });
  const lj = await login.json();
  if (!login.ok || !lj.session_token) { console.error('login falhou:', login.status, JSON.stringify(lj)); process.exit(1); }
  console.log('login OK: ' + lj.person.display_name + ' (#' + lj.person.id + ')');

  const start = await fetch(BASE + '/api/v3/op/event/start', {
    method: 'POST',
    headers: Object.assign({}, H, { 'X-Session-Token': lj.session_token }),
    body: JSON.stringify({ activity_slug: 'formulation', batch_number: TEST_BATCH, product_id: PLANT_STEROLS_PID, product_name: 'Plant Sterols' }),
  });
  const sj = await start.json();
  console.log('start status: ' + start.status);
  console.log('start body: ' + JSON.stringify(sj));
  const ok = start.status === 200 && sj.event && sj.event.batch_number === TEST_BATCH;
  console.log(ok ? '\nUNBLOCK REAL: PASS (lote desconhecido NÃO bloqueou — event iniciado)' : '\nUNBLOCK REAL: FAIL');
  if (sj.event) console.log('CLEANUP_EVENT_ID=' + sj.event.id + ' CLEANUP_BATCH=' + TEST_BATCH);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERRO', e.message); process.exit(2); });
