'use strict';
/* Smoke REAL (PIN via env) contra o backend LIVE — FASE 4 dívida + FASE FORM.
   Verifica: lots/available lê objeto-por-stage (linha pega yield_review etc),
   filtra formulação por sub-stage (weighing/encapsulation/mixing), slug sem
   lista → vazio; detecção passiva (/ems/my-activity) responde; register-detected
   com ems_key fantasma → 409 (anti-fantasma). NÃO cria nada real (só leitura +
   um 409 esperado). SANDBOX_PIN=9999 node scripts/smoke-real-formulacao.js [url] */
const BASE = (process.argv[2] || 'https://productionlineservice-production.up.railway.app').replace(/\/+$/, '');
const PIN = process.env.SANDBOX_PIN;
(async () => {
  if (!PIN) { console.error('falta SANDBOX_PIN no env'); process.exit(2); }
  const cfg = await (await fetch(BASE + '/op/config.js')).text();
  const pageToken = (cfg.match(/"pageToken":"([^"]+)"/) || [])[1];
  if (!pageToken) { console.error('sem pageToken'); process.exit(2); }
  const H = { Authorization: 'Bearer ' + pageToken, 'Content-Type': 'application/json' };
  const lj = await (await fetch(BASE + '/api/v3/op/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ pin: PIN }) })).json();
  if (!lj.session_token) { console.error('login falhou', JSON.stringify(lj)); process.exit(1); }
  const SH = Object.assign({}, H, { 'X-Session-Token': lj.session_token });
  const out = { login: lj.person.display_name, t: {} };

  async function lots(slug) { return (await fetch(BASE + '/api/v3/op/lots/available?slug=' + slug, { headers: SH })).json(); }

  const line = await lots('production_line');
  out.t.line_lots = (line.lots || []).length;
  out.t.line_stages = [...new Set((line.lots || []).map((l) => l.stage))];
  out.t.line_sample = (line.lots || []).slice(0, 3).map((l) => l.batch_number + ' [' + l.stage + '] ' + (l.product_name || '?'));

  const wgh = await lots('weighing');
  out.t.weighing_lots = (wgh.lots || []).length;
  out.t.weighing_stages = [...new Set((wgh.lots || []).map((l) => l.stage))];

  const enc = await lots('encapsulation');
  out.t.encapsulation_lots = (enc.lots || []).length;
  out.t.encapsulation_stages = [...new Set((enc.lots || []).map((l) => l.stage))];

  const mix = await lots('mixing');
  out.t.mixing_lots = (mix.lots || []).length;

  const cln = await lots('cleaning');
  out.t.cleaning_empty = (cln.lots || []).length === 0; // slug sem lista EMS → vazio

  const mine = await (await fetch(BASE + '/api/v3/op/ems/my-activity', { headers: SH })).json();
  out.t.my_activity_ok = mine && Object.prototype.hasOwnProperty.call(mine, 'detected');
  out.t.my_activity_detected = mine.detected ? (mine.detected.machine + ' · ' + mine.detected.batch_number + ' → ' + mine.detected.slug) : null;

  const ghost = await fetch(BASE + '/api/v3/op/ems/register-detected', { method: 'POST', headers: SH, body: JSON.stringify({ ems_key: 'ghost:nao-existe' }) });
  const ghostBody = await ghost.json().catch(() => ({}));
  out.t.ghost_status = ghost.status;
  out.t.ghost_blocked = ghost.status === 409 && ghostBody.error === 'not_detected';

  const pass = out.t.my_activity_ok && out.t.cleaning_empty && out.t.ghost_blocked
    && line.ems_stale === false; // EMS respondeu (não stale)
  console.log(JSON.stringify(out, null, 2));
  console.log(pass ? '\nSMOKE FORMULACAO REAL: PASS' : '\nSMOKE FORMULACAO REAL: FAIL (revisar acima)');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('ERRO', e.message); process.exit(2); });
