'use strict';
/* Smoke FIT-TO-VIEWPORT do /op (live) — valida que o canvas 1440x900 escala
   pra caber 100% sem scroll em todas as telas do Bruno; aviso de girar em
   portrait. SW desligado no harness (login não chama /api). Uso:
   node scripts/smoke-op-fit.js [url] */
const puppeteer = require('puppeteer');
const URL = process.argv[2] || 'https://productionlineservice-production.up.railway.app/op/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jres = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const VPS = [
  { w: 1920, h: 1080, table: 1.20 },
  { w: 1920, h: 1280, table: 1.25 },
  { w: 1366, h: 768, table: 0.85 },
  { w: 2160, h: 1440, table: 1.25 },
  { w: 1280, h: 800, table: 0.88 },
  { w: 1024, h: 768, table: 0.71 },
];
function expScale(w, h) { return Math.min(Math.max(Math.min(w / 1440, h / 900), 0.35), 1.25); }

(async () => {
  const out = { url: URL, landscape: [], portrait: {}, loggedIn: {}, errors: [], pass: true };
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.resolve({ unregister: function () {} }); }; } catch (e) {} });
  page.on('pageerror', (e) => out.errors.push('PAGEERROR: ' + e.message));

  for (const vp of VPS) {
    await page.setViewport({ width: vp.w, height: vp.h });
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('#scr-login.on', { timeout: 15000 });
    await sleep(350);
    const m = await page.evaluate(() => {
      const c = document.getElementById('hf-canvas');
      const r = c.getBoundingClientRect();
      const keys = document.querySelectorAll('[data-act="pinkey"]');
      const keyW = keys.length ? Math.round(keys[0].getBoundingClientRect().width) : 0;
      const logo = !!document.querySelector('#scr-login img[alt="HealthFare"]');
      const txt = (document.getElementById('hf-canvas').textContent || '').indexOf('Linha de Produção') >= 0;
      return {
        scale: parseFloat(document.documentElement.getAttribute('data-hf-scale')),
        pageScrollH: document.scrollingElement.scrollHeight, innerH: window.innerHeight, innerW: window.innerWidth,
        canvasW: Math.round(r.width), canvasH: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top),
        keys: keys.length, keyW: keyW, logo: logo, txt: txt,
      };
    });
    const exp = expScale(vp.w, vp.h);
    const zeroScroll = m.pageScrollH <= m.innerH + 1;
    const fits = m.canvasW <= vp.w + 1 && m.canvasH <= vp.h + 1 && m.left >= -1 && m.top >= -1;
    const scaleOk = Math.abs(m.scale - exp) < 0.02;
    const tableOk = Math.abs(m.scale - vp.table) <= 0.02;
    const loginOk = m.logo && m.keys === 12 && m.txt;
    const ok = scaleOk && tableOk && zeroScroll && fits && loginOk && m.keyW >= 36;
    if (!ok) out.pass = false;
    out.landscape.push({ vp: vp.w + 'x' + vp.h, scale: m.scale, expected: exp, table: vp.table, zeroScroll, fits, loginOk, keyW: m.keyW, canvas: m.canvasW + 'x' + m.canvasH, ok });
    await page.screenshot({ path: 'docs/design/screenshots/v9-fit-' + vp.w + 'x' + vp.h + '.png' });
  }

  // portrait 800x1280: aviso de girar visível, palco escondido
  await page.setViewport({ width: 800, height: 1280 });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(400);
  out.portrait = await page.evaluate(() => {
    const rp = document.getElementById('hf-rotate-prompt'), st = document.getElementById('hf-stage');
    return { rotateVisible: getComputedStyle(rp).display !== 'none', stageHidden: getComputedStyle(st).display === 'none' };
  });
  if (!(out.portrait.rotateVisible && out.portrait.stageHidden)) out.pass = false;
  await page.screenshot({ path: 'docs/design/screenshots/v9-fit-portrait.png' });

  // logado @1366x768: home (hero+CTA+colunas) + flow (header+body+footer) visíveis, sem scroll
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.indexOf('/api/') < 0) return req.continue();
    if (u.indexOf('/auth/login') >= 0) return req.respond(jres({ session_token: 't', person: { id: 1, display_name: 'Teste', role: 'operator' }, auto_logoff_seconds: 600, forgotten_check_prompts: [] }));
    if (u.indexOf('/architect/person/') >= 0 && u.indexOf('/today') >= 0) return req.respond(jres({ events: [], goal: 8 }));
    if (u.indexOf('/active-operators') >= 0) return req.respond(jres({ operators: [] }));
    return req.respond(jres({ ok: true }));
  });
  await page.setViewport({ width: 1366, height: 768 });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('#scr-login.on', { timeout: 15000 });
  for (const k of ['0', '0', '0', '0']) { await page.evaluate((s) => document.querySelector(s).click(), '[data-act="pinkey"][data-arg="' + k + '"]'); await sleep(70); }
  await page.waitForSelector('#scr-home.on', { timeout: 10000 });
  await sleep(400);
  const home = await page.evaluate(() => ({
    hero: !!document.querySelector('#scr-home [id="hf-clock"]'),
    cta: !!document.querySelector('[data-act="startFlow"]'),
    mine: (document.getElementById('hf-canvas').textContent || '').indexOf('Minhas tarefas') >= 0,
    team: (document.getElementById('hf-canvas').textContent || '').indexOf('Equipe agora') >= 0,
    pageScrollH: document.scrollingElement.scrollHeight, innerH: window.innerHeight,
  }));
  await page.evaluate((s) => document.querySelector(s).click(), '[data-act="startFlow"]');
  await page.waitForSelector('#lyr-flow.on', { timeout: 5000 });
  await sleep(300);
  const flow = await page.evaluate(() => {
    const fl = document.getElementById('lyr-flow'); const r = fl.querySelector('.hf-scroll').getBoundingClientRect();
    return { crumbs: !!fl.querySelector('#flow-crumbs'), body: !!fl.querySelector('#flow-body'), within: r.top >= -1 && r.bottom <= window.innerHeight + 1 };
  });
  out.loggedIn = { home: home, flow: flow };
  if (!(home.hero && home.cta && home.mine && home.team && home.pageScrollH <= home.innerH + 1 && flow.crumbs && flow.body && flow.within)) out.pass = false;
  await page.screenshot({ path: 'docs/design/screenshots/v9-fit-home-1366.png' });

  await browser.close();
  console.log(JSON.stringify(out, null, 2));
  console.log(out.pass && out.errors.length === 0 ? '\nSMOKE FIT: PASS' : '\nSMOKE FIT: FAIL');
  process.exit(out.pass && out.errors.length === 0 ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
