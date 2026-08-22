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
const PRINTDIR = path.join(ROOT, 'src', 'print');

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
  // caixa SEM tara cadastrada: e aqui que os presets de tara tem que aparecer
  { id: 9, box_number: 'BX-0452', area: 'MEZ', qty: 60, product_id: 99, product: 'Rutin 500mg' },
  /* Bruno 08-22: caixa registrada por TIPO (20x20x20), pesada vazia em ~10:
     tara media 782 g, espalhamento real 96 g. O shape box_type e o que o hub
     espera do stock/context quando o backend pendurar o tipo na linha da
     caixa (gap anotado pro agente do backend). */
  { id: 10, box_number: 'BX-0453', area: 'MEZ', qty: 0, product_id: 99, product: 'Rutin 500mg',
    box_type: { id: 1, name: '20x20x20', tare_g: 782, spread_g: 96 } },
];
const CONTEXT = { enabled: true, products: PRODUCTS, bins: BINS, boxes: BOXES };
const TASKS = {
  ok: true,
  counts: [{ bin_id: 1, bin_code: 'A03B2', product: 'Rutin 500mg', product_id: 99 }],
  restock: [{ bin_id: 1, bin_code: 'A03B2', product: 'Rutin 500mg' }],
  organize: [{ product_id: 42, product: 'Benfotiamine 300mg', qty: 24 }],
  // contrato (1): presets de tara pro seletor da tela de Contar
  tares: [
    { id: 1, name: 'caixa pequena', kind: 'box', tare_g: 420 },
    { id: 2, name: 'caixa média', kind: 'box', tare_g: 780 },
    { id: 3, name: 'bandeja azul', kind: 'bin', tare_g: 310 },
  ],
};
const RECENT = {
  ok: true,
  items: [
    { id: 1, kind: 'organize', qty: 12, product: 'Rutin 500mg', nickname: 'Rutin 500', status: 'applied', created_at: '2026-08-18T13:00:00Z' },
    { id: 2, kind: 'count', qty: 100, product: 'Rutin 500mg', nickname: 'Rutin 500', status: 'pending', created_at: '2026-08-18T12:40:00Z' },
    { id: 3, kind: 'entrada', qty: 48, product: 'Benfotiamine 300mg', nickname: 'Benfotiamine 300', status: 'approved', created_at: '2026-08-18T12:10:00Z', box_id: 8, box_number: 'BX-0451' },
  ],
};

/* S15.29 · FILA DE IMPRESSAO PEDIDA PELO CELULAR (contrato 1 e 3).
   O admin pede a etiqueta do iPhone; o papel sai onde tem impressora. O hub
   puxa GET /api/v3/print-queue?status=queued e imprime com take -> done. */
let QUEUE = [
  { id: 12, kind: 'box_label', payload: { labels: [
    { kind: 'box', code: 'BX-0451', line2: 'Rutin 500mg', line3: '100 garrafas · lote L-22', url: '/scan/?box=BX-0451' },
  ] }, requested_by: 'Bruno', status: 'queued', age_min: 4, taken_by: null, is_test: false },
  // 2o pedido: fica pro teste da estacao /print (o hub consome o de cima)
  { id: 13, kind: 'bin_labels', payload: { labels: [
    { kind: 'bin', code: 'A03B2', line2: 'Prateleira S4 · P&P', line3: 'cabe 48 · Rutin', url: '/scan/?bin=A03B2' },
  ] }, requested_by: 'Bruno', status: 'queued', age_min: 1, taken_by: null, is_test: false },
];

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
  // ── fila de impressão do celular ─────────────────────────────
  if (pathname.startsWith('/api/v3/print-queue')) {
    const m = pathname.match(/\/api\/v3\/print-queue\/(\d+)\/(take|done|error|cancel)$/);
    if (m) {
      const id = Number(m[1]); const op = m[2];
      const job = QUEUE.find((j) => j.id === id);
      if (!job) return { error: { code: 'not_found', message: 'job sumiu' } };
      if (op === 'take') { job.status = 'taken'; job.taken_by = (body && body.by) || '?'; }
      if (op === 'done') { job.status = 'done'; QUEUE = QUEUE.filter((j) => j.id !== id); }
      if (op === 'error') { job.status = 'error'; job.error_note = body && body.note; }
      if (op === 'cancel') { job.status = 'cancelled'; QUEUE = QUEUE.filter((j) => j.id !== id); }
      return { data: { job } };
    }
    return { data: { jobs: QUEUE.filter((j) => j.status === 'queued' || j.status === 'taken') } };
  }
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
  if (p === 'stock/count/weigh') {
    // shape do contrato D: qty_min/qty_max (tara do tipo ± spread/2) + recount
    // shape REAL do countWeigh (op-warehouse.js, S15.44): sem tare_spread_g no
    // corpo da resposta (ele viaja no meta da proposta), confidence em EN.
    if (body && body.box_id === 10) {
      return { ok: true, request_id: 95, status: 'pending', qty: 110, confidence: 'high',
        residual_g: 0, qty_min: 109, qty_max: 111, residual_fraction: 0,
        recount_suggested: true, unit_weight_g: 48, tare_g: 782, net_g: 5280 };
    }
    return { ok: true, request_id: 91, status: 'pending', qty: 100, confidence: 'high',
      residual_g: 0, qty_min: 100, qty_max: 100, residual_fraction: 0,
      recount_suggested: false, unit_weight_g: 48, tare_g: 500, net_g: 4800 };
  }
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
      else if (p === '/print' || p === '/print/') file = path.join(PRINTDIR, 'index.html');
      else if (p.startsWith('/op/')) file = path.join(OPDIR, p.slice(4));
      else if (p.startsWith('/scan/')) file = path.join(SCANDIR, p.slice(6));
      else if (p.startsWith('/print/')) file = path.join(PRINTDIR, p.slice(7));
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

  // ── MENU PERSISTENTE: a MESMA barra do /op, aqui no hub ──────
  const nav = await page.evaluate(() => {
    const n = document.querySelector('[data-nav="op"]');
    if (!n) return null;
    const items = Array.from(n.querySelectorAll('[data-nav-item]'));
    const href = (k) => { const e = n.querySelector('[data-nav-item="' + k + '"]'); return e ? e.getAttribute('href') : null; };
    const a = n.querySelector('[aria-current="page"]');
    return {
      keys: items.map((i) => i.getAttribute('data-nav-item')),
      active: a ? a.getAttribute('data-nav-item') : null,
      heights: items.map((i) => Math.round(i.getBoundingClientRect().height)),
      linha: href('linha'), central: href('central'),
    };
  });
  rec('menu', 'nav persistente no hub com as 3 abas',
    !!nav && nav.keys.join(',') === 'linha,central,estoque', nav ? nav.keys.join(',') : 'sem nav');
  rec('menu', 'aba ativa no hub e Estoque', !!nav && nav.active === 'estoque', nav ? nav.active : '');
  rec('menu', 'Linha volta pro /op e Central usa o deep link /op/?ws=1',
    !!nav && nav.linha === '/op/' && nav.central === '/op/?ws=1', nav ? nav.linha + ' | ' + nav.central : '');
  rec('menu', 'itens do menu com 44px+ (toque com luva)',
    !!nav && nav.heights.every((x) => x >= 44), nav ? nav.heights.join('/') : '');
  const cross = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a[href="/op/?ws=1"]'));
    const link = a.find((x) => /picklist/i.test(x.innerText));
    return link ? link.innerText.replace(/\s+/g, ' ').trim() : null;
  });
  rec('menu', 'home do hub tem o link discreto pra Central', !!cross, String(cross));
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
  // a tela nao so mostra a tara, ela DIZ DE ONDE ela veio (local > preset > digitada)
  rec('contar', 'mostra a tara em uso e de onde ela veio (500 g do proprio local)',
    /tara: cadastrada neste local 500 g/.test(cnt0), '');
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
  // balança HIBRIDA (Bruno 08-22): hoje o operador digita o visor; a balança
  // USB "digita sozinha" no MESMO campo, que vive focado.
  rec('balanca', 'campo de gramas fica AUTOFOCADO (a balança USB digita nele)',
    await page.evaluate(() => {
      const a = document.activeElement;
      return !!(a && a.getAttribute && a.getAttribute('data-input') === 'cntGross');
    }), '');
  rec('balanca', 'hint da balança USB embaixo do campo',
    /aceita balança USB que digita sozinha/.test(cnt0), '');

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

  // ── TARA: presets em chips (contrato 1) ─────────────────────
  // BX-0452 nao tem tara cadastrada: e o caso em que o preset manda.
  await scan('BX-0452');
  await sleep(400);
  const tareBtns = await page.$$('[data-act="cntTare"]');
  rec('tara', 'chips de tara vieram do stock/tasks.tares', tareBtns.length >= 3, tareBtns.length + ' chips');
  const tareTxt0 = await page.evaluate(() => document.body.innerText);
  rec('tara', 'sem tara escolhida a tela diz que nao tem', /tara: nenhuma, peso cheio/.test(tareTxt0), '');
  rec('tara', 'os chips mostram nome e gramas', /caixa média .* 780 g/.test(tareTxt0), '');
  // escolhe "caixa média" (780 g)
  await (await page.$('[data-act="cntTare"][data-arg="2"]')).click();
  await sleep(400);
  const tareTxt = await page.evaluate(() => document.body.innerText);
  rec('tara', 'a tela DIZ qual tara esta em uso ("tara: caixa média 780 g")',
    /tara: caixa média 780 g/.test(tareTxt), '');
  await shot('05b-contar-tara');
  // 5580 bruto - 780 tara = 4800 / 48 = 100 garrafas
  await page.evaluate(() => {
    const i = document.querySelector('[data-input="cntGross"]');
    i.value = '5580';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(500);
  const tarePv = await page.evaluate(() => {
    const n = document.querySelector('#cntPreview');
    const m = n && n.innerText.match(/\b(\d+)\b/);
    return m ? m[1] : null;
  });
  rec('tara', 'a previa desconta a tara do preset (5580-780)/48 = 100', tarePv === '100', 'previa=' + tarePv);
  posted.length = 0;
  await (await page.$('[data-act="submitWeigh"]')).click();
  await sleep(800);
  const tPost = posted.find((x) => x.pathname === '/api/v3/op/stock/count/weigh');
  rec('tara', 'o POST leva a tara do preset (o servidor refaz a conta)',
    !!tPost && tPost.body.tare_g === 780 && tPost.body.box_id === 9,
    tPost ? JSON.stringify(tPost.body) : 'sem post');

  // Local COM tara propria ganha do preset: os chips ficam apagados de proposito
  await scan('A03B2');                      // bin com tare_g 500
  await sleep(400);
  const ownTxt = await page.evaluate(() => document.body.innerText);
  rec('tara', 'local com tara cadastrada usa a DELE, nao o preset',
    /tara: cadastrada neste local 500 g/.test(ownTxt) && /já tem a tara cadastrada/i.test(ownTxt), '');

  // ── TIPO de caixa (Bruno 08-22): tara do tipo + FAIXA da pesagem ──
  // BX-0453 e do tipo 20x20x20 (tara media 782 g, espalhamento 96 g).
  await scan('BX-0453');
  await sleep(400);
  const btTxt = await page.evaluate(() => document.body.innerText);
  rec('tipo-caixa', 'a tela diz a tara do tipo: "tara: caixa 20x20x20, 782 g"',
    /tara: caixa 20x20x20, 782 g/.test(btTxt), '');
  rec('tipo-caixa', 'com a tara do tipo os presets nao roubam a vez',
    /pesada com as vazias/.test(btTxt), '');
  // 6062 bruto - 782 = 5280 = 110 exatas; com tara ±48 g a conta "dá 109 a 111"
  await page.evaluate(() => {
    const i = document.querySelector('[data-input="cntGross"]');
    i.value = '6062';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(500);
  const btPv = await page.evaluate(() => {
    const nx = document.querySelector('#cntPreview');
    return nx ? nx.innerText.replace(/\s+/g, ' ') : '';
  });
  rec('tipo-caixa', 'a previa mostra a FAIXA "dá 109 a 111" com a confiança',
    /dá 109 a 111/i.test(btPv) && /confiança alta/i.test(btPv), btPv.slice(0, 120));
  rec('tipo-caixa', 'faixa aberta sugere contar na mao (cartao ambar, nunca trava)',
    /Melhor contar na mão/.test(btPv) && /enviar assim mesmo/i.test(btPv), '');
  rec('tipo-caixa', 'o Confirmar grande se recolhe: sobra UM envio, um toque',
    await page.evaluate(() => {
      const w = document.querySelector('#cntSubmitWrap');
      return !!w && w.style.display === 'none';
    }), '');
  await shot('05c-contar-faixa');
  // "contar na mao" troca o modo SEM perder a caixa escolhida
  await (await page.$('[data-act="cntRecountManual"]')).click();
  await sleep(400);
  const manualKeep = await page.evaluate(() => ({
    mode: window.HF_EST.state.cnt.mode,
    box: window.HF_EST.state.cnt.target && window.HF_EST.state.cnt.target.box
      ? window.HF_EST.state.cnt.target.box.box_number : null,
  }));
  rec('tipo-caixa', '"contar na mão" vira manual e SEGURA a caixa BX-0453',
    manualKeep.mode === 'manual' && manualKeep.box === 'BX-0453', JSON.stringify(manualKeep));
  // volta pro Pesar e manda assim mesmo: o POST sai SEM tare_g (a tara do tipo
  // fica com o servidor, que conhece a media e o espalhamento)
  await (await page.$('[data-act="cntMode"][data-arg="weigh"]')).click();
  await sleep(400);
  posted.length = 0;
  await (await page.$('#cntPreview [data-act="submitWeigh"]')).click();
  await sleep(800);
  const btPost = posted.find((x) => x.pathname === '/api/v3/op/stock/count/weigh');
  rec('tipo-caixa', '"enviar assim mesmo" posta SEM tare_g e com box_id',
    !!btPost && btPost.body.box_id === 10 && btPost.body.tare_g === undefined && btPost.body.gross_g === 6062,
    btPost ? JSON.stringify(btPost.body) : 'sem post');
  const btToast = await page.evaluate(() => document.body.innerText);
  rec('tipo-caixa', 'o toast repete a faixa do servidor ("Deu de 109 a 111")',
    /Contagem enviada/.test(btToast) && /Deu de 109 a 111/.test(btToast), '');

  // ── sobra no meio do caminho: 100,5 garrafas → recontagem ──
  await scan('A03B2');
  await sleep(400);
  await page.evaluate(() => {
    const i = document.querySelector('[data-input="cntGross"]');
    i.value = '5324';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(500);
  const midPv = await page.evaluate(() => {
    const nx = document.querySelector('#cntPreview');
    return nx ? nx.innerText.replace(/\s+/g, ' ') : '';
  });
  rec('recontagem', 'meia garrafa de sobra: "Deu muita sobra pra fechar a conta"',
    /Deu muita sobra pra fechar a conta/.test(midPv) && /Melhor contar na mão/.test(midPv), midPv.slice(0, 140));
  rec('recontagem', 'a conta NUNCA desce: 100,5 garrafas viram 101',
    /\b101\b/.test(midPv), midPv.slice(0, 80));
  await shot('05d-contar-recontagem');

  // leitor USB "digitou" um codigo no campo de gramas focado: o Enter vira scan
  await page.evaluate(() => {
    const i = document.querySelector('[data-input="cntGross"]');
    i.focus(); i.value = 'BX-0451';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await sleep(500);
  const reroute = await page.evaluate(() => ({
    box: window.HF_EST.state.cnt.target && window.HF_EST.state.cnt.target.box
      ? window.HF_EST.state.cnt.target.box.box_number : null,
    gross: window.HF_EST.state.cnt.gross,
  }));
  rec('balanca', 'codigo lido dentro do campo de gramas vira scan (e some do campo)',
    reroute.box === 'BX-0451' && reroute.gross === '', JSON.stringify(reroute));

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

  // ── FILA DE IMPRESSAO PEDIDA PELO CELULAR (S15.29) ───────────
  // Alguem pediu a etiqueta do iPhone; o papel sai NESTE PC. O poll e de 30s,
  // entao forcamos uma leitura pra nao segurar o harness meio minuto.
  await (await page.$('[data-act="go"][data-arg="home"]')).click();
  await sleep(300);
  await page.evaluate(() => { const q = window.HF_EST.queue(); if (q) q.load(); });
  await sleep(700);
  const qCard = await page.$('[data-card="print-queue"]');
  rec('fila', 'cartao "Impressao pedida pelo celular" aparece quando tem pedido', !!qCard);
  const qTxt = qCard ? await page.evaluate((e) => e.innerText.replace(/\s+/g, ' '), qCard) : '';
  rec('fila', 'diz o tipo em PT, quantas folhas, quem pediu e ha quanto tempo',
    /Etiqueta de caixa/.test(qTxt) && /1 folha/.test(qTxt) && /Bruno/.test(qTxt) && /há 4 min/.test(qTxt), qTxt);
  const qBtn = await page.$('[data-act="printJob"]');
  rec('fila', 'botao Imprimir com alvo de toque de 44px+ (luva)',
    !!qBtn && (await page.evaluate((e) => Math.round(e.getBoundingClientRect().height), qBtn)) >= 44,
    qBtn ? String(await page.evaluate((e) => Math.round(e.getBoundingClientRect().height), qBtn)) + 'px' : 'sem botao');
  await shot('11-fila-celular');

  await page.evaluate(() => {
    window.__lastLabel = null;
    const open = window.open;
    window.open = function () { const w = { document: { write: (d) => { window.__lastLabel = d; }, close: () => {} } }; window.open = open; return w; };
  });
  posted.length = 0;
  if (qBtn) await qBtn.click();
  await sleep(1200);
  const qPosts = posted.map((x) => x.pathname);
  rec('fila', 'toca em Imprimir e o job vai take -> done',
    qPosts.indexOf('/api/v3/print-queue/12/take') >= 0 && qPosts.indexOf('/api/v3/print-queue/12/done') >= 0,
    JSON.stringify(qPosts));
  const takeBody = posted.find((x) => /\/take$/.test(x.pathname));
  rec('fila', 'o take leva o NOME de quem pegou',
    !!takeBody && !!takeBody.body && takeBody.body.by === PERSON.display_name,
    takeBody ? JSON.stringify(takeBody.body) : 'sem body');
  const qDoc = await page.evaluate(() => window.__lastLabel || '');
  rec('fila', 'a janela abriu com a etiqueta 4x6 do renderizador unico (Code128 + QR)',
    /BX-0451/.test(qDoc) && /4in 6in/.test(qDoc) && /<svg/.test(qDoc) && /100 garrafas/.test(qDoc),
    qDoc ? qDoc.slice(0, 60) : 'sem documento');
  const doneTxt = await page.evaluate(() => document.body.innerText);
  rec('fila', 'confirma "Pode tirar do papel"', /Pode tirar do papel/.test(doneTxt), '');
  await sleep(400);
  const leftJobs = await page.$$eval('[data-card="print-queue"] [data-job]', (e) => e.map((x) => x.dataset.job));
  rec('fila', 'o job impresso sai do cartao e o que sobra continua la',
    leftJobs.indexOf('12') < 0 && leftJobs.indexOf('13') >= 0, leftJobs.join(','));

  // ── texto: regras do Bruno ──────────────────────────────────
  await (await page.$('[data-act="go"][data-arg="home"]')).click();
  await sleep(400);
  const allTxt = await page.evaluate(() => document.body.innerText);
  rec('texto', 'sem em dash na tela', !/—/.test(allTxt), (allTxt.match(/.{0,20}—.{0,20}/) || [''])[0]);
  rec('texto', 'sem entidade HTML crua vazando', !/&[a-z]+;/.test(allTxt), (allTxt.match(/&[a-z]+;/) || [''])[0]);
  await shot('08-home-final');

  // ── ESTACAO DE IMPRESSAO /print (o PC .28) ──────────────────
  // Mesmo login por PIN do /op; depois de entrar ela mostra a MESMA fila e
  // imprime o mesmo papel. E o PC que tem a impressora de etiqueta do lado.
  const station = await browser.newPage();
  await station.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  const stErrors = [];
  station.on('pageerror', (e) => stErrors.push('pageerror: ' + e.message));
  station.on('console', (m) => { if (m.type() === 'error' && !EXTERNAL.test(m.text())) stErrors.push(m.text().slice(0, 200)); });
  await station.goto(BASE + '/print/', { waitUntil: 'domcontentloaded' });
  await sleep(600);
  rec('estacao', 'carrega o desenho da etiqueta e a fila (sem CDN)',
    await station.evaluate(() => !!window.HF_LABELS && !!window.HF_PRINT_QUEUE && !!window.HF_CODE128));
  for (const d of ['1', '2', '3', '4']) {
    const b = await station.$('[data-act="pinkey"][data-arg="' + d + '"]');
    if (b) await b.click();
  }
  await sleep(1000);
  const stTxt0 = await station.evaluate(() => document.body.innerText);
  rec('estacao', 'PIN libera o PC e diz quem entrou', /QA Operadora/.test(stTxt0), '');
  const stCard = await station.$('[data-card="print-queue"]');
  rec('estacao', 'a fila do celular aparece na estacao logo depois do login', !!stCard);
  const stTxt = stCard ? await station.evaluate((e) => e.innerText.replace(/\s+/g, ' '), stCard) : '';
  rec('estacao', 'diz o tipo em PT, quem pediu e ha quanto tempo',
    /Etiquetas de prateleira/.test(stTxt) && /Bruno/.test(stTxt) && /há 1 min/.test(stTxt), stTxt);
  await station.screenshot({ path: path.join(QA, 'op-estoque-12-estacao-fila.png') });
  console.log('    shot → docs/architecture/_qa/op-estoque-12-estacao-fila.png');

  await station.evaluate(() => {
    window.__lastLabel = null;
    const open = window.open;
    window.open = function () { const w = { document: { write: (d) => { window.__lastLabel = d; }, close: () => {} } }; window.open = open; return w; };
  });
  posted.length = 0;
  const stBtn = await station.$('[data-act="printJob"]');
  if (stBtn) await stBtn.click();
  await sleep(1200);
  const stPosts = posted.map((x) => x.pathname);
  rec('estacao', 'imprime pelo mesmo caminho take -> done',
    stPosts.indexOf('/api/v3/print-queue/13/take') >= 0 && stPosts.indexOf('/api/v3/print-queue/13/done') >= 0,
    JSON.stringify(stPosts));
  const stDoc = await station.evaluate(() => window.__lastLabel || '');
  rec('estacao', 'sai a MESMA etiqueta 4x6 do renderizador unico',
    /A03B2/.test(stDoc) && /4in 6in/.test(stDoc) && /<svg/.test(stDoc), stDoc ? stDoc.slice(0, 50) : 'sem documento');
  const stDone = await station.evaluate(() => document.body.innerText);
  rec('estacao', 'confirma "Pode tirar do papel" na propria tela', /Pode tirar do papel/.test(stDone), '');
  rec('estacao', 'nenhum erro de script na estacao', stErrors.length === 0, stErrors.slice(0, 2).join(' | '));
  await station.close();

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
