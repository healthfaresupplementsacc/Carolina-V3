'use strict';
/* Smoke UX do /op (live) — valida os 3 bugfixes sem PIN real: as chamadas /api
   são interceptadas com dados de teste (os dígitos digitados nunca vão a um
   servidor). Mede: cross-fade sem flash, flow sem re-pop, voz steady, alerta.
   Cliques são via .click() in-page (delegação no ROOT) — robusto p/ camadas
   absolutas sobrepostas. Uso: node scripts/smoke-op-ux.js [url] */
const puppeteer = require('puppeteer');
const URL = process.argv[2] || 'https://productionlineservice-production.up.railway.app/op/';
const jres = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const out = { url: URL, errors: [], tests: {}, step: 'init' };
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push(m.text()); });
  page.on('pageerror', (e) => out.errors.push('PAGEERROR: ' + e.message));
  page.on('response', (r) => { try { if (r.status() >= 400) out.errors.push('RESP ' + r.status() + ' ' + r.url().replace(/\?.*/, '')); } catch (e) {} });
  const click = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error('no element: ' + s); el.click(); }, sel);
  const exists = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);

  // desliga o SW no contexto do teste: assim TODA chamada /api passa pela
  // interceptação da página (o SW faz fetch próprio, fora da interceptação, e
  // bateria no backend real com sessão fake → 401 espúrio só no harness).
  await page.evaluateOnNewDocument(() => { try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.resolve({ unregister: function () {} }); }; } catch (e) {} });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.indexOf('/api/') < 0) return req.continue();
    if (u.indexOf('/auth/login') >= 0) return req.respond(jres({ session_token: 't', person: { id: 1, display_name: 'Teste', role: 'operator' }, auto_logoff_seconds: 600, forgotten_check_prompts: [] }));
    if (u.indexOf('/architect/person/') >= 0 && u.indexOf('/today') >= 0) return req.respond(jres({ events: [], goal: 8 }));
    if (u.indexOf('/active-operators') >= 0) return req.respond(jres({ operators: [] }));
    return req.respond(jres({ ok: true }));
  });

  try {
    out.step = 'load';
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('#scr-login.on', { timeout: 15000 });
    await sleep(600);

    // ── A: login → home SEM flash ──
    out.step = 'loginToHome';
    await page.evaluate(() => {
      window.__minMaxOp = 1; window.__sample = true;
      const L = document.getElementById('scr-login'), H = document.getElementById('scr-home');
      (function loop() { if (!window.__sample) return; const lo = parseFloat(getComputedStyle(L).opacity) || 0, ho = parseFloat(getComputedStyle(H).opacity) || 0; window.__minMaxOp = Math.min(window.__minMaxOp, Math.max(lo, ho)); requestAnimationFrame(loop); })();
    });
    for (const k of ['0', '0', '0', '0']) { await click('[data-act="pinkey"][data-arg="' + k + '"]'); await sleep(70); }
    await page.waitForSelector('#scr-home.on', { timeout: 10000 });
    await sleep(500);
    out.tests.loginToHome_minMaxOpacity = await page.evaluate(() => { window.__sample = false; return Math.round(window.__minMaxOp * 100) / 100; });
    out.tests.ambientStableA = await page.evaluate(() => { const a = document.getElementById('hf-ambient'); a.setAttribute('data-smoke', '1'); return a.querySelectorAll('img').length; });
    out.tests.ctaExists = await exists('[data-act="startFlow"]');

    // ── B/C: abre flow + passos NÃO recriam o card ──
    out.step = 'openFlow';
    await click('[data-act="startFlow"]');
    await page.waitForSelector('#lyr-flow.on', { timeout: 5000 });
    await sleep(350);
    await page.evaluate(() => { const c = document.querySelector('#lyr-flow .hf-scroll'); if (c) c.setAttribute('data-card', 'c1'); });
    const target = await page.evaluate(() => {
      const D = window.HF_DATA || { groups: [] };
      for (const g of D.groups) for (const t of (g.types || [])) { if (t.note_required && !t.requires_product && !t.orders_required) return { group: g.key, slug: t.slug }; }
      return null;
    });
    if (!target) throw new Error('nenhum tipo note_required sem produto em HF_DATA');
    out.step = 'flowSteps';
    await click('[data-act="pickGroup"][data-arg="' + target.group + '"]'); await sleep(220);
    await click('[data-act="pickType"][data-arg="' + target.slug + '"]'); await sleep(220);
    out.tests.flowCardSameNode = await page.evaluate(() => { const c = document.querySelector('#lyr-flow .hf-scroll'); return !!(c && c.getAttribute('data-card') === 'c1'); });
    out.tests.atConfirm = await exists('[data-act="confirmStart"]');

    // ── E: COMEÇAR com nota obrigatória vazia → alerta vermelho ──
    out.step = 'alert';
    await click('[data-act="confirmStart"]');
    await page.waitForSelector('#lyr-alert.on', { timeout: 5000 });
    await sleep(350);
    out.tests.alertShown = await page.evaluate(() => { const b = document.getElementById('hf-alert-ok'); const l = document.getElementById('lyr-alert'); return !!(b && l && l.classList.contains('on')); });
    out.tests.alertBorderRed = await page.evaluate(() => { const c = document.querySelector('#lyr-alert div'); return c ? getComputedStyle(c).borderTopColor : ''; });
    await page.keyboard.press('Escape'); await sleep(350);
    out.tests.alertClosedOnEsc = await page.evaluate(() => !document.getElementById('lyr-alert').classList.contains('on'));
    out.tests.focusBackToNote = await page.evaluate(() => { const a = document.activeElement; return !!(a && (a.getAttribute('data-input') === 'note' || a.getAttribute('data-focus') === 'note')); });
    await click('[data-act="cancelFlow"]'); await sleep(300);

    // ── D: voz steady — mutations no overlay durante 5s < 20 ──
    out.step = 'voice';
    await click('[data-act="note"]');
    await page.waitForSelector('#lyr-overlay.on [data-act="voice"]', { timeout: 5000 });
    await page.evaluate(() => { window.__mut = 0; window.__obs = new MutationObserver((m) => { window.__mut += m.length; }); window.__obs.observe(document.getElementById('lyr-overlay'), { subtree: true, childList: true, characterData: true, attributes: true }); });
    await click('[data-act="voice"][data-arg="note"]');
    await sleep(5000);
    out.tests.voiceMutations5s = await page.evaluate(() => { window.__obs.disconnect(); return window.__mut; });
    out.tests.ambientStableB = await page.evaluate(() => document.getElementById('hf-ambient').getAttribute('data-smoke') === '1');

    out.step = 'screenshot';
    await page.screenshot({ path: 'docs/design/screenshots/v7-op-ux.png' });
  } catch (e) {
    out.errors.push('STEP ' + out.step + ': ' + e.message);
  }
  await browser.close();

  const t = out.tests;
  const pass =
    t.loginToHome_minMaxOpacity > 0.35 && t.ambientStableA >= 4 &&
    t.flowCardSameNode === true && t.atConfirm === true &&
    t.alertShown === true && /rgb\(179,\s*38,\s*30\)/.test(t.alertBorderRed || '') &&
    t.alertClosedOnEsc === true && t.focusBackToNote === true &&
    t.voiceMutations5s < 20 && t.ambientStableB === true &&
    out.errors.length === 0;
  console.log(JSON.stringify(out, null, 2));
  console.log(pass ? '\nSMOKE UX: PASS' : '\nSMOKE UX: FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
