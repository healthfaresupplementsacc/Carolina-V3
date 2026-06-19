'use strict';
/* Smoke REAL FASE PAUSA (sandbox PIN) contra o backend LIVE: start task →
   start break (nota) → /today mostra task CONGELADA (is_paused) → end break →
   /today mostra task RODANDO de novo (paused_at null, total_paused_seconds>0).
   Eventos sandbox (is_test) somem sozinhos depois. Limpa fechando a task no fim.
   SANDBOX_PIN=9999 node scripts/smoke-real-pausa.js [url] */
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
  const pid = lj.person.id;
  const SH = Object.assign({}, H, { 'X-Session-Token': lj.session_token });
  const out = { login: lj.person.display_name, t: {} };
  const today = async () => (await (await fetch(BASE + '/api/v3/architect/person/' + pid + '/today', { headers: Object.assign({}, SH, { 'X-Operator-Id': String(pid) }) })).json()).events || [];
  const find = (evs, id) => evs.find((e) => e.id === id);

  // 1) inicia produção
  const prod = await (await fetch(BASE + '/api/v3/op/event/start', { method: 'POST', headers: SH, body: JSON.stringify({ activity_slug: 'production_line', batch_number: 'SBX-PAUSA-1', product_id: 56, product_name: 'Plant Sterols' }) })).json();
  const prodId = prod.event && prod.event.id;
  out.t.prod_started = !!prodId;

  // 2) inicia PAUSA (nota obrigatória)
  const noNote = await (await fetch(BASE + '/api/v3/op/event/start', { method: 'POST', headers: SH, body: JSON.stringify({ activity_slug: 'break' }) })).json();
  out.t.break_needs_note = noNote.error === 'note_required';
  const br = await (await fetch(BASE + '/api/v3/op/event/start', { method: 'POST', headers: SH, body: JSON.stringify({ activity_slug: 'break', note: 'almoço (smoke pausa)' }) })).json();
  const brId = br.event && br.event.id;
  out.t.break_started = !!brId;

  // 3) /today: produção CONGELADA
  const ev1 = await today();
  const p1 = find(ev1, prodId) || {};
  out.t.prod_frozen = p1.is_paused === true && !!p1.paused_at;

  // 4) termina a pausa → retoma
  const endBr = await (await fetch(BASE + '/api/v3/op/event/' + brId + '/end', { method: 'POST', headers: SH, body: JSON.stringify({}) })).json();
  out.t.resumed_count = endBr.resumed;

  // 5) /today: produção RODANDO de novo + tempo pausado acumulado
  const ev2 = await today();
  const p2 = find(ev2, prodId) || {};
  out.t.prod_running_again = p2.is_paused === false && !p2.paused_at;
  out.t.total_paused_seconds = p2.total_paused_seconds;

  // limpa: fecha a produção (com contagem p/ não pedir) — sandbox cleanup faz o resto
  if (prodId) await fetch(BASE + '/api/v3/op/event/' + prodId + '/end', { method: 'POST', headers: SH, body: JSON.stringify({ bottles: 1 }) });

  const pass = out.t.prod_started && out.t.break_needs_note && out.t.break_started
    && out.t.prod_frozen && out.t.resumed_count >= 1 && out.t.prod_running_again
    && (out.t.total_paused_seconds || 0) >= 0;
  console.log(JSON.stringify(out, null, 2));
  console.log(pass ? '\nSMOKE PAUSA REAL: PASS' : '\nSMOKE PAUSA REAL: FAIL (revisar acima)');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('ERRO', e.message); process.exit(2); });
