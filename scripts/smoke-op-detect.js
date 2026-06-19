'use strict';
/* Smoke LOCAL (puppeteer) da detecção passiva — Parte 1 (texto humano) + Parte 2
   ("Quando começou?"). Serve /op + intercepta /api com uma detecção mockada.
   node scripts/smoke-op-detect.js */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const ROOT = path.join(__dirname, '..', 'src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const DET = { ems_key: 'eq1:b1', machine: 'NJP1200', machine_type: 'capsule_machine', machine_label: 'máquina de cápsula', is_machine: true, stage: 'encapsulating', slug: 'encapsulation', product_name: 'Glutathione 1000mg', batch_number: 'BR-2026-0223', product_image: null };

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
  let registerBody = null;
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() => { try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.resolve({}); }; } catch (e) {} });
  page.on('pageerror', (e) => out.errors.push('PAGEERROR: ' + e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url(); if (u.indexOf('/api/') < 0) return req.continue();
    if (u.indexOf('/auth/login') >= 0) return req.respond(J({ session_token: 't', person: { id: 4, display_name: 'Vitor', role: 'operator' }, auto_logoff_seconds: 600, forgotten_check_prompts: [] }));
    if (u.indexOf('/ems/my-activity') >= 0) return req.respond(J({ detected: DET }));
    if (u.indexOf('/ems/register-detected') >= 0) { try { registerBody = JSON.parse(req.postData() || '{}'); } catch (e) {} return req.respond(J({ ok: true, event: { id: 9, slug: 'encapsulation' } })); }
    if (u.indexOf('/today') >= 0) return req.respond(J({ goal: 8, events: [] }));
    if (u.indexOf('/active-operators') >= 0) return req.respond(J({ operators: [] }));
    if (u.indexOf('/products/images') >= 0) return req.respond(J({ by_id: {} }));
    return req.respond(J({ ok: true }));
  });

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('#scr-login.on', { timeout: 10000 });
    for (const k of ['0', '0', '0', '0']) { await page.evaluate((kk) => document.querySelector('[data-act="pinkey"][data-arg="' + kk + '"]').click(), k); await sleep(50); }
    await page.waitForSelector('#scr-home.on', { timeout: 8000 }); await sleep(400);
    // PARTE 1 — texto humano no card
    const home = await page.evaluate(() => document.getElementById('scr-home').textContent);
    out.t.says_sistema_detectou = home.indexOf('O sistema detectou') >= 0;
    out.t.says_maquina_amigavel = home.indexOf('máquina de cápsula') >= 0;
    out.t.no_modelo_tecnico = home.indexOf('NJP1200') < 0; // não vaza modelo técnico
    out.t.says_produto_lote = home.indexOf('Glutathione 1000mg') >= 0 && home.indexOf('BR-2026-0223') >= 0;
    // PARTE 2 — tocar Registrar abre "Quando começou?"
    await page.evaluate(() => document.querySelector('[data-act="registerDetected"]').click());
    await page.waitForSelector('[data-act="detectPickTime"]', { timeout: 4000 }); await sleep(150);
    const ov = await page.evaluate(() => document.getElementById('lyr-overlay').textContent);
    out.t.asks_quando = ov.indexOf('Quando você começou?') >= 0;
    out.t.has_agora = !!(await page.$('[data-act="detectModeNow"]'));
    out.t.has_outra_hora = !!(await page.$('[data-act="detectPickTime"]'));
    // escolher "outra hora" → aparece time picker
    await page.evaluate(() => document.querySelector('[data-act="detectPickTime"]').click()); await sleep(200);
    out.t.shows_timepicker = !!(await page.$('[data-change="dtH"]')) && !!(await page.$('[data-change="dtM"]'));
    // voltar pra "Agora" e registrar → POST sem started_at (NOW)
    await page.evaluate(() => document.querySelector('[data-act="detectModeNow"]').click()); await sleep(150);
    await page.evaluate(() => document.querySelector('[data-act="doRegisterDetectedNow"]').click()); await sleep(400);
    out.t.registered_now = registerBody && registerBody.ems_key === 'eq1:b1' && !registerBody.started_at;
    await page.screenshot({ path: 'docs/design/screenshots/v28-detect.png' });
  } catch (e) { out.errors.push('STEP: ' + e.message); }
  await browser.close(); await new Promise((r) => server.close(r));
  const t = out.t;
  const pass = t.says_sistema_detectou && t.says_maquina_amigavel && t.no_modelo_tecnico && t.says_produto_lote
    && t.asks_quando && t.has_agora && t.has_outra_hora && t.shows_timepicker && t.registered_now && out.errors.length === 0;
  console.log(JSON.stringify(out, null, 2));
  console.log(pass ? '\nSMOKE DETECT: PASS' : '\nSMOKE DETECT: FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
