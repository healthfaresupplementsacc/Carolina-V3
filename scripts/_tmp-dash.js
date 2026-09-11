const puppeteer = require('puppeteer');
(async () => {
  const H = 'https://productionlineservice-production.up.railway.app';
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await b.newPage(); await page.setViewport({ width: 1600, height: 1000 }); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(H + '/dashboard-v4/', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(async () => { const r = await fetch('/api/v3/data/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '150000' }) }); const j = await r.json(); sessionStorage.setItem('v3pin', '150000'); sessionStorage.setItem('v3login', JSON.stringify(j.data || j)); });
  await page.goto(H + '/dashboard-v4/#hoje', { waitUntil: 'networkidle2', timeout: 60000 }); await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }); await new Promise((r) => setTimeout(r, 2500));
  const pinInput = await page.$('input[placeholder*="•"], input[type="password"]');
  if (pinInput) { await pinInput.type(process.env.CAM_VIEW_PIN); await page.keyboard.press('Enter'); await new Promise((r) => setTimeout(r, 6000)); }
  const tiles = await page.evaluate(() => Array.from(document.querySelectorAll('[data-cam], .cam-tile, .camgrid-tile')).map((t) => t.getAttribute('data-cam') || t.className).slice(0, 8));
  const txt = await page.evaluate(() => document.body.innerText);
  console.log('tiles:', JSON.stringify(tiles), '| storage no texto:', /Storage \(Cam 2\)|storage/i.test(txt), '| errors:', errs.join('|') || 'none');
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
