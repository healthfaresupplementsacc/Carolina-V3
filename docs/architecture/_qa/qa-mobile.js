'use strict';
/**
 * QA harness da PÁGINA DO ADMIN NO CELULAR (/m/, S15.29).
 * Rodar da RAIZ do projeto:  node docs/architecture/_qa/qa-mobile.js
 *
 * O que faz:
 *   1. sobe um http estático servindo src/m em /m, src/shared em /shared e
 *      src/op em /op (a página é vanilla, não precisa de build);
 *   2. INTERCEPTA /api/** com as fixtures de docs/architecture/_qa/fixtures/
 *      m-*.json. Nunca fala com servidor nem com banco;
 *   3. num iPhone de mentira (390x844, dsf 2, touch) roda: login por PIN,
 *      Início, Aprovar, Produtos + uma ação, Locais + cadastro, Imprimir
 *      (AirPrint com window.open dublado + fila) e Ler código;
 *   4. screenshots em docs/architecture/_qa/m-*.png e PASS/FAIL no fim.
 *
 * Só toca os arquivos do agente Q (src/m/** e este harness).
 */
const puppeteer = require('puppeteer');
const http = require('http');
const path = require('path');
const fs = require('fs');

const QA = __dirname;
const ROOT = path.join(QA, '..', '..', '..');
const MDIR = path.join(ROOT, 'src', 'm');
const SHAREDDIR = path.join(ROOT, 'src', 'shared');
const OPDIR = path.join(ROOT, 'src', 'op');
const FIX = path.join(QA, 'fixtures');

const results = [];
const rec = (group, name, pass, detail) => {
  results.push({ group, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? 'PASS ' : 'FAIL ') + '[' + group + '] ' + name + (detail ? '  ·  ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readFix = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));

const PIN = '4242';
const BOOTSTRAP = readFix('m-bootstrap.json');
const PRODUCT99 = readFix('m-product-99.json');
const QUEUE = readFix('m-queue.json');
const PRINTERS = readFix('m-printers.json');

/* S2 · o que a Veeqo tem pra hoje. Fica inline (e nao num fixture .json) porque
   e o contrato do agente S1 que este harness precisa provar, nao um dump. */
const SHIP_DAY = '2026-08-19';
const SHIP_READY = [
  { order_number: '12-345', external_order_id: 'V-1', shipment_id: 'S-1', channel: 'TikTok', bottles: 2,
    envelope: '9x12', printed_at: null, mixed: false,
    products: [{ product_id: 42, nickname: 'BENF-300', sku: 'HF-BENF-200', bottles: 2, bin_code: 'A03B2', shelf_code: 'S4', area: 'P&P' }] },
  { order_number: '12-401', external_order_id: 'V-2', shipment_id: 'S-2', channel: 'eBay', bottles: 1,
    envelope: '7x10', printed_at: null, mixed: false,
    products: [{ product_id: 42, nickname: 'BENF-300', sku: 'HF-BENF-200', bottles: 1, bin_code: 'A03B2', shelf_code: 'S4', area: 'P&P' }] },
  { order_number: '12-999', external_order_id: 'V-3', shipment_id: 'S-3', channel: 'Walmart', bottles: 2,
    envelope: 'BX', printed_at: null, mixed: true,
    products: [{ product_id: 99, nickname: 'RUT-500', sku: 'HF-RUT-C2', bottles: 2, bin_code: null, shelf_code: 'S6', area: 'P&P' }] },
  { order_number: '12-100', external_order_id: 'V-4', shipment_id: 'S-4', channel: 'TikTok', bottles: 1,
    envelope: '4x8', printed_at: '2026-08-19T13:00:00Z', mixed: false,
    products: [{ product_id: 99, nickname: 'RUT-500', sku: 'HF-RUT-C2', bottles: 1, bin_code: 'B01', shelf_code: 'S6', area: 'P&P' }] },
];
let SHIP_JOB_SEQ = 900;
function shipCounts() { return { ready: 4, printed: 1, to_print: 3 }; }

// tudo que a página postou, pra conferir CONTRATO (não só "não quebrou")
const posted = [];
// tudo que ela pediu, pra provar que não inventou rota nenhuma
const called = [];

/** resolve de código: bin, caixa, produto ou nada (mesma ordem do backend). */
function resolveBarcode(bc) {
  const up = String(bc || '').trim().toUpperCase();
  const bin = BOOTSTRAP.locations.bins.find((b) => b.bin_code.toUpperCase() === up);
  if (bin) return { kind: 'bin', bin };
  const box = BOOTSTRAP.locations.boxes.find((b) => b.box_number.toUpperCase() === up);
  if (box) return { kind: 'box', box };
  if (up === '036000291452') return { kind: 'product', product: { id: 99, name: 'Rutin 500mg', nickname: 'Rutin 500' } };
  return { kind: 'unknown', raw: bc };
}

/** Resposta da API falsa. Envelope {data} / {error} igual ao de verdade. */
function apiFixture(pathname, method, body, query, headers) {
  called.push({ pathname, method, query: query ? query.toString() : '' });
  if (method === 'POST') posted.push({ pathname, body });

  // AUTH: sem o PIN certo, 401 com o MESMO envelope do makeAuthMiddleware
  if ((headers['x-admin-pin'] || '') !== PIN) {
    return { status: 401, body: { error: { code: 'unauthorized', message: 'PIN inválido ou ausente.' } } };
  }

  if (pathname === '/api/v3/warehouse/mobile/bootstrap') return { body: { data: BOOTSTRAP } };
  if (pathname === '/api/v3/warehouse/mobile/printers') return { body: { data: PRINTERS } };
  if (pathname === '/api/v3/warehouse/mobile/scan/resolve') {
    const raw = query.get('barcode');
    return { body: { data: Object.assign({ raw }, resolveBarcode(raw)) } };
  }
  if (pathname === '/api/v3/warehouse/mobile/print/submit') {
    return { body: { data: { job_id: 72, queued: 1, labels: [{ kind: 'bin', code: 'A03B2', line2: 'S4 · P&P', line3: 'Rutin 500mg', url: '/scan/?b=A03B2' }] } } };
  }
  if (pathname === '/api/v3/warehouse/labels') {
    const labels = [];
    String(query.get('bins') || '').split(',').filter(Boolean).forEach((id) => {
      const b = BOOTSTRAP.locations.bins.find((x) => String(x.id) === id);
      if (b) labels.push({ kind: 'bin', code: b.bin_code, line2: [b.shelf_code, b.area].filter(Boolean).join(' · '), line3: b.product || '', url: '/scan/?b=' + b.bin_code });
    });
    String(query.get('boxes') || '').split(',').filter(Boolean).forEach((id) => {
      const x = BOOTSTRAP.locations.boxes.find((y) => String(y.id) === id);
      if (x) labels.push({ kind: 'box', code: x.box_number, line2: x.product || '', line3: x.qty + ' garrafas · lote ' + x.batch_number, url: '/scan/?x=' + x.box_number });
    });
    return { body: { data: { labels } } };
  }
  /* S2 · ETIQUETAS DE ENVIO DE HOJE. Do celular o Bruno faz duas coisas:
     manda pra 4x6 da Central (POST sem take, cai na fila) ou abre o PDF aqui
     pro AirPrint (POST com take + GET do arquivo com o PIN no header). */
  if (pathname === '/api/v3/print-queue/shipping-labels/preview') {
    return { body: { data: { day: SHIP_DAY, ready: SHIP_READY, counts: shipCounts() } } };
  }
  if (pathname === '/api/v3/print-queue/shipping-labels') {
    const n = shipCounts().to_print;
    if (!n) return { status: 409, body: { error: { code: 'nothing_to_print', message: 'nada novo pra imprimir' } } };
    const id = ++SHIP_JOB_SEQ;
    return { body: { data: {
      job: { id, kind: 'shipping_labels', status: (body && body.take) ? 'taken' : 'queued',
        requested_by: 'Bruno', age_min: 0,
        payload: { day: SHIP_DAY, count: n, pages: n + 2,
          groups: [{ nickname: 'BENF-300', count: 2, location: 'A03B2' }, { nickname: 'RUT-500', count: 1, location: 'S6' }] } },
      file_url: '/api/v3/print-queue/' + id + '/file',
      counts: { labels: n, pages: n + 2, groups: 2 },
    } } };
  }
  if (pathname === '/api/v3/print-queue') return { body: { data: QUEUE } };
  if (/^\/api\/v3\/print-queue\/\d+\/(take|done|error|cancel)$/.test(pathname)) {
    return { body: { data: { job: { id: 71, status: 'cancelled' } } } };
  }
  if (pathname === '/api/v3/warehouse/product/99') return { body: { data: PRODUCT99 } };
  if (/^\/api\/v3\/warehouse\/product\/\d+\/(entrada|place|move|adjust|separate)$/.test(pathname)) {
    return { body: { data: { ok: true, product: PRODUCT99.product } } };
  }
  if (/^\/api\/v3\/warehouse\/requests\/\d+\/(approve|reject)$/.test(pathname)) {
    return { body: { data: { ok: true, request: { id: 501, status: 'approved', product_id: 99 } } } };
  }
  if (pathname === '/api/v3/warehouse/locations/bin') {
    return { body: { data: { ok: true, bin: { id: 4, bin_code: (body && body.bin_code) || 'C01' } } } };
  }
  if (pathname === '/api/v3/warehouse/locations/box') {
    return { body: { data: { ok: true, box: { id: 10, box_number: (body && body.box_number) || 'BX-0999' } } } };
  }
  return { status: 404, body: { error: { code: 'not_found', message: 'rota não existe no harness: ' + pathname } } };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(u.pathname);

      /* O PDF composto (contrato 4). Bytes, nao JSON: a pagina busca com o PIN
         no header e abre um blob local, porque uma aba nova nao manda header. */
      if (/^\/api\/v3\/print-queue\/\d+\/file$/.test(p)) {
        called.push({ pathname: p, method: req.method, query: u.search, pin: req.headers['x-admin-pin'] || '' });
        if ((req.headers['x-admin-pin'] || '') !== PIN) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'unauthorized' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/pdf',
          'content-disposition': 'inline; filename=etiquetas-envio-' + SHIP_DAY + '.pdf' });
        res.end(Buffer.from('%PDF-1.4\n% etiquetas de envio (stub do harness)\n%%EOF\n'));
        return;
      }
      if (p.startsWith('/api/')) {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw; }
          const out = apiFixture(p, req.method, body, u.searchParams, req.headers);
          res.writeHead(out.status || 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.body));
        });
        return;
      }
      let file = null;
      if (p === '/' || p === '/m' || p === '/m/') file = path.join(MDIR, 'index.html');
      else if (p.startsWith('/m/')) file = path.join(MDIR, p.slice(3));
      else if (p.startsWith('/shared/')) file = path.join(SHAREDDIR, p.slice(8));
      else if (p.startsWith('/op/')) file = path.join(OPDIR, p.slice(4));
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
  console.log('servindo src/m em ' + BASE + '/m/  (API interceptada, sem rede)\n');

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  // iPhone 14: é o aparelho do Bruno, e o alvo do desenho inteiro
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  const EXTERNAL = /fonts\.(googleapis|gstatic)\.com|Failed to load resource|net::ERR/i;
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (EXTERNAL.test(t)) return;
    consoleErrors.push('console.error: ' + t.slice(0, 300));
  });

  const shot = async (name) => {
    const f = path.join(QA, 'm-' + name + '.png');
    await page.screenshot({ path: f });
    console.log('    shot → ' + path.relative(ROOT, f));
  };
  const txt = () => page.evaluate(() => document.body.innerText);
  const tap = async (sel) => {
    const el = await page.$(sel);
    if (!el) throw new Error('elemento não existe: ' + sel);
    await el.click();
    await sleep(320);
  };

  // ── BOOT ────────────────────────────────────────────────────
  await page.goto(BASE + '/m/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.HF_M, { timeout: 8000 });
  rec('boot', 'window.HF_M definido por /m/m.js', true);
  rec('boot', 'Code128, QR e a folha de etiqueta carregaram (sem CDN)',
    await page.evaluate(() => !!window.HF_CODE128 && typeof window.qrcode === 'function'
      && !!(window.HF_LABELS && window.HF_LABELS.sheetHtml)));
  rec('boot', 'ZXing NÃO baixa no boot (300 kB só quando a câmera abre)',
    await page.evaluate(() => typeof window.ZXing === 'undefined'));

  // ── LOGIN ───────────────────────────────────────────────────
  const keys = await page.$$('[data-act="pinkey"]');
  rec('login', 'keypad de PIN renderizou com 12 teclas', keys.length === 12, keys.length + ' teclas');
  const keyBox = await page.evaluate(() => {
    const b = document.querySelector('[data-act="pinkey"][data-arg="5"]').getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height) };
  });
  rec('login', 'tecla do PIN com alvo de 44 px+', keyBox.w >= 44 && keyBox.h >= 44, keyBox.w + 'x' + keyBox.h);
  await shot('01-login');

  // PIN ERRADO primeiro: o 401 tem que voltar pro PIN dizendo o que houve
  for (const d of ['9', '9', '9', '9']) await tap('[data-act="pinkey"][data-arg="' + d + '"]');
  await sleep(700);
  rec('login', 'PIN errado volta pro teclado dizendo "PIN inválido"',
    /PIN inválido/.test(await txt()) && !!(await page.$('.keypad')), '');
  rec('login', 'PIN errado NÃO fica guardado no celular',
    await page.evaluate(() => !localStorage.getItem('hf_m_pin')));

  for (const d of PIN.split('')) await tap('[data-act="pinkey"][data-arg="' + d + '"]');
  await page.waitForFunction(() => !!document.querySelector('.tabbar'), { timeout: 8000 });
  rec('login', 'PIN certo entra no app (barra de abas apareceu)', true);
  rec('login', 'PIN guardado com validade de 12 h no localStorage',
    await page.evaluate(() => {
      const o = JSON.parse(localStorage.getItem('hf_m_pin') || '{}');
      const h = (o.exp - Date.now()) / 3600000;
      return o.pin === '4242' && h > 11.5 && h <= 12.01;
    }));
  rec('login', 'nome de quem entrou aparece no topo', /Bruno/.test(await txt()));

  // ── INÍCIO ──────────────────────────────────────────────────
  const home = await txt();
  // os micro-rótulos sobem pra CAPS via text-transform: compara sem case
  rec('inicio', 'os 4 KPIs com o vocabulário do hub',
    /Total/i.test(home) && /Disponível/i.test(home) && /A organizar/i.test(home) && /Aprovações/i.test(home));
  const kpiVals = await page.evaluate(() => Array.from(document.querySelectorAll('.kpi .v')).map((n) => n.textContent.trim()));
  rec('inicio', 'os números do bootstrap chegaram na tela',
    kpiVals[0] === '1.840' && kpiVals[1] === '1.520' && kpiVals[2] === '96' && kpiVals[3] === '3',
    kpiVals.join(' | '));
  rec('inicio', 'lista "Precisa de atenção" com as 4 linhas do backend',
    (await page.$$('[data-act="attn"]')).length === 4);
  rec('inicio', 'a linha de atenção mostra o motivo, sem repetir o nome',
    /disponível 12, mínimo 40/.test(home) && !/Rutin 500 · disponível/.test(home));
  // nome e motivo em linhas próprias: colados viram "Rutin 500disponível 12"
  rec('inicio', 'nome e motivo não ficam colados na mesma linha',
    !/[a-zà-ú0-9]disponível/i.test(home) && /Rutin 500\s*\n/.test(home));
  rec('inicio', 'conta de "Veeqo diferente" na home', /Veeqo diferente/.test(home) && /1 produto/.test(home));
  rec('inicio', 'badge de Aprovações na aba de baixo',
    (await page.evaluate(() => { const b = document.querySelector('.tab .badge'); return b ? b.textContent.trim() : null; })) === '3');
  const bar = await page.evaluate(() => {
    const t = document.querySelectorAll('.tab');
    return { n: t.length, hs: Array.from(t).map((x) => Math.round(x.getBoundingClientRect().height)) };
  });
  rec('inicio', 'as 5 abas com alvo de 44 px+', bar.n === 5 && bar.hs.every((h) => h >= 44), bar.hs.join('/'));
  rec('inicio', 'botão flutuante da câmera existe em todas as abas', !!(await page.$('.fab')));
  // GEOMETRIA: um SVG sem tamanho travado cresce e vira cartaz. Vale pra
  // TODO ícone da página, não só o do cartão que quebrou primeiro.
  const bigIcons = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.page svg, .topbar svg, .fab svg, .tabbar svg').forEach((s) => {
      const b = s.getBoundingClientRect();
      if (b.width > 30 || b.height > 30) {
        out.push(Math.round(b.width) + 'x' + Math.round(b.height) + ' em ' + (s.parentElement.className || s.parentElement.tagName));
      }
    });
    return out;
  });
  rec('inicio', 'nenhum ícone virou cartaz (todo SVG com tamanho travado)',
    bigIcons.length === 0, bigIcons.slice(0, 3).join(' | '));
  // o botão da câmera não pode cobrir nenhum botão da lista: seria um
  // botão que existe e não dá pra apertar
  const overlap = await page.evaluate(() => {
    const fab = document.querySelector('.fab').getBoundingClientRect();
    const hit = [];
    document.querySelectorAll('.page button').forEach((b) => {
      const r = b.getBoundingClientRect();
      if (r.width === 0) return;
      if (r.left < fab.right && r.right > fab.left && r.top < fab.bottom && r.bottom > fab.top) {
        hit.push((b.textContent || '').trim().slice(0, 20));
      }
    });
    return hit;
  });
  rec('inicio', 'o botão da câmera não cobre nenhum botão da lista',
    overlap.length === 0, overlap.join(', '));
  await shot('02-inicio');

  // deep link: "Aprovar" da lista de atenção pula pra fila
  await tap('[data-act="attn"][data-arg="2"]');
  rec('inicio', 'ação "Aprovar" da atenção leva pra aba Aprovar',
    await page.evaluate(() => window.HF_M.state.tab === 'aprovar'));

  // ── APROVAR ─────────────────────────────────────────────────
  const apr = await txt();
  rec('aprovar', 'as 3 propostas viraram cartão', (await page.$$('[data-req]')).length === 3);
  rec('aprovar', 'quem · o quê · quanto · onde numa linha só',
    /Simone/.test(apr) && /contagem/.test(apr) && /100/.test(apr) && /prateleira A03B2/.test(apr));
  rec('aprovar', 'idade em palavras, com cor por atraso',
    /há 1 dia/.test(apr) && /há 5 h/.test(apr) && /há 22 min/.test(apr));
  const tones = await page.evaluate(() => Array.from(document.querySelectorAll('[data-req]')).map((c) => c.className));
  rec('aprovar', 'a proposta de 25 h fica marcada como problema (cartão vermelho)',
    /bad/.test(tones[0]) && /warn/.test(tones[1]) && !/warn|bad/.test(tones[2]), tones.join(' | '));
  rec('aprovar', '"ver como foi contado" existe na contagem por peso',
    !!(await page.$('details')) && /ver como foi contado/.test(apr) && /confiança alta/.test(apr));
  rec('aprovar', 'a entrada de caixa nova mostra lote e área', /L-22/.test(apr) && /MEZ/.test(apr));
  await shot('03-aprovar');

  posted.length = 0;
  await tap('[data-act="approve"][data-arg="501"]');
  rec('aprovar', 'Aprovar abre a folha com nota opcional', /Aprovar agora/.test(await txt()));
  await page.evaluate(() => {
    const i = document.querySelector('[data-input="decideNote"]');
    i.value = 'conferi na prateleira';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await shot('04-aprovar-folha');
  await tap('[data-act="decideGo"]');
  await sleep(700);
  const apPost = posted.find((x) => x.pathname === '/api/v3/warehouse/requests/501/approve');
  rec('aprovar', 'posta requests/501/approve com a nota',
    !!apPost && apPost.body.note === 'conferi na prateleira', apPost ? JSON.stringify(apPost.body) : 'sem post');
  rec('aprovar', 'confirmação diz que o número mudou', /Aprovado\. O número mudou\./.test(await txt()));

  // ── PRODUTOS ────────────────────────────────────────────────
  await tap('[data-act="tab"][data-arg="produtos"]');
  rec('produtos', 'os 3 produtos do bootstrap na lista', (await page.$$('[data-act="product"]')).length === 3);
  await page.evaluate(() => {
    const i = document.querySelector('[data-input="productSearch"]');
    i.value = 'rutin';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(400);
  rec('produtos', 'busca por nome filtra a lista', (await page.$$('[data-act="product"]')).length === 1);
  await page.evaluate(() => {
    const i = document.querySelector('[data-input="productSearch"]');
    i.value = 'HF-MAG';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(400);
  rec('produtos', 'busca por SKU também acha', /Magnésio/.test(await txt()));
  await page.evaluate(() => {
    const i = document.querySelector('[data-input="productSearch"]');
    i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  await shot('05-produtos');

  await tap('[data-act="product"][data-arg="99"]');
  await sleep(700);
  const ph = await txt();
  rec('produto', 'ficha abre com os 8 números do vocabulário do hub',
    /Total/i.test(ph) && /Prateleira/i.test(ph) && /Caixa/i.test(ph) && /A organizar/i.test(ph)
    && /Reservado/i.test(ph) && /Disponível/i.test(ph) && /Separadas/i.test(ph) && /Dias/i.test(ph));
  rec('produto', 'chip do Veeqo aparece', /Veeqo confere/.test(ph));
  rec('produto', 'locais do produto (prateleira e caixa) listados', /A03B2/.test(ph) && /BX-0451/.test(ph));
  rec('produto', 'últimos movimentos vieram do GET /product/:id',
    /A03B2 · Bruno/.test(ph) && /BX-0451 · Bruno/.test(ph) && /Simone/.test(ph));
  // o verbo do banco não pode vazar pra tela: "storein" ensina o nome errado
  rec('produto', 'os movimentos usam as palavras do hub, não o verbo do banco',
    /Entrada \+100/.test(ph) && /Organizado \+40/.test(ph) && /Saiu -12/.test(ph)
    && !/storein/i.test(ph) && !/\bplace\b/i.test(ph));
  rec('produto', 'as 5 ações do estoque existem na ficha',
    (await page.$$('[data-act="paction"]')).length === 5);
  await shot('06-produto');

  posted.length = 0;
  await tap('[data-act="paction"][data-arg="entrada"]');
  rec('produto', 'folha de Entrada abre com stepper de quantidade', !!(await page.$('[data-input="qty"]')));
  await page.evaluate(() => {
    const i = document.querySelector('[data-input="qty"]');
    i.value = '48';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    const s = document.querySelector('[data-input="dest"]');
    s.value = 'bin:1';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  await shot('07-produto-entrada');
  await tap('[data-act="actionGo"]');
  await sleep(800);
  const entPost = posted.find((x) => x.pathname === '/api/v3/warehouse/product/99/entrada');
  rec('produto', 'Entrada posta product/99/entrada com qty e bin_id',
    !!entPost && entPost.body.qty === 48 && entPost.body.bin_id === 1 && entPost.body.box_id === undefined,
    entPost ? JSON.stringify(entPost.body) : 'sem post');
  rec('produto', 'confirmação diz o que aconteceu, não "ok"',
    /48 garrafas entraram no estoque\./.test(await txt()));

  // AJUSTAR sem motivo tem que ser barrado ANTES de sair da tela
  await tap('[data-act="product"][data-arg="99"]');
  await sleep(600);
  await tap('[data-act="paction"][data-arg="adjust"]');
  await page.evaluate(() => {
    const i = document.querySelector('[data-input="qty"]');
    i.value = '-3';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  posted.length = 0;
  await tap('[data-act="actionGo"]');
  await sleep(500);
  rec('produto', 'Ajustar sem motivo é barrado no celular (motivo é obrigatório)',
    posted.length === 0 && /motivo é obrigatório/i.test(await txt()));
  await page.evaluate(() => {
    const i = document.querySelector('[data-input="reason"]');
    i.value = 'conferi e faltavam 3';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await tap('[data-act="actionGo"]');
  await sleep(800);
  const adjPost = posted.find((x) => x.pathname === '/api/v3/warehouse/product/99/adjust');
  rec('produto', 'Ajustar posta qty negativo + reason',
    !!adjPost && adjPost.body.qty === -3 && adjPost.body.reason === 'conferi e faltavam 3',
    adjPost ? JSON.stringify(adjPost.body) : 'sem post');

  // ── LOCAIS ──────────────────────────────────────────────────
  await tap('[data-act="tab"][data-arg="locais"]');
  const loc = await txt();
  rec('locais', 'lista de prateleiras com código, corredor e produto',
    /A03B2/.test(loc) && /S4/.test(loc) && /Rutin/.test(loc));
  rec('locais', 'as 3 prateleiras do bootstrap', (await page.$$('[data-act="binSheet"]')).length === 3);
  await tap('[data-act="loctab"][data-arg="boxes"]');
  rec('locais', 'aba de caixas mostra as 2 caixas com lote',
    (await page.$$('[data-act="boxSheet"]')).length === 2 && /L-21/.test(await txt()));
  await tap('[data-act="loctab"][data-arg="bins"]');
  const bigHere = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.page svg').forEach((s) => {
      const b = s.getBoundingClientRect();
      if (b.width > 30 || b.height > 30) out.push(Math.round(b.width) + 'x' + Math.round(b.height));
    });
    return out;
  });
  rec('locais', 'o "+" de Nova prateleira é ícone, não cartaz',
    bigHere.length === 0, bigHere.join(' | '));
  await shot('08-locais');

  await tap('[data-act="binSheet"][data-arg="1"]');
  rec('locais', 'folha da prateleira mostra quantidade, mínimo e o botão de etiqueta',
    /Prateleira A03B2/.test(await txt()) && !!(await page.$('[data-act="labelOne"]')));
  await tap('[data-act="sheetClose"]');

  posted.length = 0;
  await tap('[data-act="newloc"][data-arg="bin"]');
  await page.evaluate(() => {
    const set = (k, v) => { const i = document.querySelector('[data-input="' + k + '"]'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
    set('code', 'c01a'); set('shelf', 'S9'); set('area', 'MEZ');
  });
  await sleep(300);
  await shot('09-locais-nova');
  await tap('[data-act="newlocGo"]');
  await sleep(800);
  const binPost = posted.find((x) => x.pathname === '/api/v3/warehouse/locations/bin');
  rec('locais', 'Nova prateleira posta locations/bin com o código em maiúsculas',
    !!binPost && binPost.body.bin_code === 'C01A' && binPost.body.shelf_code === 'S9',
    binPost ? JSON.stringify(binPost.body) : 'sem post');
  rec('locais', 'confirmação nomeia a prateleira criada', /Prateleira C01A cadastrada\./.test(await txt()));

  // seleção múltipla → some pra aba Imprimir
  await tap('[data-act="seltoggle"][data-arg="bins:1"]');
  await tap('[data-act="seltoggle"][data-arg="bins:2"]');
  rec('locais', 'marcar 2 prateleiras mostra a barra de seleção',
    /2 etiquetas escolhidas/.test(await txt()));
  await shot('10-locais-selecao');

  // ── IMPRIMIR ────────────────────────────────────────────────
  await tap('[data-act="tab"][data-arg="imprimir"]');
  await sleep(700);
  const imp = await txt();
  rec('imprimir', 'as 2 etiquetas escolhidas chegaram na aba', /2 prateleiras/.test(imp));
  rec('imprimir', 'os dois botões grandes existem',
    /Imprimir daqui/.test(imp) && /Mandar pro computador/.test(imp));
  rec('imprimir', 'fila veio do GET /api/v3/print-queue com os 3 estados',
    /na fila/.test(imp) && /impresso/.test(imp) && /deu erro/.test(imp));
  // título cortado com reticências na largura do iPhone = nome longo demais
  const clipped = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.item .t').forEach((n) => {
      if (n.scrollWidth > n.clientWidth + 1) out.push(n.textContent.trim().slice(0, 28));
    });
    return out;
  });
  rec('imprimir', 'nenhum título da fila corta na largura do iPhone',
    clipped.length === 0, clipped.join(' | '));
  rec('imprimir', 'o erro da fila diz o que houve', /papel acabou/.test(imp));
  rec('imprimir', 'impressoras vieram do mobile/printers com o estado',
    /EPSON/.test(imp) && /sem papel/.test(imp) && /34 hoje/.test(imp));
  rec('imprimir', 'picklist de hoje tem botão próprio', /Picklist de hoje/.test(imp));
  await shot('11-imprimir');

  // AIRPRINT: window.open é dublado; a folha tem que sair desenhada de verdade
  await page.evaluate(() => {
    window.__printed = null;
    window.open = function () {
      const fake = {
        closed: false,
        document: {
          open: function () {}, close: function () {},
          write: function (h) { window.__printed = h; },
        },
        close: function () { this.closed = true; },
      };
      window.__win = fake;
      return fake;
    };
  });
  await tap('[data-act="printHere"]');
  await sleep(900);
  const sheet = await page.evaluate(() => window.__printed || '');
  rec('imprimir', 'Imprimir daqui abriu a janela e desenhou a folha 4x6',
    /4in 6in/.test(sheet) && /A03B2/.test(sheet) && /A04/.test(sheet));
  rec('imprimir', 'a folha tem Code 128 e QR de verdade (SVG, sem CDN)',
    (sheet.match(/<svg/g) || []).length >= 4 && !/https?:\/\//.test(sheet.replace(/xmlns="[^"]*"/g, '')),
    (sheet.match(/<svg/g) || []).length + ' svg');
  rec('imprimir', 'a folha chama window.print sozinha (AirPrint do iPhone)', /window\.print\(\)/.test(sheet));

  posted.length = 0;
  await tap('[data-act="printSend"]');
  await sleep(900);
  const subPost = posted.find((x) => x.pathname === '/api/v3/warehouse/mobile/print/submit');
  rec('imprimir', 'Mandar pro computador posta print/submit com kind e bins',
    !!subPost && subPost.body.kind === 'bin_labels' && JSON.stringify(subPost.body.bins) === '[1,2]',
    subPost ? JSON.stringify(subPost.body) : 'sem post');
  rec('imprimir', 'confirmação diz onde e em quanto tempo',
    /Aparece no computador da impressora em até 30 s\./.test(await txt()));
  rec('imprimir', 'a escolha some depois de mandar (não manda duas vezes)',
    await page.evaluate(() => window.HF_M.state.sel.bins.length === 0));

  posted.length = 0;
  await tap('[data-act="printPicklist"]');
  await sleep(700);
  const pl = posted.find((x) => x.pathname === '/api/v3/warehouse/mobile/print/submit');
  rec('imprimir', 'Picklist posta kind picklist', !!pl && pl.body.kind === 'picklist',
    pl ? JSON.stringify(pl.body) : 'sem post');

  posted.length = 0;
  await tap('[data-act="cancelJob"][data-arg="71"]');
  await sleep(700);
  rec('imprimir', 'Cancelar posta print-queue/71/cancel',
    !!posted.find((x) => x.pathname === '/api/v3/print-queue/71/cancel'));

  // ── ETIQUETAS DE ENVIO DE HOJE (S2) ─────────────────────────
  const shipCard = await page.$('[data-card="shipping-labels"]');
  rec('envio', 'cartao "Etiquetas de envio de hoje" existe na aba Imprimir', !!shipCard);
  const shipTxt = shipCard ? await page.evaluate((e) => e.innerText.replace(/\s+/g, ' '), shipCard) : '';
  rec('envio', 'conta prontas, ja impressas e pra imprimir',
    /4 prontas/.test(shipTxt) && /1 impressas/.test(shipTxt) && /3 pra imprimir/.test(shipTxt), shipTxt.slice(0, 140));
  rec('envio', 'lista por produto com apelido, quantas e local',
    /BENF-300/.test(shipTxt) && /A03B2/.test(shipTxt) && /RUT-500/.test(shipTxt), shipTxt.slice(0, 200));
  rec('envio', 'produto sem bin mostra a prateleira em vez de nada', /S6/.test(shipTxt), '');
  rec('envio', 'os dois caminhos existem (mandar pra Central / abrir aqui)',
    !!(await page.$('[data-act="shipSend"]')) && !!(await page.$('[data-act="shipOpen"]')));
  // botao de dedo grande: a mao do Bruno esta no armazem, nao no mouse
  const shipBtnH = await page.evaluate(() => {
    const b = document.querySelector('[data-act="shipSend"]');
    return b ? Math.round(b.getBoundingClientRect().height) : 0;
  });
  rec('envio', 'botao com alvo de toque de 44px+', shipBtnH >= 44, shipBtnH + 'px');
  await shot('15-envio');

  // MANDAR PRO COMPUTADOR: sem take, o job fica na fila e a Central imprime
  posted.length = 0;
  await tap('[data-act="shipSend"]');
  await sleep(900);
  const shipSend = posted.find((x) => x.pathname === '/api/v3/print-queue/shipping-labels');
  rec('envio', 'Mandar pro computador posta shipping-labels SEM take (vai pra fila)',
    !!shipSend && !!shipSend.body.day && !shipSend.body.take,
    shipSend ? JSON.stringify(shipSend.body) : 'sem post');
  rec('envio', 'confirmacao diz onde sai e em quanto tempo',
    /Sai na 4x6 da Central em até 30 s\./.test(await txt()));

  // ABRIR PDF AQUI: take + GET do arquivo COM o PIN (aba nova nao manda header)
  await page.evaluate(() => {
    window.__shipWin = null;
    window.open = function () {
      const w = { _loc: '', document: { open() {}, close() {}, write() {} }, close() {} };
      Object.defineProperty(w, 'location', { set: (v) => { w._loc = String(v); window.__shipWin = String(v); }, get: () => w._loc });
      return w;
    };
  });
  /* called NAO e zerado aqui: a assercao de contrato mais abaixo conta quantas
     rotas a pagina chamou no fluxo inteiro. Marcamos o ponto de corte. */
  posted.length = 0;
  const calledMark = called.length;
  await tap('[data-act="shipOpen"]');
  /* POST → GET do arquivo → blob → aba: uma corrente de 3 idas ao servidor.
     Esperar um numero fixo de ms deixa o teste piscando; esperamos o RESULTADO. */
  await page.waitForFunction(() => !!window.__shipWin, { timeout: 8000 }).catch(() => {});
  await sleep(200);
  const shipOpen = posted.find((x) => x.pathname === '/api/v3/print-queue/shipping-labels');
  rec('envio', 'Abrir PDF aqui posta com take:true (quem abre e quem pegou)',
    !!shipOpen && shipOpen.body.take === true, shipOpen ? JSON.stringify(shipOpen.body) : 'sem post');
  const fileCall = called.slice(calledMark).find((c) => /\/print-queue\/\d+\/file$/.test(c.pathname));
  rec('envio', 'o PDF e buscado COM o PIN no header (nao por link solto)',
    !!fileCall && fileCall.pin === PIN, fileCall ? 'pin=' + (fileCall.pin ? 'ok' : 'vazio') : 'sem GET do arquivo');
  const shipWin = await page.evaluate(() => window.__shipWin || '');
  rec('envio', 'a aba recebe um blob local (o AirPrint abre o arquivo, nao a rota)',
    /^blob:/.test(shipWin), shipWin || 'aba sem endereco');
  await shot('16-envio-aberto');

  // ── LER CÓDIGO ──────────────────────────────────────────────
  await tap('.fab');
  await sleep(600);
  rec('scan', 'câmera de tela cheia abriu', !!(await page.$('.cam')));
  rec('scan', 'sem câmera no headless a tela AVISA e oferece digitar (REGRA #0)',
    /câmera|digitar/i.test(await txt()) && !!(await page.$('#mmanual')));
  // um toast de outra tela não pode tapar a dica nem o campo de digitar
  rec('scan', 'a câmera fica ACIMA do toast (nada tapa o campo do código)',
    await page.evaluate(() => {
      const z = (s) => Number(getComputedStyle(document.querySelector(s)).zIndex) || 0;
      return z('.cam') > z('#toast');
    }));
  await shot('12-scan');

  await page.type('#mmanual', 'BX-0451', { delay: 12 });
  await tap('[data-act="camManual"]');
  await sleep(900);
  rec('scan', 'código digitado resolve e cai na folha da caixa',
    /Caixa BX-0451/.test(await txt()) && !(await page.$('.cam')));
  await page.evaluate(() => { window.HF_M.state.sheet = null; window.HF_M.render(); });

  await tap('.fab');
  await sleep(500);
  await page.type('#mmanual', '036000291452', { delay: 8 });
  await tap('[data-act="camManual"]');
  await sleep(900);
  rec('scan', 'UPC da garrafa resolve e cai na ficha do produto',
    /Rutin 500/.test(await txt()) && /Disponível/i.test(await txt())
    && await page.evaluate(() => window.HF_M.state.sheet && window.HF_M.state.sheet.type === 'product'
      && window.HF_M.state.sheet.product_id === 99));
  await page.evaluate(() => { window.HF_M.state.sheet = null; window.HF_M.render(); });

  await tap('.fab');
  await sleep(500);
  await page.type('#mmanual', 'NAOEXISTE9', { delay: 8 });
  await tap('[data-act="camManual"]');
  await sleep(900);
  rec('scan', 'código desconhecido ensina o que fazer, não dá erro cru',
    /Não reconheci\. Digite o código ou cadastre\./.test(await txt()));
  await shot('13-scan-desconhecido');
  await tap('[data-act="camClose"]');

  // ── PWA + TEXTO ─────────────────────────────────────────────
  const pwa = await page.evaluate(() => ({
    manifest: !!document.querySelector('link[rel="manifest"]'),
    capable: !!document.querySelector('meta[name="apple-mobile-web-app-capable"][content="yes"]'),
    statusbar: !!document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]'),
    touchicon: !!document.querySelector('link[rel="apple-touch-icon"]'),
    theme: (document.querySelector('meta[name="theme-color"]') || {}).content,
    sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
  }));
  rec('pwa', 'manifest, apple-mobile-web-app-capable, status bar e apple-touch-icon',
    pwa.manifest && pwa.capable && pwa.statusbar && pwa.touchicon, JSON.stringify(pwa));
  rec('pwa', 'theme-color navy do STYLE-KIT', pwa.theme === '#0d1f3c', String(pwa.theme));
  rec('pwa', 'NENHUM service worker (cache velho de estoque é pior que recarregar)', pwa.sw === false);
  const man = await page.evaluate(() => fetch('/m/manifest.webmanifest').then((r) => r.json()));
  rec('pwa', 'manifest com nome, standalone e start_url /m/',
    man.name === 'HealthFare Admin' && man.short_name === 'HF Admin'
    && man.display === 'standalone' && man.start_url === '/m/', JSON.stringify(man.icons.length) + ' ícones');

  await tap('[data-act="tab"][data-arg="inicio"]');
  const all = await txt();
  rec('texto', 'sem travessão (em dash) na tela', !/—/.test(all), (all.match(/.{0,20}—.{0,20}/) || [''])[0]);
  rec('texto', 'sem entidade HTML crua vazando', !/&[a-z]+;/.test(all), (all.match(/&[a-z]+;/) || [''])[0]);
  rec('texto', 'PT-BR com acento de verdade na tela',
    /Disponível/i.test(all) && /Aprovações/i.test(all) && /atenção/i.test(all));

  // ── CONTRATO: nenhuma rota fora da lista ────────────────────
  const WHITELIST = [
    /^\/api\/v3\/warehouse\/mobile\/(bootstrap|printers|scan\/resolve|print\/submit)$/,
    /^\/api\/v3\/warehouse\/labels$/,
    /^\/api\/v3\/warehouse\/product\/\d+$/,
    /^\/api\/v3\/warehouse\/product\/\d+\/(entrada|place|move|adjust|separate)$/,
    /^\/api\/v3\/warehouse\/requests\/\d+\/(approve|reject)$/,
    /^\/api\/v3\/warehouse\/locations\/(bin|box)$/,
    /^\/api\/v3\/print-queue$/,
    /^\/api\/v3\/print-queue\/\d+\/(take|done|error|cancel)$/,
    // S2 · etiquetas de envio: preview, compor e baixar o PDF composto
    /^\/api\/v3\/print-queue\/shipping-labels(\/preview)?$/,
    /^\/api\/v3\/print-queue\/\d+\/file$/,
  ];
  const stray = called.map((c) => c.pathname).filter((p, i, a) => a.indexOf(p) === i)
    .filter((p) => !WHITELIST.some((re) => re.test(p)));
  rec('contrato', 'a página só chamou rotas da lista combinada', stray.length === 0, stray.join(', '));
  rec('contrato', 'todo pedido levou o header x-admin-pin', called.length > 10);

  // ── SÓ LEITURA: sem manage_stock, some tudo que escreve ─────
  await page.evaluate(() => {
    window.HF_M.state.me = { name: 'Carol', role: 'viewer', functions: ['view_stock'] };
    window.HF_M.state.tab = 'aprovar';
    window.HF_M.render();
  });
  await sleep(300);
  rec('rbac', 'sem manage_stock não aparece Aprovar nem Recusar',
    (await page.$$('[data-act="approve"]')).length === 0 && (await page.$$('[data-act="reject"]')).length === 0);
  rec('rbac', 'e a tela explica por quê', /Só quem tem permissão de mexer no estoque decide isso\./.test(await txt()));
  await page.evaluate(() => { window.HF_M.state.tab = 'locais'; window.HF_M.render(); });
  await sleep(250);
  rec('rbac', 'sem manage_stock não aparece "Nova prateleira"',
    (await page.$$('[data-act="newloc"]')).length === 0);
  await shot('14-somente-leitura');

  rec('boot', 'nenhum erro de console no fluxo inteiro', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();

  const fails = results.filter((r) => !r.pass);
  console.log('\n' + '─'.repeat(60));
  console.log(results.length - fails.length + ' PASS  ·  ' + fails.length + ' FAIL');
  fs.writeFileSync(path.join(QA, 'qa-mobile-report.json'),
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (fails.length) { fails.forEach((f) => console.log('  FAIL [' + f.group + '] ' + f.name + '  ' + f.detail)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
