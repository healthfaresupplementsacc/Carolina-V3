'use strict';
/* Smoke do fluxo COWORK no /op (live) — sem PIN real, /api interceptado.
   today devolve uma task cowork production_line; /end varia a resposta por
   chamada: (1) não-último → is_last_finisher:false; (2) sem bottles → 400
   bottles_required (bounce p/ contagem); (3) com bottles → is_last_finisher:true.
   Uso: node scripts/smoke-op-cowork.js [url] */
const puppeteer = require('puppeteer');
const URL = process.argv[2] || 'https://productionlineservice-production.up.railway.app/op/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jres = (o, status) => ({ status: status || 200, contentType: 'application/json', body: JSON.stringify(o) });

(async () => {
  const out = { url: URL, errors: [], tests: {}, step: 'init', ends: [] };
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  await page.evaluateOnNewDocument(() => { try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.resolve({ unregister: function () {} }); }; } catch (e) {} });
  page.on('pageerror', (e) => out.errors.push('PAGEERROR: ' + e.message));
  const click = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error('no element: ' + s); el.click(); }, sel);
  const setInput = (sel, v) => page.evaluate((s, val) => { const el = document.querySelector(s); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, sel, v);
  const exists = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);
  const text = () => page.evaluate(() => document.getElementById('hf-canvas').textContent || '');

  let endCall = 0;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.indexOf('/api/') < 0) return req.continue();
    if (u.indexOf('/auth/login') >= 0) return req.respond(jres({ session_token: 't', person: { id: 4, display_name: 'Vitor', role: 'operator' }, auto_logoff_seconds: 600, forgotten_check_prompts: [] }));
    if (u.indexOf('/architect/person/') >= 0 && u.indexOf('/today') >= 0) {
      return req.respond(jres({ goal: 8, events: [{ id: 999, slug: 'production_line', started_at: new Date(Date.now() - 40 * 60000).toISOString(), ended_at: null, batch_number: 'BR-2026-0190', product: 'Magnesium Glycinate', cowork_group_id: 'g1', cowork_with: [5, 6] }] }));
    }
    if (u.indexOf('/active-operators') >= 0) return req.respond(jres({ operators: [] }));
    if (/\/event\/999\/end/.test(u)) {
      endCall++;
      try { out.ends.push(JSON.parse(req.postData() || '{}')); } catch (e) { out.ends.push({}); }
      if (endCall === 1) return req.respond(jres({ ok: true, is_last_finisher: false, remaining: 1, count_created: false }));
      if (endCall === 2) return req.respond(jres({ error: 'bottles_required' }, 400)); // último de production_line
      return req.respond(jres({ ok: true, is_last_finisher: true, count_created: true }));
    }
    return req.respond(jres({ ok: true }));
  });

  try {
    out.step = 'login';
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('#scr-login.on', { timeout: 15000 });
    for (const k of ['0', '0', '0', '0']) { await click('[data-act="pinkey"][data-arg="' + k + '"]'); await sleep(60); }
    await page.waitForSelector('#scr-home.on', { timeout: 10000 });
    await sleep(400);
    out.tests.taskVisible = await exists('[data-act="finish"][data-arg="999"]');

    // ── A: membro NÃO-último → overlay simplificado "Terminei minha parte" ──
    out.step = 'memberNotLast';
    await click('[data-act="finish"][data-arg="999"]');
    await page.waitForSelector('#lyr-overlay.on [data-act="doFinish"]', { timeout: 5000 });
    await sleep(250);
    out.tests.simplifiedOverlay = (await text()).indexOf('Terminei minha parte') >= 0;
    out.tests.noBottlesInputYet = !(await exists('[data-input="finBottles"]')); // simplificado não pede bottles
    await click('[data-act="doFinish"]'); // → /end call 1 (is_last_finisher:false)
    await sleep(500);
    out.tests.closedAfterMemberFinish = !(await page.evaluate(() => document.getElementById('lyr-overlay').classList.contains('on')));

    // ── B: último de production_line → bounce p/ contagem ──
    out.step = 'lastBounce';
    await page.waitForSelector('#scr-home.on', { timeout: 8000 });
    await sleep(300);
    await click('[data-act="finish"][data-arg="999"]'); // reabre (today ainda devolve 999)
    await page.waitForSelector('#lyr-overlay.on [data-act="doFinish"]', { timeout: 5000 });
    await sleep(200);
    await click('[data-act="doFinish"]'); // → /end call 2 (400 bottles_required) → deve virar tela de contagem
    await page.waitForSelector('#lyr-overlay.on [data-input="finBottles"]', { timeout: 5000 });
    out.tests.bouncedToCount = await exists('[data-input="finBottles"]');
    out.tests.lastBanner = (await text()).indexOf('último a finalizar') >= 0;
    await setInput('[data-input="finBottles"]', '900');
    await click('[data-act="doFinish"]'); // → /end call 3 (is_last_finisher:true)
    await sleep(500);
    out.tests.closedAfterLast = !(await page.evaluate(() => document.getElementById('lyr-overlay').classList.contains('on')));
    out.tests.lastPostedBottles = (out.ends[out.ends.length - 1] || {}).bottles === 900;

    await page.screenshot({ path: 'docs/design/screenshots/v15-cowork.png' });
  } catch (e) { out.errors.push('STEP ' + out.step + ': ' + e.message); }
  await browser.close();

  const t = out.tests;
  const pass = t.taskVisible && t.simplifiedOverlay && t.noBottlesInputYet && t.closedAfterMemberFinish
    && t.bouncedToCount && t.lastBanner && t.closedAfterLast && t.lastPostedBottles && out.errors.length === 0;
  console.log(JSON.stringify(out, null, 2));
  console.log(pass ? '\nSMOKE COWORK: PASS' : '\nSMOKE COWORK: FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
