'use strict';
/* Smoke LOCAL da Passada 2: overlays de GAP e FIM-DO-DIA + cascades.
   Serve /op local + intercepta /api. node scripts/smoke-op-passada2.js */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const ROOT = path.join(__dirname, '..', 'src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function serve() {
  return http.createServer((req, res) => {
    let p = req.url.split('?')[0]; if (p === '/op/' || p === '/') p = '/op/index.html';
    if (p === '/op/config.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end("window.HF_OP_CONFIG={pageToken:'t'};"); }
    fs.readFile(path.join(ROOT, p.replace(/^\//, '')), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); res.end(buf);
    });
  });
}
const loginBody = { session_token: 't', person: { id: 4, display_name: 'Vitor', role: 'operator' }, auto_logoff_seconds: 600, forgotten_check_prompts: [] };

async function newPage(browser, onApi) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  await page.evaluateOnNewDocument(() => { try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.resolve({}); }; } catch (e) {} });
  await page.setRequestInterception(true);
  page.on('request', (req) => { const u = req.url(); if (u.indexOf('/api/') < 0) return req.continue(); onApi(u, req); });
  return page;
}

(async () => {
  const server = serve(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const URL = `http://127.0.0.1:${server.address().port}/op/`;
  const out = { errors: [], gap: {}, eod: {} };
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  // ───────────────────── GAP ─────────────────────
  try {
    let startCalls = 0;
    const page = await newPage(browser, (u, req) => {
      if (u.indexOf('/auth/login') >= 0) return req.respond(J(loginBody));
      if (u.indexOf('/today') >= 0) return req.respond(J({ goal: 8, events: [] }));
      if (u.indexOf('/active-operators') >= 0) return req.respond(J({ operators: [] }));
      if (u.indexOf('/products/images') >= 0) return req.respond(J({ by_id: {} }));
      if (u.indexOf('/gap/justify') >= 0) return req.respond(J({ ok: true, gap_minutes: 25 }));
      if (/\/event\/start/.test(u)) { startCalls++; if (startCalls === 1) return req.respond(J({ ok: true, gap_detected: true, gap_minutes: 25, gap_started_at: new Date(Date.now() - 25 * 60000).toISOString() })); return req.respond(J({ ok: true, event: { id: 1, slug: 'cleaning' } })); }
      return req.respond(J({ ok: true }));
    });
    page.on('pageerror', (e) => out.errors.push('GAP PAGEERROR: ' + e.message));
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('#scr-login.on', { timeout: 10000 });
    for (const k of ['0', '0', '0', '0']) { await page.evaluate((kk) => document.querySelector('[data-act="pinkey"][data-arg="' + kk + '"]').click(), k); await sleep(50); }
    await page.waitForSelector('#scr-home.on', { timeout: 8000 }); await sleep(300);
    await page.evaluate(() => document.querySelector('[data-act="startFlow"]').click());
    await page.waitForSelector('#lyr-flow.on', { timeout: 5000 }); await sleep(200);
    // navega grupos até achar cleaning
    const groups = await page.evaluate(() => Array.from(document.querySelectorAll('#lyr-flow [data-act="pickGroup"]')).map((b) => b.getAttribute('data-arg')));
    let found = false;
    for (const g of groups) {
      await page.evaluate((gg) => { const b = document.querySelector('#lyr-flow [data-act="pickGroup"][data-arg="' + gg + '"]'); if (b) b.click(); }, g); await sleep(200);
      if (await page.$('#lyr-flow [data-act="pickType"][data-arg="cleaning"]')) { found = true; break; }
      await page.evaluate(() => { const b = document.querySelector('#lyr-flow [data-act="flowBack"]'); if (b) b.click(); }); await sleep(150);
    }
    out.gap.foundCleaning = found;
    await page.evaluate(() => document.querySelector('#lyr-flow [data-act="pickType"][data-arg="cleaning"]').click());
    await sleep(250);
    await page.evaluate(() => { const b = document.querySelector('#lyr-flow [data-act="confirmStart"]'); if (b) b.click(); });
    await page.waitForSelector('#lyr-overlay.on', { timeout: 5000 }); await sleep(250);
    out.gap.overlayShown = (await page.evaluate(() => document.getElementById('hf-canvas').textContent)).indexOf('Gap de atividade') >= 0;
    await page.evaluate(() => document.querySelector('[data-act="gapReason"][data-arg="bathroom"]').click()); await sleep(150);
    await page.evaluate(() => { const t = document.querySelector('[data-input="gapNote"]'); t.value = 'fui ao banheiro'; t.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => document.querySelector('[data-act="doGapJustify"]').click());
    await sleep(600);
    out.gap.closedAndStarted = await page.evaluate(() => !document.getElementById('lyr-overlay').classList.contains('on'));
    out.gap.startCalls = startCalls; // 2 = gap + ack
    await page.close();
  } catch (e) { out.errors.push('GAP STEP: ' + e.message); }

  // ───────────────────── FIM DO DIA ─────────────────────
  try {
    const page = await newPage(browser, (u, req) => {
      if (u.indexOf('/auth/login') >= 0) return req.respond(J(loginBody));
      if (u.indexOf('/today') >= 0) return req.respond(J({ goal: 8, events: [{ id: 5, slug: 'production_line', started_at: new Date(Date.now() - 30 * 60000).toISOString(), ended_at: null, batch_number: 'BR-2026-0190', product: 'Magnesium' }] }));
      if (u.indexOf('/active-operators') >= 0) return req.respond(J({ operators: [] }));
      if (u.indexOf('/products/images') >= 0) return req.respond(J({ by_id: {} }));
      if (/\/finish-preview/.test(u)) return req.respond(J({ ok: true, is_cowork: false, is_last_finisher: true, requires_bottle_count: true }));
      if (/\/event\/5\/end/.test(u)) return req.respond(J({ ok: true, count_created: true }));
      if (u.indexOf('/end-of-day/check') >= 0) return req.respond(J({ pending: true, already_submitted: false, should_prompt_user: true, current_hour_edt: 18, products: [{ product_id: 8, product: 'Magnesium Glycinate', count_so_far: 200 }] }));
      if (u.indexOf('/end-of-day/submit') >= 0) return req.respond(J({ ok: true }));
      return req.respond(J({ ok: true }));
    });
    page.on('pageerror', (e) => out.errors.push('EOD PAGEERROR: ' + e.message));
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('#scr-login.on', { timeout: 10000 });
    for (const k of ['0', '0', '0', '0']) { await page.evaluate((kk) => document.querySelector('[data-act="pinkey"][data-arg="' + kk + '"]').click(), k); await sleep(50); }
    await page.waitForSelector('#scr-home.on', { timeout: 8000 }); await sleep(300);
    await page.evaluate(() => document.querySelector('[data-act="finish"][data-arg="5"]').click());
    await page.waitForSelector('#lyr-overlay.on [data-input="finBottles"]', { timeout: 5000 });
    await page.evaluate(() => { const i = document.querySelector('[data-input="finBottles"]'); i.value = '746'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => document.querySelector('[data-act="doFinish"]').click());
    await page.waitForFunction(() => { const c = document.getElementById('hf-canvas'); return c && c.textContent.indexOf('Totais do dia') >= 0; }, { timeout: 6000 });
    out.eod.overlayShown = true;
    await page.evaluate(() => { const i = document.querySelector('[data-input="eodBottles"]'); if (i) { i.value = '1500'; i.dispatchEvent(new Event('input', { bubbles: true })); } });
    await page.evaluate(() => document.querySelector('[data-act="doEodSubmit"]').click());
    await sleep(600);
    out.eod.submittedClosed = await page.evaluate(() => !document.getElementById('lyr-overlay').classList.contains('on'));
    await page.close();
  } catch (e) { out.errors.push('EOD STEP: ' + e.message); }

  await browser.close(); await new Promise((r) => server.close(r));
  const pass = out.gap.foundCleaning && out.gap.overlayShown && out.gap.closedAndStarted && out.gap.startCalls === 2
    && out.eod.overlayShown && out.eod.submittedClosed && out.errors.length === 0;
  console.log(JSON.stringify(out, null, 2));
  console.log(pass ? '\nSMOKE PASSADA 2: PASS' : '\nSMOKE PASSADA 2: FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
