'use strict';
/* Smoke do fluxo COWORK no /op (live) — sem PIN real, /api interceptado.
   Valida o FIX do bottle-count do último (detect upfront via finish-preview):
   A) membro NÃO-último → overlay "Terminei minha parte" (sem bottles), fecha.
   B) ÚLTIMO de production_line → bottles UPFRONT + banner (SEM precisar do bounce).
   C) regressão: corrida (preview disse não-último, mas /end devolve a 400 REAL
      {error,detail}) → fallback ainda abre a contagem (lê e.body.error, não message).
   Uso: node scripts/smoke-op-cowork.js [url] */
const puppeteer = require('puppeteer');
const URL = process.argv[2] || 'https://productionlineservice-production.up.railway.app/op/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jres = (o, status) => ({ status: status || 200, contentType: 'application/json', body: JSON.stringify(o) });

(async () => {
  const out = { url: URL, errors: [], tests: {}, step: 'init', ends: [], previews: 0 };
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  await page.evaluateOnNewDocument(() => { try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.resolve({ unregister: function () {} }); }; } catch (e) {} });
  page.on('pageerror', (e) => out.errors.push('PAGEERROR: ' + e.message));
  const click = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error('no element: ' + s); el.click(); }, sel);
  const setInput = (sel, v) => page.evaluate((s, val) => { const el = document.querySelector(s); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, sel, v);
  const exists = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);
  const overlayClosed = () => page.evaluate(() => !document.getElementById('lyr-overlay').classList.contains('on'));
  const text = () => page.evaluate(() => document.getElementById('hf-canvas').textContent || '');

  let previewCall = 0, noBottlesEnd = 0;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.indexOf('/api/') < 0) return req.continue();
    if (u.indexOf('/auth/login') >= 0) return req.respond(jres({ session_token: 't', person: { id: 4, display_name: 'Vitor', role: 'operator' }, auto_logoff_seconds: 600, forgotten_check_prompts: [] }));
    if (u.indexOf('/architect/person/') >= 0 && u.indexOf('/today') >= 0) {
      return req.respond(jres({ goal: 8, events: [{ id: 999, slug: 'production_line', started_at: new Date(Date.now() - 40 * 60000).toISOString(), ended_at: null, batch_number: 'BR-2026-0190', product: 'Magnesium Glycinate', cowork_group_id: 'g1', cowork_with: [6] }] }));
    }
    if (u.indexOf('/active-operators') >= 0) return req.respond(jres({ operators: [] }));
    if (/\/event\/999\/finish-preview/.test(u)) {
      previewCall++; out.previews = previewCall;
      // call 2 = teste B (ÚLTIMO de production_line); demais = não-último
      if (previewCall === 2) return req.respond(jres({ ok: true, event_id: 999, slug: 'production_line', is_cowork: true, is_last_finisher: true, requires_bottle_count: true, cowork_remaining: 0 }));
      return req.respond(jres({ ok: true, event_id: 999, slug: 'production_line', is_cowork: true, is_last_finisher: false, requires_bottle_count: false, cowork_remaining: 1 }));
    }
    if (/\/event\/999\/end/.test(u)) {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
      out.ends.push(body);
      if (body.bottles > 0) return req.respond(jres({ ok: true, is_last_finisher: true, count_created: true }));
      noBottlesEnd++;
      if (noBottlesEnd === 1) return req.respond(jres({ ok: true, is_last_finisher: false, remaining: 1, count_created: false })); // teste A
      return req.respond(jres({ error: 'bottles_required', detail: 'Informe quantas bottles foram produzidas (ou marque a exceção).' }, 400)); // teste C: shape REAL
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

    // ── A: membro NÃO-último → "Terminei minha parte" (sem bottles) ──
    out.step = 'A_memberNotLast';
    await click('[data-act="finish"][data-arg="999"]');
    await page.waitForSelector('#lyr-overlay.on [data-act="doFinish"]', { timeout: 5000 });
    await sleep(350); // deixa o finish-preview retornar
    out.tests.A_simplified = (await text()).indexOf('Terminei minha parte') >= 0;
    out.tests.A_noBottles = !(await exists('[data-input="finBottles"]'));
    await click('[data-act="doFinish"]');
    await sleep(500);
    out.tests.A_closed = await overlayClosed();

    // ── B: ÚLTIMO de production_line → bottles UPFRONT + banner (sem bounce) ──
    out.step = 'B_lastUpfront';
    await page.waitForSelector('#scr-home.on', { timeout: 8000 });
    await sleep(300);
    await click('[data-act="finish"][data-arg="999"]');
    await page.waitForSelector('#lyr-overlay.on [data-input="finBottles"]', { timeout: 5000 }); // bottles apareceu via preview
    out.tests.B_bottlesUpfront = await exists('[data-input="finBottles"]');
    const tB = await text();
    out.tests.B_lastBanner = tB.indexOf('último a finalizar') >= 0;
    out.tests.B_notSimplified = tB.indexOf('Terminei minha parte') < 0;
    await setInput('[data-input="finBottles"]', '900');
    await click('[data-act="doFinish"]');
    await sleep(500);
    out.tests.B_closed = await overlayClosed();
    out.tests.B_postedBottles = (out.ends[out.ends.length - 1] || {}).bottles === 900;

    // ── C: corrida — preview disse não-último, /end devolve 400 REAL → fallback bounce ──
    out.step = 'C_raceFallback';
    await page.waitForSelector('#scr-home.on', { timeout: 8000 });
    await sleep(300);
    await click('[data-act="finish"][data-arg="999"]');
    await page.waitForSelector('#lyr-overlay.on [data-act="doFinish"]', { timeout: 5000 });
    await sleep(300);
    out.tests.C_simplifiedFirst = (await text()).indexOf('Terminei minha parte') >= 0;
    await click('[data-act="doFinish"]'); // /end sem bottles → 400 {error,detail} → bounce
    await page.waitForSelector('#lyr-overlay.on [data-input="finBottles"]', { timeout: 5000 });
    out.tests.C_bouncedToCount = await exists('[data-input="finBottles"]');
    await setInput('[data-input="finBottles"]', '850');
    await click('[data-act="doFinish"]');
    await sleep(500);
    out.tests.C_closed = await overlayClosed();
    out.tests.C_postedBottles = (out.ends[out.ends.length - 1] || {}).bottles === 850;

    await page.screenshot({ path: 'docs/design/screenshots/v16-cowork.png' });
  } catch (e) { out.errors.push('STEP ' + out.step + ': ' + e.message); }
  await browser.close();

  const t = out.tests;
  const pass = t.taskVisible
    && t.A_simplified && t.A_noBottles && t.A_closed
    && t.B_bottlesUpfront && t.B_lastBanner && t.B_notSimplified && t.B_closed && t.B_postedBottles
    && t.C_simplifiedFirst && t.C_bouncedToCount && t.C_closed && t.C_postedBottles
    && out.errors.length === 0;
  console.log(JSON.stringify(out, null, 2));
  console.log(pass ? '\nSMOKE COWORK: PASS' : '\nSMOKE COWORK: FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
