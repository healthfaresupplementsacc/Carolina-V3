'use strict';
/* Smoke frontend Bug 2/3 (live): Step SUPPLEMENT mostra thumbnails; ao escolher
   um suplemento, Step BATCH busca /batches/recent e mostra chips c/ data relativa.
   /api interceptado. node scripts/smoke-op-bug23.js [url] */
const puppeteer = require('puppeteer');
const URL = process.argv[2] || 'https://productionlineservice-production.up.railway.app/op/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jres = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

(async () => {
  const out = { url: URL, errors: [], tests: {}, step: 'init', batchReqs: 0 };
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() => { try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.resolve({ unregister: function () {} }); }; } catch (e) {} });
  page.on('pageerror', (e) => out.errors.push('PAGEERROR: ' + e.message));
  const click = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error('no element: ' + s); el.click(); }, sel);
  const exists = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);
  const flowText = () => page.evaluate(() => { const el = document.getElementById('lyr-flow'); return el ? el.textContent : ''; });

  // by_id pra ids 1..200 → imagem de teste (garante thumbnail mesmo sem PNG local)
  const byId = {}; for (let i = 1; i <= 200; i++) byId[i] = 'https://m.media-amazon.com/images/I/61djAK6fQQL.jpg';

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.indexOf('/api/') < 0) return req.continue();
    if (u.indexOf('/auth/login') >= 0) return req.respond(jres({ session_token: 't', person: { id: 4, display_name: 'Vitor', role: 'operator' }, auto_logoff_seconds: 600, forgotten_check_prompts: [] }));
    if (u.indexOf('/today') >= 0) return req.respond(jres({ goal: 8, events: [] }));
    if (u.indexOf('/active-operators') >= 0) return req.respond(jres({ operators: [] }));
    if (u.indexOf('/products/images') >= 0) return req.respond(jres({ by_id: byId, matched: 200, total_local: 64, ems_ok: true }));
    if (u.indexOf('/batches/recent') >= 0) {
      out.batchReqs++;
      return req.respond(jres({ product_id: 1, batches: [
        { batch_number: 'BR-2026-0213', last_seen: daysAgo(3), last_operator: 'Vitor', status_in_ems: 'on_line', target_bottles: 700 },
        { batch_number: '0207', last_seen: daysAgo(8), last_operator: 'Ana', status_in_ems: null, target_bottles: null },
      ] }));
    }
    return req.respond(jres({ ok: true }));
  });

  try {
    out.step = 'login';
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('#scr-login.on', { timeout: 15000 });
    for (const k of ['0', '0', '0', '0']) { await click('[data-act="pinkey"][data-arg="' + k + '"]'); await sleep(60); }
    await page.waitForSelector('#scr-home.on', { timeout: 10000 });
    await sleep(500); // deixa /products/images carregar

    out.step = 'openFlow';
    await click('[data-act="startFlow"]');
    await page.waitForSelector('#lyr-flow.on', { timeout: 5000 });
    await sleep(200);

    // navega grupos até achar o tile production_line
    out.step = 'findProductionLine';
    const groups = await page.evaluate(() => Array.from(document.querySelectorAll('#lyr-flow [data-act="pickGroup"]')).map((b) => b.getAttribute('data-arg')));
    let found = false;
    for (const g of groups) {
      await page.evaluate((gg) => { const b = document.querySelector('#lyr-flow [data-act="pickGroup"][data-arg="' + gg + '"]'); if (b) b.click(); }, g);
      await sleep(250);
      if (await exists('#lyr-flow [data-act="pickType"][data-arg="production_line"]')) { found = true; break; }
      await page.evaluate(() => { const b = document.querySelector('#lyr-flow [data-act="flowBack"]'); if (b) b.click(); });
      await sleep(200);
    }
    out.tests.foundProductionLine = found;
    if (!found) throw new Error('tile production_line não encontrado nos grupos: ' + groups.join(','));

    out.step = 'pickType';
    await click('#lyr-flow [data-act="pickType"][data-arg="production_line"]');
    await page.waitForSelector('#lyr-flow [data-act="pickSupp"]', { timeout: 5000 });
    await sleep(300);
    // Bug 3: thumbnails no Step SUPPLEMENT
    out.tests.suppThumbnails = await page.evaluate(() => document.querySelectorAll('#lyr-flow [data-act="pickSupp"] img').length) > 0;

    out.step = 'pickSupp';
    // escolhe o 1º suplemento REAL (com data-pid numérico, não o "adicionar novo")
    const picked = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('#lyr-flow [data-act="pickSupp"]'));
      const real = els.find((e) => { const p = e.getAttribute('data-pid'); return p && /^\d+$/.test(p); });
      if (real) { real.click(); return real.getAttribute('data-arg'); }
      return null;
    });
    out.tests.pickedSupp = !!picked;
    await page.waitForSelector('#lyr-flow [data-input="batch"]', { timeout: 5000 });
    await sleep(500); // /batches/recent

    // Bug 2: chips de lote filtrados + data relativa
    const bt = await flowText();
    out.tests.batchFetched = out.batchReqs >= 1;
    out.tests.chipShown = bt.indexOf('BR-2026-0213') >= 0;
    out.tests.relDateShown = /há \d+ dias|semana passada|ontem|hoje/.test(bt);
    out.tests.chipClickable = await exists('#lyr-flow [data-act="pickBatch"][data-arg="BR-2026-0213"]');

    await page.screenshot({ path: 'docs/design/screenshots/v17-bug23.png' });
  } catch (e) { out.errors.push('STEP ' + out.step + ': ' + e.message); }
  await browser.close();

  const t = out.tests;
  const pass = t.foundProductionLine && t.suppThumbnails && t.pickedSupp && t.batchFetched && t.chipShown && t.relDateShown && t.chipClickable && out.errors.length === 0;
  console.log(JSON.stringify(out, null, 2));
  console.log(pass ? '\nSMOKE BUG2/3: PASS' : '\nSMOKE BUG2/3: FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
