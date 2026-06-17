'use strict';
/* Smoke UX do /op (live) — valida os 3 bugfixes sem PIN real: as chamadas /api
   são interceptadas com dados de teste (os dígitos digitados nunca vão a um
   servidor). Mede: cross-fade sem flash, flow sem re-pop, voz steady, alerta.
   Uso: node scripts/smoke-op-ux.js [url] */
const puppeteer = require('puppeteer');
const URL = process.argv[2] || 'https://productionlineservice-production.up.railway.app/op/';

function jres(obj) { return { status: 200, contentType: 'application/json', body: JSON.stringify(obj) }; }

(async () => {
  const out = { url: URL, errors: [], tests: {} };
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push(m.text()); });
  page.on('pageerror', (e) => out.errors.push('PAGEERROR: ' + e.message));

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.indexOf('/api/') < 0) return req.continue();
    if (u.indexOf('/auth/login') >= 0) return req.respond(jres({ session_token: 't', person: { id: 1, display_name: 'Teste', role: 'operator' }, auto_logoff_seconds: 600, forgotten_check_prompts: [] }));
    if (u.indexOf('/architect/person/') >= 0 && u.indexOf('/today') >= 0) return req.respond(jres({ events: [], goal: 8 }));
    if (u.indexOf('/active-operators') >= 0) return req.respond(jres({ operators: [] }));
    return req.respond(jres({ ok: true }));
  });

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('#scr-login.on', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 600));

  // ── Test A: login → home SEM flash (amostra de opacidade via rAF) ──
  await page.evaluate(() => {
    window.__minMaxOp = 1;
    const L = document.getElementById('scr-login'), H = document.getElementById('scr-home');
    window.__sample = true;
    (function loop() {
      if (!window.__sample) return;
      const lo = parseFloat(getComputedStyle(L).opacity) || 0, ho = parseFloat(getComputedStyle(H).opacity) || 0;
      window.__minMaxOp = Math.min(window.__minMaxOp, Math.max(lo, ho));
      requestAnimationFrame(loop);
    })();
  });
  // digita 4 dígitos (o 4º auto-submete) — PIN fake, login interceptado
  for (const k of ['0', '0', '0', '0']) { await page.click('[data-act="pinkey"][data-arg="' + k + '"]'); await new Promise((r) => setTimeout(r, 60)); }
  await page.waitForSelector('#scr-home.on', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 500));
  out.tests.loginToHome_minMaxOpacity = await page.evaluate(() => { window.__sample = false; return Math.round(window.__minMaxOp * 100) / 100; });
  out.tests.ambientStableA = await page.evaluate(() => { const a = document.getElementById('hf-ambient'); a.setAttribute('data-smoke', '1'); return a.querySelectorAll('img').length; });

  // ── Test B/C: abre flow + passos NÃO recriam o card (sem re-pop) ──
  await page.click('[data-act="startFlow"]');
  await page.waitForSelector('#lyr-flow.on', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 350));
  // marca o card do flow
  await page.evaluate(() => { var c = document.querySelector('#lyr-flow .hf-scroll'); if (c) c.setAttribute('data-card', 'c1'); });
  // escolhe um tipo note_required SEM produto (group→type→confirm), via HF_DATA
  const target = await page.evaluate(() => {
    const D = window.HF_DATA || { groups: [] };
    for (const g of D.groups) for (const t of (g.types || [])) {
      if (t.note_required && !t.requires_product && !t.orders_required) return { group: g.key, slug: t.slug };
    }
    return null;
  });
  if (!target) { out.errors.push('nenhum tipo note_required sem produto em HF_DATA'); }
  await page.click('[data-act="pickGroup"][data-arg="' + target.group + '"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.click('[data-act="pickType"][data-arg="' + target.slug + '"]');
  await new Promise((r) => setTimeout(r, 200));
  out.tests.flowCardSameNode = await page.evaluate(() => { var c = document.querySelector('#lyr-flow .hf-scroll'); return !!(c && c.getAttribute('data-card') === 'c1'); });
  out.tests.atConfirm = await page.evaluate(() => !!document.querySelector('[data-act="confirmStart"]'));

  // ── Test E: COMEÇAR com nota obrigatória vazia → alerta vermelho ──
  await page.click('[data-act="confirmStart"]');
  await page.waitForSelector('#lyr-alert.on', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 350));
  out.tests.alertShown = await page.evaluate(() => { var b = document.getElementById('hf-alert-ok'); var l = document.getElementById('lyr-alert'); return !!(b && l && l.classList.contains('on')); });
  out.tests.alertBorderRed = await page.evaluate(() => { var c = document.querySelector('#lyr-alert div'); return c ? getComputedStyle(c).borderTopColor : ''; });
  // dismiss via Escape
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 350));
  out.tests.alertClosedOnEsc = await page.evaluate(() => !document.getElementById('lyr-alert').classList.contains('on'));
  out.tests.focusBackToNote = await page.evaluate(() => { var a = document.activeElement; return !!(a && (a.getAttribute('data-input') === 'note' || a.getAttribute('data-focus') === 'note')); });
  // fecha o flow
  await page.click('[data-act="cancelFlow"]');
  await new Promise((r) => setTimeout(r, 300));

  // ── Test D: voz steady — mutations no overlay durante 5s < 20 ──
  await page.click('[data-act="note"]');
  await page.waitForSelector('#lyr-overlay.on [data-act="voice"]', { timeout: 5000 });
  await page.evaluate(() => {
    window.__mut = 0;
    window.__obs = new MutationObserver((muts) => { window.__mut += muts.length; });
    window.__obs.observe(document.getElementById('lyr-overlay'), { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await page.click('[data-act="voice"][data-arg="note"]');
  await new Promise((r) => setTimeout(r, 5000));
  out.tests.voiceMutations5s = await page.evaluate(() => { window.__obs.disconnect(); return window.__mut; });
  out.tests.ambientStableB = await page.evaluate(() => document.getElementById('hf-ambient').getAttribute('data-smoke') === '1');

  await page.screenshot({ path: 'docs/design/screenshots/v7-op-ux.png' });
  await browser.close();

  const t = out.tests;
  const pass =
    t.loginToHome_minMaxOpacity > 0.35 &&   // nunca ficou em branco (sem flash)
    t.ambientStableA >= 4 &&
    t.flowCardSameNode === true &&          // flow não re-popou por passo
    t.atConfirm === true &&
    t.alertShown === true &&                // alerta vermelho apareceu
    /rgb\(179,\s*38,\s*30\)/.test(t.alertBorderRed || '') &&
    t.alertClosedOnEsc === true &&          // Esc fecha
    t.focusBackToNote === true &&           // foco volta pro textarea
    t.voiceMutations5s < 20 &&              // voz steady
    t.ambientStableB === true &&            // ambiente nunca recriado
    out.errors.length === 0;
  console.log(JSON.stringify(out, null, 2));
  console.log(pass ? '\nSMOKE UX: PASS' : '\nSMOKE UX: FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
