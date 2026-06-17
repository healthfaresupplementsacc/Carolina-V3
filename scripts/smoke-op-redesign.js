'use strict';
/* Smoke do redesign /op (live) — valida o ambiente fiel + login + anti-flicker.
   Uso: node scripts/smoke-op-redesign.js [url] */
const puppeteer = require('puppeteer');
const URL = process.argv[2] || 'https://productionlineservice-production.up.railway.app/op/';
const OUT = process.argv[3] || 'docs/design/screenshots/v6-op-login.png';

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 1200)); // deixa o boot + fontes assentarem

  // marca o nó do ambiente p/ provar que NÃO é recriado (anti-flicker)
  await page.evaluate(() => { const a = document.getElementById('hf-ambient'); if (a) a.setAttribute('data-smoke', '1'); });

  const snap1 = await page.evaluate(() => {
    const amb = document.getElementById('hf-ambient');
    const html = amb ? amb.innerHTML : '';
    const imgs = amb ? amb.querySelectorAll('img').length : 0;
    // blobs = divs com radial-gradient; cápsulas = wrappers com filhos .pill
    const divs = amb ? Array.from(amb.querySelectorAll(':scope > div')) : [];
    const blobs = divs.filter((d) => /radial-gradient/.test(d.getAttribute('style') || '')).length;
    const caps = divs.filter((d) => d.children.length === 1 && d.firstElementChild && d.firstElementChild.children.length >= 2).length;
    // login
    const loginCard = !!document.querySelector('img[alt="HealthFare"]');
    const keys = Array.from(document.querySelectorAll('[data-act="pinkey"]'));
    const circular = keys.length === 12 && keys.every((k) => {
      const s = getComputedStyle(k); return s.borderRadius === '50%' || /aspect-ratio/.test(k.getAttribute('style') || '');
    });
    const mainRoot = document.getElementById('hf-main');
    return { hasAmbient: !!amb, htmlLen: html.length, imgs, blobs, caps, loginCard, keyCount: keys.length, circular, mainHasContent: !!(mainRoot && mainRoot.innerHTML.length > 100) };
  });

  await new Promise((r) => setTimeout(r, 4000)); // 4s: tempo de o flicker (se houver) recriar o DOM
  const snap2 = await page.evaluate(() => {
    const amb = document.getElementById('hf-ambient');
    return { ambientKept: !!(amb && amb.getAttribute('data-smoke') === '1'), imgs: amb ? amb.querySelectorAll('img').length : 0 };
  });

  await page.screenshot({ path: OUT });
  await browser.close();

  console.log(JSON.stringify({ url: URL, errors, snap1, snap2, screenshot: OUT }, null, 2));
  const ok = snap1.hasAmbient && snap1.imgs >= 4 && snap1.blobs === 4 && snap1.caps >= 4 && snap1.loginCard && snap1.keyCount === 12 && snap2.ambientKept && errors.length === 0;
  console.log(ok ? '\nSMOKE: PASS' : '\nSMOKE: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
