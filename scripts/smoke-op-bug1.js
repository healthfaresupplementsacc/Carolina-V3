'use strict';
/* REPRO Bug 1: finalizar production_line SEM bottles e SEM exceção deve mostrar
   alerta "Contagem obrigatória" e NÃO chamar POST /end. Solo + cowork-último.
   /api interceptado com shape REAL. node scripts/smoke-op-bug1.js [url] */
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
  const exists = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);
  const text = (sel) => page.evaluate((s) => { const el = document.querySelector(s); return el ? el.textContent : ''; }, sel);

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.indexOf('/api/') < 0) return req.continue();
    if (u.indexOf('/auth/login') >= 0) return req.respond(jres({ session_token: 't', person: { id: 4, display_name: 'Vitor', role: 'operator' }, auto_logoff_seconds: 600, forgotten_check_prompts: [] }));
    if (u.indexOf('/architect/person/') >= 0 && u.indexOf('/today') >= 0) {
      return req.respond(jres({ goal: 8, events: [{ id: 901, slug: 'production_line', started_at: new Date(Date.now() - 30 * 60000).toISOString(), ended_at: null, batch_number: 'BR-2026-0191', product: 'Magnesium Glycinate' }] }));
    }
    if (u.indexOf('/active-operators') >= 0) return req.respond(jres({ operators: [] }));
    if (/\/event\/901\/finish-preview/.test(u)) {
      return req.respond(jres({ ok: true, event_id: 901, slug: 'production_line', is_cowork: false, is_last_finisher: true, requires_bottle_count: true, cowork_remaining: 0 }));
    }
    if (/\/event\/901\/end/.test(u)) {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
      out.ends.push(body);
      return req.respond(jres({ ok: true, count_created: true }));
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

    out.step = 'openFinish';
    await click('[data-act="finish"][data-arg="901"]');
    await page.waitForSelector('#lyr-overlay.on [data-input="finBottles"]', { timeout: 5000 });
    out.tests.prodOverlayShown = await exists('[data-input="finBottles"]');
    out.tests.notGenericPlaceholder = (await text('#lyr-overlay')).indexOf('pode deixar vazio') < 0; // generic overlay seria bug

    out.step = 'finishNoBottles';
    await click('[data-act="doFinish"]'); // SEM digitar bottles, SEM exceção
    await sleep(600);
    out.tests.alertShown = await exists('#lyr-alert.on');
    out.tests.alertIsContagem = (await text('#lyr-alert')).toLowerCase().indexOf('contagem obrigat') >= 0;
    out.tests.noPostHappened = out.ends.length === 0; // NÃO pode ter fechado a task
    out.tests.overlayStillOpen = await exists('#lyr-overlay.on');

    await page.screenshot({ path: 'docs/design/screenshots/bug1-noBottles.png' });
  } catch (e) { out.errors.push('STEP ' + out.step + ': ' + e.message); }
  await browser.close();

  const t = out.tests;
  const pass = t.prodOverlayShown && t.notGenericPlaceholder && t.alertShown && t.alertIsContagem && t.noPostHappened && t.overlayStillOpen && out.errors.length === 0;
  console.log(JSON.stringify(out, null, 2));
  console.log(pass ? '\nBUG1 REPRO: PASS (validação funciona)' : '\nBUG1 REPRO: FAIL (bug confirmado)');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
