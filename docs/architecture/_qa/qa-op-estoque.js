'use strict';
/**
 * QA harness do HUB DE ESTOQUE do operador + da pagina do celular (S15 Fase 3).
 * Rodar da RAIZ do projeto:  node docs/architecture/_qa/qa-op-estoque.js
 *
 * O que faz:
 *   1. sobe um http estatico servindo src/op em /op, src/shared em /shared e
 *      src/scan em /scan (vanilla JS, nao precisa de build);
 *   2. serve /op/config.js e INTERCEPTA /api/** com fixtures locais
 *      (NUNCA fala com servidor nem banco, igual ao qa-op-ws.js);
 *   3. loga com PIN falso, roda Organizar (com scans "digitados" pelo leitor
 *      USB), a previa da pesagem em Contar, o QR de pareamento, e abre a
 *      pagina do celular; screenshots em docs/architecture/_qa/op-estoque-*.png;
 *   4. imprime PASS/FAIL e sai com 1 se algo falhar.
 *
 * Nao mexe no qa-op-ws.js nem no qa-dashboard.js (harness dos outros agentes).
 */
const puppeteer = require('puppeteer');
const http = require('http');
const path = require('path');
const fs = require('fs');

const QA = __dirname;
const ROOT = path.join(QA, '..', '..', '..');
const OPDIR = path.join(ROOT, 'src', 'op');
const SHAREDDIR = path.join(ROOT, 'src', 'shared');
const SCANDIR = path.join(ROOT, 'src', 'scan');

const results = [];
const rec = (group, name, pass, detail) => {
  results.push({ group, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? 'PASS ' : 'FAIL ') + '[' + group + '] ' + name + (detail ? '  ·  ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = 'qa-op-token';
const PERSON = { id: 7, display_name: 'QA Operadora', role: 'operator', is_sandbox: true };

// ── fixtures ─────────────────────────────────────────────────────
// Rutin: 48 g por garrafa. Bin A03B2 com tara 500 g.
const PRODUCTS = [
  { id: 42, name: 'Benfotiamine 300mg', nickname: 'Benfotiamine 300', unit_weight_g: 62, barcode: '012345678905' },
  { id: 99, name: 'Rutin 500mg', nickname: 'Rutin 500', unit_weight_g: 48, barcode: '036000291452' },
];
const BINS = [
  { id: 1, bin_code: 'A03B2', shelf_code: 'S4', area: 'P&P', qty: 4, min_qty: 10, tare_g: 500, capacity: 48, product_id: 99, product: 'Rutin 500mg', needs_restock: true },
  { id: 2, bin_code: 'A04', shelf_code: 'S4', area: 'P&P', qty: 50, min_qty: 10, tare_g: 500, product_id: 42, product: 'Benfotiamine 300mg', needs_restock: false },
];
const BOXES = [
  { id: 8, box_number: 'BX-0451', area: 'MEZ', qty: 100, tare_g: 900, product_id: 99, product: 'Rutin 500mg' },
];
const CONTEXT = { enabled: true, products: PRODUCTS, bins: BINS, boxes: BOXES };
const TASKS = {
  ok: true,
  counts: [{ bin_id: 1, bin_code: 'A03B2', product: 'Rutin 500mg', product_id: 99 }],
  restock: [{ bin_id: 1, bin_code: 'A03B2', product: 'Rutin 500mg' }],
  organize: [{ product_id: 42, product: 'Benfotiamine 300mg', qty: 24 }],
};
const RECENT = {
  ok: true,
  items: [
    { id: 1, kind: 'organize', qty: 12, product: 'Rutin 500mg', nickname: 'Rutin 500', status: 'applied', created_at: '2026-08-18T13:00:00Z' },
    { id: 2, kind: 'count', qty: 100, product: 'Rutin 500mg', nickname: 'Rutin 500', status: 'pending', created_at: '2026-08-18T12:40:00Z' },
    { id: 3, kind: 'entrada', qty: 48, product: 'Benfotiamine 300mg', nickname: 'Benfotiamine 300', status: 'approved', created_at: '2026-08-18T12:10:00Z', box_id: 8, box_number: 'BX-0451' },
  ],
};

const posted = [];

/** resolve de codigo de barras: bin, caixa, produto ou nada. */
function resolveBarcode(bc) {
  const up = String(bc || '').trim().toUpperCase();
  const bin = BINS.find((b) => b.bin_code === up);
  if (bin) return { ok: true, kind: 'bin', bin };
  const box = BOXES.find((b) => b.box_number === up);
  if (box) return { ok: true, kind: 'box', box };
  const prod = PRODUCTS.find((p) => p.barcode === String(bc).trim());
  if (prod) return { ok: true, kind: 'product', product: prod };
  return { ok: true, kind: 'unknown' };
}

function apiFixture(pathname, method, body, query) {
  if (method === 'POST') posted.push({ pathname, body });
  if (pathname === '/api/v3/scan/push') return { ok: true };
  if (pathname === '/api/v3/scan/keepalive') return { ok: true };
  const p = pathname.replace('/api/v3/op/', '');
  if (p === 'auth/login') return { ok: true, session_token: 'qa-session', person: PERSON };
  if (p === 'auth/logout') return { ok: true };
  if (p === 'stock/context') return CONTEXT;
  if (p === 'stock/tasks') return TASKS;
  if (p === 'stock/recent') return RECENT;
  if (p === 'stock/lookup') {
    const q = String((query && query.get('q')) || '').toLowerCase();
    return { ok: true, products: PRODUCTS.filter((x) => (x.name + ' ' + x.nickname).toLowerCase().includes(q)) };
  }
  if (p === 'scan/resolve') return resolveBarcode(query && query.get('barcode'));
  if (p === 'stock/organize') return { ok: true, applied: true };
  if (p === 'stock/count/weigh') return { ok: true, request_id: 91, qty: 100, confidence: 'high' };
  if (p === 'stock/count/manual') return { ok: true, request_id: 92 };
  if (p === 'stock/box/new') return { ok: true, request_id: 93, status: 'pending' };
  if (p === 'stock/box/label') {
    return { ok: true, label: { kind: 'box', code: 'BX-0451', line2: 'Rutin 500mg', qty: 100, lot: 'L-22', url: '/scan/?box=BX-0451' } };
  }
  if (p === 'scan/pair') return { ok: true, code: 'K7M2QP', expires_at: '2026-08-18T14:00:00Z', url: '/scan/?c=K7M2QP' };
  if (p === 'stock/restock') return { ok: true, applied: true };
  if (p === 'stock/take') return { ok: true, kind: 'damaged', issue_id: 5, applied: 1 };
  if (p === 'stock/propose') return { ok: true, request_id: 94, status: 'pending' };
  return { ok: true };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(u.pathname);

      if (p === '/op/config.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end('window.HF_OP_CONFIG = ' + JSON.stringify({ pageToken: TOKEN, workspace: true }) + ';');
        return;
      }
      // SSE do celular pareado: o backend e de outro agente, aqui so abrimos o
      // canal (o harness injeta os scans direto, como se tivessem chegado).
      if (p === '/api/v3/scan/stream' || p === '/api/v3/op/scan/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write('data: ' + JSON.stringify({ type: 'hello' }) + '\n\n');
        return;   // deixa aberto
      }
      if (p.startsWith('/api/')) {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(apiFixture(p, req.method, body, u.searchParams)));
        });
        return;
      }
      let file = null;
      if (p === '/' || p === '/op' || p === '/op/') file = path.join(OPDIR, 'index.html');
      else if (p === '/scan' || p === '/scan/') file = path.join(SCANDIR, 'index.html');
      else if (p.startsWith('/op/')) file = path.join(OPDIR, p.slice(4));
      else if (p.startsWith('/scan/')) file = path.join(SCANDIR, p.slice(6));
      else if (p.startsWith('/shared/')) file = path.join(SHAREDDIR, p.slice(8));
      if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await startServer();
  const BASE = 'http://127.0.0.1:' + port;
  console.log('servindo src/op + src/scan em ' + BASE + '  (API interceptada, sem rede)\n');

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });

  const EXTERNAL = /fonts\.(googleapis|gstatic)\.com|Failed to load resource|service ?worker|sw\.js/i;
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (EXTERNAL.test(t)) return;
    consoleErrors.push('console.error: ' + t.slice(0, 300));
  });

  const shot = async (name) => {
    const f = path.join(QA, 'op-estoque-' + name + '.png');
    await page.screenshot({ path: f });
    console.log('    shot → ' + path.relative(ROOT, f));
  };
  // "digita" um codigo como faria o leitor USB (o sink + Enter)
  const scan = async (code) => {
    await page.evaluate((c) => window.HF_EST.dispatchScan(c), code);
    await sleep(450);
  };

  // ── boot + login ────────────────────────────────────────────
  await page.goto(BASE + '/op/estoque.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.HF_EST, { timeout: 8000 });
  rec('boot', 'window.HF_EST definido por /op/estoque.js', true);
  rec('boot', 'Code128 e QR vendorados carregaram (sem CDN)',
    await page.evaluate(() => !!window.HF_CODE128 && typeof window.qrcode === 'function'));

  const keys = await page.$$('[data-act="pinkey"]');
  rec('login', 'keypad de PIN renderizou', keys.length === 12, keys.length + ' teclas');
  await shot('01-login');
  for (const d of ['1', '2', '3', '4']) {
    const b = await page.$('[data-act="pinkey"][data-arg="' + d + '"]');
    if (b) await b.click();
  }
  await sleep(900);
  const homeTxt = await page.evaluate(() => document.body.innerText);
  // Verbos do hub, iguais em toda a UI: Organizar · Contar · Repor · Caixa nova
  // · Devolução · Danificada (S15: "Caixa nova" chega da PRODUÇÃO, nunca de
  // fornecedor).
  rec('login', 'entrou no hub (as 6 acoes aparecem)',
    /Organizar/.test(homeTxt) && /Contar/.test(homeTxt) && /Repor/.test(homeTxt)
    && /Caixa nova/.test(homeTxt) && /Devolução/.test(homeTxt) && /Danificada/.test(homeTxt));
  rec('home', 'Caixa nova diz que vem da producao, nao de fornecedor',
    /Chegou da produção/.test(homeTxt) && !/fornecedor/i.test(homeTxt));
  rec('home', 'Tarefas de hoje veio do stock/tasks', /Tarefas de hoje/i.test(homeTxt) && /A03B2/.test(homeTxt));
  rec('home', 'Registrado hoje veio do stock/recent', /Registrado hoje/i.test(homeTxt) && /Rutin/.test(homeTxt));
  rec('home', 'chip de celular comeca em "sem celular"', /sem celular/.test(homeTxt));
  await shot('02-home');

  // ── ORGANIZAR: scan do bin → scan da garrafa → qty → POST ────
  await (await page.$('[data-act="go"][data-arg="organizar"]')).click();
  await sleep(400);
  await scan('A03B2');                       // leitor USB "digita" o codigo do bin
  const org1 = await page.evaluate(() => document.body.innerText);
  rec('organizar', 'scan do bin selecionou o destino (BIN A03B2)', /BIN A03B2/.test(org1), '');
  await scan('036000291452');                // UPC da garrafa de Rutin
  const org2 = await page.evaluate(() => document.body.innerText);
  rec('organizar', 'scan do UPC selecionou o produto (Rutin)', /Rutin/.test(org2), '');
  await shot('03-organizar');

  posted.length = 0;
  await page.evaluate(() => { window.HF_EST.state.org.qty = '12'; window.HF_EST.render(); });
  await (await page.$('[data-act="submitOrganize"]')).click();
  await sleep(800);
  const orgPost = posted.find((x) => x.pathname === '/api/v3/op/stock/organize');
  rec('organizar', 'posta stock/organize com product_id, qty e bin_id',
    !!orgPost && orgPost.body.product_id === 99 && orgPost.body.qty === 12 && orgPost.body.bin_id === 1,
    orgPost ? JSON.stringify(orgPost.body) : 'sem post');
  const orgTxt = await page.evaluate(() => document.body.innerText);
  rec('organizar', 'toast confirma onde guardou', /Guardado em/.test(orgTxt), '');
  await shot('04-organizar-toast');

  // ── CONTAR: previa da pesagem VISIVEL antes de confirmar ─────
  await (await page.$('[data-act="go"][data-arg="home"]')).click();
  await sleep(300);
  await (await page.$('[data-act="go"][data-arg="contar"]')).click();
  await sleep(400);
  await scan('A03B2');                       // bin com tara 500g e produto Rutin (48 g/un)
  const cnt0 = await page.evaluate(() => document.body.innerText);
  rec('contar', 'bin escaneado ja traz o produto cadastrado', /Rutin/.test(cnt0), '');
  rec('contar', 'mostra quanto a prateleira vazia pesa (500 g)', /vazia pesa 500 g/.test(cnt0), '');
  /* CONTAGEM CEGA (S15 §11): a tela NUNCA pode mostrar a quantidade que o
     sistema tem antes do operador confirmar, senao ele copia o numero da tela.
     A fixture do bin A03B2 tem qty 4: nem "4" solto nem o texto antigo
     "sistema diz" podem aparecer no cartao do local. */
  const blind = await page.evaluate(() => {
    const card = document.querySelector('[data-act="clearCntTarget"]');
    return card && card.parentElement ? card.parentElement.innerText : '';
  });
  rec('contar', 'contagem CEGA: nao mostra a quantidade do sistema',
    !/sistema diz/i.test(cnt0) && !/já tem/i.test(blind) && !/\b4\b/.test(blind), JSON.stringify(blind));
  rec('contar', 'explica por que o numero fica escondido',
    /Conte sem olhar o sistema/.test(cnt0) && /escondido de propósito/.test(cnt0), '');

  // 5300 g bruto - 500 tara = 4800 / 48 = 100 garrafas exatas
  await page.evaluate(() => {
    const i = document.querySelector('[data-input="cntGross"]');
    i.value = '5300';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(500);
  const cntTxt = await page.evaluate(() => document.body.innerText);
  // o micro-label sobe pra CAPS via text-transform: compara sem case.
  // A quantidade e lida do proprio bloco da previa (nao do texto solto da tela).
  const previewQty = await page.evaluate(() => {
    const n = document.querySelector('#cntPreview');
    const m = n && n.innerText.match(/\b(\d+)\b/);
    return m ? m[1] : null;
  });
  rec('contar', 'previa da pesagem aparece com a conta certa (100)',
    /dá mais ou menos/i.test(cntTxt) && previewQty === '100', 'previa=' + previewQty);
  rec('contar', 'previa mostra liquido 4800 g e sobra 0 g', /4800 g/.test(cntTxt) && /sobra 0 g/.test(cntTxt), '');
  rec('contar', 'confianca alta (sobra zero)', /confiança alta/.test(cntTxt), '');
  await shot('05-contar-pesagem');

  posted.length = 0;
  await (await page.$('[data-act="submitWeigh"]')).click();
  await sleep(800);
  const wPost = posted.find((x) => x.pathname === '/api/v3/op/stock/count/weigh');
  rec('contar', 'Confirmar posta gross_g + tara + bin_id (o servidor recalcula)',
    !!wPost && wPost.body.gross_g === 5300 && wPost.body.tare_g === 500 && wPost.body.bin_id === 1,
    wPost ? JSON.stringify(wPost.body) : 'sem post');
  // Confirmacao tem que dizer o que aconteceu E o que acontece depois.
  const cntToast = await page.evaluate(() => document.body.innerText);
  rec('contar', 'toast diz que foi enviada E que o admin aprova',
    /Contagem enviada/.test(cntToast) && /admin aprova/.test(cntToast), '');

  // "Esta vazio" = contagem no zero, um toque
  await scan('A03B2');
  posted.length = 0;
  await (await page.$('[data-act="emptyCount"]')).click();
  await sleep(800);
  const zPost = posted.find((x) => x.pathname === '/api/v3/op/stock/count/manual');
  rec('contar', '"Esta vazio" posta count/manual com qty 0',
    !!zPost && zPost.body.qty === 0, zPost ? JSON.stringify(zPost.body) : 'sem post');

  // ── ENTRADA de caixa nova ───────────────────────────────────
  await (await page.$('[data-act="go"][data-arg="home"]')).click();
  await sleep(300);
  await (await page.$('[data-act="go"][data-arg="entrada"]')).click();
  await sleep(400);
  await scan('012345678905');
  await page.evaluate(() => {
    const set = (k, v) => { const i = document.querySelector('[data-input="' + k + '"]'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
    set('entQty', '48'); set('entLot', 'L-22');
  });
  await sleep(300);
  await shot('06-entrada');
  posted.length = 0;
  await (await page.$('[data-act="submitEntrada"]')).click();
  await sleep(800);
  const bPost = posted.find((x) => x.pathname === '/api/v3/op/stock/box/new');
  rec('entrada', 'posta stock/box/new com produto, qty e lote',
    !!bPost && bPost.body.product_id === 42 && bPost.body.qty === 48 && bPost.body.batch_number === 'L-22',
    bPost ? JSON.stringify(bPost.body) : 'sem post');

  // ── PAREAR CELULAR: QR de verdade na tela ───────────────────
  await (await page.$('[data-act="go"][data-arg="home"]')).click();
  await sleep(300);
  await (await page.$('[data-act="pair"]')).click();
  await sleep(1000);
  const pairTxt = await page.evaluate(() => document.body.innerText);
  rec('parear', 'codigo de 6 caracteres na tela', /K7M2QP/.test(pairTxt), '');
  const qrInfo = await page.evaluate(() => {
    const box = document.querySelector('#pairQr');
    if (!box) return { found: false };
    const svg = box.querySelector('svg');
    const canvas = box.querySelector('canvas');
    return { found: true, svg: !!svg, canvas: !!canvas, rects: svg ? svg.querySelectorAll('rect,path').length : 0 };
  });
  rec('parear', 'QR renderizou como <svg> de verdade (nao imagem de CDN)',
    qrInfo.found && (qrInfo.svg || qrInfo.canvas) && qrInfo.rects > 0, JSON.stringify(qrInfo));
  rec('parear', 'mostra a URL /scan/?c= pro celular', /\/scan\/\?c=K7M2QP/.test(pairTxt), '');
  await shot('07-parear-qr');

  // scan chegando "do celular" cai na tela ativa
  await page.evaluate(() => { window.HF_EST.state.scr = 'organizar'; window.HF_EST.render(); });
  await scan('BX-0451');
  const phoneTxt = await page.evaluate(() => document.body.innerText);
  rec('parear', 'codigo vindo do celular entra na tela ativa (CAIXA BX-0451)', /BX-0451/.test(phoneTxt), '');

  // ── etiqueta 4x6 (Code128 + QR gerados no navegador) ─────────
  const label = await page.evaluate(() => {
    const L = window.HF_EST._.labelPayload({ code: 'BX-0451', product: 'Rutin 500mg', qty: 100, lot: 'L-22' });
    const bar = window.HF_CODE128.svg(L.code, { width: 520, height: 90 });
    const q = window.qrcode(0, 'M'); q.addData(L.url); q.make();
    return { line3: L.line3, barHasRect: bar.indexOf('<rect') > 0, qrHasSvg: q.createSvgTag({ cellSize: 3 }).indexOf('<svg') === 0 };
  });
  rec('etiqueta', 'Code 128 vira SVG com barras', label.barHasRect);
  rec('etiqueta', 'QR da etiqueta vira SVG', label.qrHasSvg);
  rec('etiqueta', 'linha 3 tem quantidade e lote', /100 garrafas/.test(label.line3) && /L-22/.test(label.line3), label.line3);

  // ── texto: regras do Bruno ──────────────────────────────────
  await (await page.$('[data-act="go"][data-arg="home"]')).click();
  await sleep(400);
  const allTxt = await page.evaluate(() => document.body.innerText);
  rec('texto', 'sem em dash na tela', !/—/.test(allTxt), (allTxt.match(/.{0,20}—.{0,20}/) || [''])[0]);
  rec('texto', 'sem entidade HTML crua vazando', !/&[a-z]+;/.test(allTxt), (allTxt.match(/&[a-z]+;/) || [''])[0]);
  await shot('08-home-final');

  // ── PAGINA DO CELULAR ───────────────────────────────────────
  const phone = await browser.newPage();
  await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phoneErrors = [];
  phone.on('pageerror', (e) => phoneErrors.push('pageerror: ' + e.message));
  phone.on('console', (m) => { if (m.type() === 'error' && !EXTERNAL.test(m.text())) phoneErrors.push(m.text().slice(0, 200)); });
  await phone.goto(BASE + '/scan/?c=K7M2QP', { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  rec('celular', 'pagina abriu sem erro de script', phoneErrors.length === 0, phoneErrors.slice(0, 2).join(' | '));
  rec('celular', 'ZXing vendorado carregou (fallback do BarcodeDetector)',
    await phone.evaluate(() => typeof window.ZXing !== 'undefined'));
  rec('celular', 'leu o codigo do par da URL', await phone.evaluate(() => window.HF_SCAN.pair() === 'K7M2QP'));
  const manualExists = await phone.$('#manual');
  rec('celular', 'campo "digitar na mao" SEMPRE existe (REGRA #0)', !!manualExists);
  // sem camera no headless: a pagina tem que AVISAR, nao quebrar
  const phoneTxt2 = await phone.evaluate(() => document.body.innerText);
  rec('celular', 'sem camera a pagina avisa e oferece digitar', /câmera|digitar/i.test(phoneTxt2), '');
  // a pill sobe pra CAPS via text-transform: compara sem case.
  rec('celular', 'diz a qual computador esta ligado', /computador K7M2QP/i.test(phoneTxt2), '');
  await phone.screenshot({ path: path.join(QA, 'op-estoque-09-celular.png') });
  console.log('    shot → docs/architecture/_qa/op-estoque-09-celular.png');

  // digitar um codigo no celular → POST /api/v3/scan/push (sem page token)
  posted.length = 0;
  await phone.type('#manual', 'BX-0451', { delay: 12 });
  await (await phone.$('#send')).click();
  await sleep(900);
  const push = posted.find((x) => x.pathname === '/api/v3/scan/push');
  rec('celular', 'posta /api/v3/scan/push com code do par + barcode',
    !!push && push.body.code === 'K7M2QP' && push.body.barcode === 'BX-0451',
    push ? JSON.stringify(push.body) : 'sem post');
  const phoneTxt3 = await phone.evaluate(() => document.body.innerText);
  rec('celular', 'mostra o ultimo codigo lido', /BX-0451/.test(phoneTxt3), '');
  await phone.screenshot({ path: path.join(QA, 'op-estoque-10-celular-enviado.png') });
  console.log('    shot → docs/architecture/_qa/op-estoque-10-celular-enviado.png');

  rec('boot', 'nenhum erro de console no fluxo inteiro', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();

  const fails = results.filter((r) => !r.pass);
  console.log('\n' + '─'.repeat(60));
  console.log(results.length - fails.length + ' PASS  ·  ' + fails.length + ' FAIL');
  fs.writeFileSync(path.join(QA, 'qa-op-estoque-report.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (fails.length) { fails.forEach((f) => console.log('  FAIL [' + f.group + '] ' + f.name + '  ' + f.detail)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
