'use strict';
/* Smoke do overlay FINISH production_line (live) — sem PIN real e sem tocar o
   canal/DB reais: /api é interceptado (today devolve uma task production_line;
   /end captura o body). Valida o fluxo de contagem obrigatória + exceção.
   Uso: node scripts/smoke-op-prodcount.js [url] */
const puppeteer = require('puppeteer');
const URL = process.argv[2] || 'https://productionlineservice-production.up.railway.app/op/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jres = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

(async () => {
  const out = { url: URL, errors: [], ends: [], tests: {}, step: 'init' };
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  await page.evaluateOnNewDocument(() => { try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.resolve({ unregister: function () {} }); }; } catch (e) {} });
  page.on('pageerror', (e) => out.errors.push('PAGEERROR: ' + e.message));
  const click = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error('no element: ' + s); el.click(); }, sel);
  const setInput = (sel, val) => page.evaluate((s, v) => { const el = document.querySelector(s); if (!el) throw new Error('no input: ' + s); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, sel, val);
  const text = () => page.evaluate(() => document.getElementById('hf-canvas').textContent || '');

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.indexOf('/api/') < 0) return req.continue();
    if (u.indexOf('/auth/login') >= 0) return req.respond(jres({ session_token: 't', person: { id: 1, display_name: 'Teste', role: 'operator' }, auto_logoff_seconds: 600, forgotten_check_prompts: [] }));
    if (u.indexOf('/architect/person/') >= 0 && u.indexOf('/today') >= 0) {
      return req.respond(jres({ goal: 8, events: [{ id: 999, slug: 'production_line', started_at: new Date(Date.now() - 40 * 60000).toISOString(), ended_at: null, batch_number: 'BR-2026-0190', product: 'Magnesium Glycinate' }] }));
    }
    if (u.indexOf('/active-operators') >= 0) return req.respond(jres({ operators: [] }));
    if (/\/event\/999\/end/.test(u)) { try { out.ends.push(JSON.parse(req.postData() || '{}')); } catch (e) { out.ends.push({ _raw: req.postData() }); } return req.respond(jres({ ok: true, count_created: true, exception: false })); }
    return req.respond(jres({ ok: true }));
  });

  try {
    out.step = 'login';
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('#scr-login.on', { timeout: 15000 });
    for (const k of ['0', '0', '0', '0']) { await click('[data-act="pinkey"][data-arg="' + k + '"]'); await sleep(60); }
    await page.waitForSelector('#scr-home.on', { timeout: 10000 });
    await sleep(400);
    out.tests.taskVisible = await page.evaluate(() => !!document.querySelector('[data-act="finish"][data-arg="999"]'));

    // abre overlay finish da production_line
    out.step = 'openFinish';
    await click('[data-act="finish"][data-arg="999"]');
    await page.waitForSelector('#lyr-overlay.on [data-act="toggleExc"]', { timeout: 5000 });
    await sleep(300);
    out.tests.prodOverlay = (await text()).indexOf('Quantas bottles foram produzidas?') >= 0 && (await text()).indexOf('Exceção: não tenho o número') >= 0;

    // 1) Finalizar sem contagem → alerta "Contagem obrigatória"
    out.step = 'alertCount';
    await click('[data-act="doFinish"]');
    await page.waitForSelector('#lyr-alert.on', { timeout: 5000 });
    out.tests.alertContagem = (await text()).indexOf('Contagem obrigatória') >= 0;
    await page.keyboard.press('Escape'); await sleep(300);
    out.tests.noEndYet = out.ends.length === 0;

    // 2) marca exceção → textarea motivo aparece
    out.step = 'toggleExc';
    await click('[data-act="toggleExc"]');
    await sleep(300);
    out.tests.reasonAppears = await page.evaluate(() => !!document.querySelector('[data-input="finReason"]'));
    out.tests.warningBox = (await text()).indexOf('será enviada para Orders') >= 0;

    // 3) Finalizar com motivo curto → "Motivo obrigatório"
    out.step = 'alertReason';
    await setInput('[data-input="finReason"]', 'curto');
    await click('[data-act="doFinish"]');
    await page.waitForSelector('#lyr-alert.on', { timeout: 5000 });
    out.tests.alertMotivo = (await text()).indexOf('Motivo obrigatório') >= 0;
    await page.keyboard.press('Escape'); await sleep(300);

    // 4) motivo válido → "Confirmar exceção" → confirma → POST exception
    out.step = 'confirmExc';
    await setInput('[data-input="finReason"]', 'balanca quebrou no meio do lote, sem contagem');
    await click('[data-act="doFinish"]');
    await page.waitForSelector('#lyr-alert.on', { timeout: 5000 });
    out.tests.alertConfirm = (await text()).indexOf('Confirmar exceção') >= 0;
    await click('[data-act="alertOk"]'); // confirma
    await sleep(500);
    const last = out.ends[out.ends.length - 1] || {};
    out.tests.postedException = last.exception_no_count === true && typeof last.exception_reason === 'string' && last.exception_reason.length >= 10;

    // 5) caminho normal: reabre, preenche bottles, Finalizar Linha → POST bottles
    out.step = 'normalPath';
    await page.waitForSelector('#scr-home.on', { timeout: 8000 });
    await sleep(300);
    await click('[data-act="finish"][data-arg="999"]');
    await page.waitForSelector('#lyr-overlay.on [data-input="finBottles"]', { timeout: 5000 });
    await setInput('[data-input="finBottles"]', '742');
    await click('[data-act="doFinish"]');
    await sleep(500);
    const last2 = out.ends[out.ends.length - 1] || {};
    out.tests.postedBottles = last2.bottles === 742;

    await page.screenshot({ path: 'docs/design/screenshots/v10-prodcount.png' });
  } catch (e) { out.errors.push('STEP ' + out.step + ': ' + e.message); }
  await browser.close();

  const t = out.tests;
  const pass = t.taskVisible && t.prodOverlay && t.alertContagem && t.noEndYet && t.reasonAppears && t.warningBox
    && t.alertMotivo && t.alertConfirm && t.postedException && t.postedBottles && out.errors.length === 0;
  console.log(JSON.stringify(out, null, 2));
  console.log(pass ? '\nSMOKE PRODCOUNT: PASS' : '\nSMOKE PRODCOUNT: FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
