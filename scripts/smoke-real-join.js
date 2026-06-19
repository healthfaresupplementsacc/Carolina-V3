'use strict';
/* Smoke REAL do JOIN cowork (FASE 1): Vitor inicia, Sandbox dá JOIN → tem que CRIAR
   um event NOVO pro Sandbox (não só array_append). Limpa no fim.
   VITOR_PIN=4321 SANDBOX_PIN=9999 node scripts/smoke-real-join.js [url] */
const BASE = (process.argv[2] || 'https://productionlineservice-production.up.railway.app').replace(/\/+$/, '');
const VP = process.env.VITOR_PIN, SP = process.env.SANDBOX_PIN || '9999';
const j = (r) => r.json();
(async () => {
  if (!VP) { console.error('faltou VITOR_PIN'); process.exit(2); }
  const cfg = await (await fetch(BASE + '/op/config.js')).text();
  const tok = (cfg.match(/"pageToken":"([^"]+)"/) || [])[1];
  const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
  const login = async (pin) => j(await fetch(BASE + '/api/v3/op/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ pin }) }));

  const v = await login(VP); if (!v.session_token) { console.error('login Vitor falhou'); process.exit(1); }
  const VH = Object.assign({}, H, { 'X-Session-Token': v.session_token });
  const st = await j(await fetch(BASE + '/api/v3/op/event/start', { method: 'POST', headers: VH, body: JSON.stringify({ activity_slug: 'cleaning' }) }));
  const aId = st.event && st.event.id;
  console.log('Vitor iniciou cleaning → event A=' + aId);

  const sb = await login(SP); if (!sb.session_token) { console.error('login Sandbox falhou'); process.exit(1); }
  const SH = Object.assign({}, H, { 'X-Session-Token': sb.session_token });
  const join = await j(await fetch(BASE + '/api/v3/op/event/' + aId + '/join', { method: 'POST', headers: SH, body: JSON.stringify({}) }));
  console.log('Sandbox JOIN → ' + JSON.stringify(join));

  const ok = join.joined === true && join.event_id && join.event_id !== aId && join.cowork_group_id;
  console.log(ok ? '\nJOIN REAL: PASS (criou event separado pro joiner no mesmo grupo)' : '\nJOIN REAL: FAIL (não criou event do joiner — código velho?)');

  // cleanup: fecha o A do Vitor (o B do sandbox é limpo pelo worker)
  try { await fetch(BASE + '/api/v3/op/event/' + aId + '/end', { method: 'POST', headers: VH, body: JSON.stringify({}) }); console.log('cleanup: event A do Vitor fechado'); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERRO', e.message); process.exit(2); });
