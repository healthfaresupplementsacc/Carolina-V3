'use strict';
/* Smoke dos 3 bugs (live): rotate só em touch+portrait; ambiente cobre 100% da
   viewport (não corta) em vários aspect ratios; canvas transparente.
   Uso: node scripts/smoke-op-3bugs.js [url] */
const puppeteer = require('puppeteer');
const URL = process.argv[2] || 'https://productionlineservice-production.up.railway.app/op/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(page) {
  return page.evaluate(() => {
    const amb = document.getElementById('hf-ambient');
    const stage = document.getElementById('hf-stage');
    const prompt = document.getElementById('hf-rotate-prompt');
    const canvas = document.getElementById('hf-canvas');
    const r = amb ? amb.getBoundingClientRect() : { width: 0, height: 0, left: 99, top: 99 };
    const blobs = amb ? Array.from(amb.querySelectorAll(':scope > div')).filter((d) => /radial-gradient/.test(d.getAttribute('style') || '')).length : 0;
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      ambInStage: !!(amb && stage && amb.parentElement === stage),
      ambW: Math.round(r.width), ambH: Math.round(r.height), ambLeft: Math.round(r.left), ambTop: Math.round(r.top),
      ambImgs: amb ? amb.querySelectorAll('img').length : 0,
      ambBlobs: blobs,
      canvasTransparent: canvas ? getComputedStyle(canvas).backgroundColor === 'rgba(0, 0, 0, 0)' : false,
      rotateShown: prompt ? getComputedStyle(prompt).display !== 'none' : false,
      stageShown: stage ? getComputedStyle(stage).display !== 'none' : false,
      scale: document.documentElement.getAttribute('data-hf-scale'),
    };
  });
}

(async () => {
  const out = { url: URL, landscape: [], desktopNarrow: {}, touchPortrait: {}, errors: [], pass: true };
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.resolve({ unregister: function () {} }); }; } catch (e) {} });
  page.on('pageerror', (e) => out.errors.push('PAGEERROR: ' + e.message));

  // landscape (sem touch): ambiente cobre a viewport, não corta; rotate escondido
  for (const vp of [{ w: 1920, h: 1080 }, { w: 2560, h: 1080 }, { w: 1280, h: 800 }]) {
    await page.setViewport({ width: vp.w, height: vp.h, hasTouch: false, isMobile: false });
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('#scr-login.on', { timeout: 15000 });
    await sleep(300);
    const m = await probe(page);
    const ambientCovers = m.ambInStage && m.ambW >= vp.w - 2 && m.ambH >= vp.h - 2 && m.ambLeft <= 1 && m.ambTop <= 1;
    const hasFloaters = m.ambImgs >= 4 && m.ambBlobs === 4;
    const ok = ambientCovers && hasFloaters && m.canvasTransparent && !m.rotateShown && m.stageShown;
    if (!ok) out.pass = false;
    out.landscape.push({ vp: vp.w + 'x' + vp.h, ambient: m.ambW + 'x' + m.ambH, covers: ambientCovers, imgs: m.ambImgs, blobs: m.ambBlobs, canvasTransparent: m.canvasTransparent, rotateShown: m.rotateShown, ok });
    await page.screenshot({ path: 'docs/design/screenshots/v11-ambient-' + vp.w + 'x' + vp.h + '.png' });
  }

  // PC desktop com janela estreita+alta (SEM touch) → NÃO mostra rotate (BUG1 fix)
  await page.setViewport({ width: 700, height: 900, hasTouch: false, isMobile: false });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(400);
  out.desktopNarrow = await probe(page);
  if (out.desktopNarrow.rotateShown || !out.desktopNarrow.stageShown) out.pass = false;

  // tablet/celular TOUCH em portrait → mostra rotate
  await page.setViewport({ width: 800, height: 1280, hasTouch: true, isMobile: true });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(400);
  out.touchPortrait = await probe(page);
  if (!out.touchPortrait.rotateShown || out.touchPortrait.stageShown) out.pass = false;

  await browser.close();
  console.log(JSON.stringify(out, null, 2));
  console.log(out.pass && out.errors.length === 0 ? '\nSMOKE 3BUGS: PASS' : '\nSMOKE 3BUGS: FAIL');
  process.exit(out.pass && out.errors.length === 0 ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
