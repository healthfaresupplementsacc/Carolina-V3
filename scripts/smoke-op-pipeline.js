'use strict';
/* Smoke LOCAL da FASE 4: Linha de Produção mostra LISTA lote+produto (não suplemento).
   Serve /op local + intercepta /api. node scripts/smoke-op-pipeline.js */
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

(async () => {
  const server = serve(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const URL = `http://127.0.0.1:${server.address().port}/op/`;
  const out = { errors: [], t: {} };
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() => { try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.resolve({}); }; } catch (e) {} });
  page.on('pageerror', (e) => out.errors.push('PAGEERROR: ' + e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url(); if (u.indexOf('/api/') < 0) return req.continue();
    if (u.indexOf('/auth/login') >= 0) return req.respond(J({ session_token: 't', person: { id: 4, display_name: 'Vitor', role: 'operator' }, auto_logoff_seconds: 600, forgotten_check_prompts: [] }));
    if (u.indexOf('/today') >= 0) return req.respond(J({ goal: 8, events: [] }));
    if (u.indexOf('/active-operators') >= 0) return req.respond(J({ operators: [] }));
    if (u.indexOf('/products/images') >= 0) return req.respond(J({ by_id: {} }));
    if (u.indexOf('/lots/available') >= 0) return req.respond(J({ lots: [
      { batch_number: 'BR-2026-0218', product_name: 'Plant Sterols', product_image: null, stage: 'on_line' },
      { batch_number: 'BR-2026-0223', product_name: 'Glutathione 1000mg', product_image: null, stage: 'encapsulated' },
    ], ems_stale: false }));
    return req.respond(J({ ok: true }));
  });

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('#scr-login.on', { timeout: 10000 });
    for (const k of ['0', '0', '0', '0']) { await page.evaluate((kk) => document.querySelector('[data-act="pinkey"][data-arg="' + kk + '"]').click(), k); await sleep(50); }
    await page.waitForSelector('#scr-home.on', { timeout: 8000 }); await sleep(300);
    await page.evaluate(() => document.querySelector('[data-act="startFlow"]').click());
    await page.waitForSelector('#lyr-flow.on', { timeout: 5000 }); await sleep(200);
    // navega até achar production_line
    const groups = await page.evaluate(() => Array.from(document.querySelectorAll('#lyr-flow [data-act="pickGroup"]')).map((b) => b.getAttribute('data-arg')));
    for (const g of groups) {
      await page.evaluate((gg) => { const b = document.querySelector('#lyr-flow [data-act="pickGroup"][data-arg="' + gg + '"]'); if (b) b.click(); }, g); await sleep(200);
      if (await page.$('#lyr-flow [data-act="pickType"][data-arg="production_line"]')) break;
      await page.evaluate(() => { const b = document.querySelector('#lyr-flow [data-act="flowBack"]'); if (b) b.click(); }); await sleep(150);
    }
    await page.evaluate(() => document.querySelector('#lyr-flow [data-act="pickType"][data-arg="production_line"]').click());
    await page.waitForSelector('#lyr-flow [data-act="pickLot"]', { timeout: 5000 }); await sleep(200);
    const txt = await page.evaluate(() => document.getElementById('lyr-flow').textContent);
    out.t.listShown = txt.indexOf('BR-2026-0218') >= 0 && txt.indexOf('Plant Sterols') >= 0;
    out.t.searchInput = await page.evaluate(() => !!document.querySelector('[data-input="lotQuery"]'));
    out.t.fallbackLink = txt.indexOf('catálogo completo') >= 0;
    // busca filtra
    await page.evaluate(() => { const i = document.querySelector('[data-input="lotQuery"]'); i.value = '0223'; i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(200);
    const txt2 = await page.evaluate(() => document.getElementById('lyr-flow').textContent);
    out.t.searchFilters = txt2.indexOf('BR-2026-0223') >= 0 && txt2.indexOf('BR-2026-0218') < 0;
    // limpa busca + pick
    await page.evaluate(() => { const i = document.querySelector('[data-input="lotQuery"]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(150);
    await page.evaluate(() => document.querySelector('[data-act="pickLot"][data-arg="BR-2026-0218"]').click()); await sleep(250);
    const conf = await page.evaluate(() => document.getElementById('lyr-flow').textContent);
    out.t.confirmShowsLotProduct = conf.indexOf('BR-2026-0218') >= 0 && conf.indexOf('Plant Sterols') >= 0 && conf.indexOf('Começar') >= 0;
    await page.screenshot({ path: 'docs/design/screenshots/v25-pipeline.png' });
  } catch (e) { out.errors.push('STEP: ' + e.message); }
  await browser.close(); await new Promise((r) => server.close(r));
  const t = out.t;
  const pass = t.listShown && t.searchInput && t.fallbackLink && t.searchFilters && t.confirmShowsLotProduct && out.errors.length === 0;
  console.log(JSON.stringify(out, null, 2));
  console.log(pass ? '\nSMOKE PIPELINE: PASS' : '\nSMOKE PIPELINE: FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
