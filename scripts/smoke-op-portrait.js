'use strict';
/* Smoke do layout CELULAR VERTICAL (REGRA #0): serve os arquivos /op locais +
   intercepta /api, e em 4 viewports portrait confirma que dá pra logar, ver home,
   iniciar e finalizar SEM rotacionar e SEM overflow horizontal.
   node scripts/smoke-op-portrait.js */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..', 'src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const VIEWPORTS = [
  { name: 'iPhone SE', w: 375, h: 667 },
  { name: 'iPhone 14 Pro', w: 393, h: 852 },
  { name: 'iPhone 14 Pro Max', w: 430, h: 932 },
  { name: 'Galaxy S20', w: 360, h: 800 },
];

function serve() {
  return http.createServer((req, res) => {
    let p = req.url.split('?')[0];
    if (p === '/op/' || p === '/') p = '/op/index.html';
    if (p === '/op/config.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end("window.HF_OP_CONFIG={pageToken:'t'};"); }
    const file = path.join(ROOT, p.replace(/^\//, ''));
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
}

(async () => {
  const server = serve();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;
  const URL = `http://127.0.0.1:${PORT}/op/`;
  const out = { results: [], errors: [] };
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  for (const vp of VIEWPORTS) {
    const r = { vp: vp.name, dims: vp.w + 'x' + vp.h, t: {} };
    const page = await browser.newPage();
    try {
      await page.emulate({ viewport: { width: vp.w, height: vp.h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
      await page.evaluateOnNewDocument(() => { try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.resolve({}); }; } catch (e) {} });
      page.on('pageerror', (e) => out.errors.push(vp.name + ' PAGEERROR: ' + e.message));
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const u = req.url();
        if (u.indexOf('/api/') < 0) return req.continue();
        if (u.indexOf('/auth/login') >= 0) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ session_token: 't', person: { id: 4, display_name: 'Vitor', role: 'operator' }, auto_logoff_seconds: 600, forgotten_check_prompts: [] }) });
        if (u.indexOf('/today') >= 0) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ goal: 8, events: [{ id: 5, slug: 'production_line', started_at: new Date(Date.now() - 20 * 60000).toISOString(), ended_at: null, batch_number: 'BR-2026-0190', product: 'Magnesium Glycinate' }] }) });
        if (u.indexOf('/active-operators') >= 0) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ operators: [{ id: 6, display_name: 'Ana', online: true, current_event_id: 50, current_slug: 'cleaning', current_started_at: new Date(Date.now() - 10 * 60000).toISOString() }] }) });
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, by_id: {}, batches: [] }) });
      });

      await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForSelector('#scr-login.on', { timeout: 10000 });
      await sleep(250);
      r.t.portraitClass = await page.evaluate(() => document.documentElement.classList.contains('hf-portrait'));
      r.t.noRotatePrompt = await page.evaluate(() => !document.getElementById('hf-rotate-prompt'));
      // sem overflow horizontal (tolera 2px)
      r.t.noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
      // login visível e dentro da viewport
      r.t.loginVisible = await page.evaluate(() => { const b = document.querySelector('[data-act="pinkey"]'); if (!b) return false; const rc = b.getBoundingClientRect(); return rc.width > 20 && rc.top >= 0 && rc.left >= 0 && rc.right <= window.innerWidth + 1; });
      // login
      for (const k of ['0', '0', '0', '0']) { await page.evaluate((kk) => document.querySelector('[data-act="pinkey"][data-arg="' + kk + '"]').click(), k); await sleep(50); }
      await page.waitForSelector('#scr-home.on', { timeout: 8000 });
      await sleep(300);
      r.t.ctaVisible = await page.evaluate(() => { const b = [...document.querySelectorAll('[data-act="startFlow"]')][0]; if (!b) return false; const rc = b.getBoundingClientRect(); return rc.width > 100 && rc.left >= 0 && rc.right <= window.innerWidth + 1; });
      r.t.finishBtnVisible = await page.evaluate(() => { const b = document.querySelector('[data-act="finish"]'); if (!b) return false; const rc = b.getBoundingClientRect(); return rc.width > 20 && rc.right <= window.innerWidth + 2; });
      r.t.homeNoHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
      // abre o fluxo iniciar (modal full)
      await page.evaluate(() => document.querySelector('[data-act="startFlow"]').click());
      await page.waitForSelector('#lyr-flow.on', { timeout: 5000 });
      await sleep(200);
      r.t.flowModalVisible = await page.evaluate(() => { const m = document.querySelector('#lyr-flow [data-act="pickGroup"]'); if (!m) return false; const rc = m.getBoundingClientRect(); return rc.width > 20 && rc.left >= 0 && rc.right <= window.innerWidth + 2; });
      r.pass = r.t.portraitClass && r.t.noRotatePrompt && r.t.noHScroll && r.t.loginVisible && r.t.ctaVisible && r.t.finishBtnVisible && r.t.homeNoHScroll && r.t.flowModalVisible;
    } catch (e) { out.errors.push(vp.name + ' STEP: ' + e.message); r.pass = false; }
    await page.close();
    out.results.push(r);
  }

  await browser.close();
  await new Promise((r) => server.close(r));
  const allPass = out.results.every((r) => r.pass) && out.errors.length === 0;
  console.log(JSON.stringify(out, null, 2));
  console.log(allPass ? '\nSMOKE PORTRAIT: PASS' : '\nSMOKE PORTRAIT: FAIL');
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
