'use strict';
/**
 * QA harness do dashboard-v4 — S15 FASE 3
 * (importar da Veeqo · etiquetas 4x6 · pesos · taras · meta nas aprovações).
 *
 * Rodar da RAIZ do projeto:  node docs/architecture/_qa/qa-dashboard-phase3.js
 *
 * Mesmo método do qa-dashboard.js (o harness compartilhado da fase 1):
 *   1. sobe um http estático servindo `public/` (o build tem que existir:
 *      `node node_modules/vite/bin/vite.js build` dentro de dashboard-v4);
 *   2. INTERCEPTA /api/** e responde das fixtures docs/architecture/_qa/fixtures/
 *      — nunca fala com servidor nem com banco;
 *   3. injeta sessionStorage v3pin + v3login (functions ['*']);
 *   4. abre cada tela da fase 3, tira screenshot em p3-*.png e roda as
 *      asserções; imprime PASS/FAIL e sai com 1 se algo falhar.
 *
 * O que este harness cobre e o compartilhado não:
 *   · hub com o botão "Importar da Veeqo" e o modal de import no passo 1
 *     (mostrando quantos entram, quantos voltam pra revisão);
 *   · painel de drift aberto pelo KPI Δ Veeqo;
 *   · Locais com as colunas tara/capacidade/lote/lacre e a seleção que leva
 *     pra página de etiquetas;
 *   · Etiquetas: 3 etiquetas 4x6, cada uma com um <svg> Code 128 REAL (barras
 *     conferidas, não um placeholder) e um QR;
 *   · Product Setup com a coluna de peso e o modal Calibrar fazendo a conta;
 *   · Aprovações mostrando o meta da pesagem e o meta da caixa nova.
 */
const puppeteer = require('puppeteer');
const http = require('http');
const path = require('path');
const fs = require('fs');

const QA = __dirname;
const ROOT = path.join(QA, '..', '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const FIX = path.join(QA, 'fixtures');

const results = [];
const rec = (group, name, pass, detail) => {
  results.push({ group, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? 'PASS ' : 'FAIL ') + '[' + group + '] ' + name + (detail ? '  ·  ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readFix = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));

// ── fixtures ─────────────────────────────────────────────────────
const OVERVIEW = readFix('warehouse-overview.json');
const PRODUCT = readFix('warehouse-product.json');
const LOCATIONS = readFix('p3-locations.json');      // fase 3: com tara/lote/lacre
const REQUESTS = readFix('p3-requests.json');        // fase 3: com meta
const WEIGHTS = readFix('p3-weights.json');
const LABELS = readFix('p3-labels.json');
const DRIFT = readFix('p3-drift.json');
const IMPORT = readFix('p3-import-veeqo.json');
const PSETUP = readFix('p3-product-setup.json');

const LOGIN = { name: 'QA Admin', role: 'admin', functions: ['*'] };

/** POSTs que a página faz. Guardado pra conferir que a UI chamou o endpoint certo. */
const posted = [];

/* S15.29 · FILA DE IMPRESSAO PEDIDA PELO CELULAR (contrato 1, 2 e 3).
   Quem esta no celular nao tem impressora na mao: manda pra fila e QUEM tem
   papel puxa. A pagina Impressao e a janela do admin pra essa fila. */
let QUEUE = [
  { id: 21, kind: 'bin_labels', payload: { labels: [{ kind: 'bin', code: 'A03B2' }, { kind: 'bin', code: 'B03S4' }] },
    requested_by: 'Bruno', status: 'queued', age_min: 3, taken_by: null, is_test: false, created_at: '2026-08-19T13:00:00Z' },
  { id: 22, kind: 'box_label', payload: { labels: [{ kind: 'box', code: 'BX-0004' }] },
    requested_by: 'Bruno', status: 'taken', age_min: 9, taken_by: 'Simone', is_test: false, created_at: '2026-08-19T12:54:00Z' },
  { id: 23, kind: 'picklist', payload: { date: '2026-08-19' },
    requested_by: 'Bruno', status: 'done', age_min: 41, taken_by: 'Vitor', is_test: true, created_at: '2026-08-19T12:22:00Z' },
];

function apiFixture(pathname, search, method, body) {
  if (method === 'POST') posted.push({ pathname, body });

  // ── /api/v3/print-queue/* (fila do celular) ─────────────────
  if (pathname.startsWith('/api/v3/print-queue')) {
    const m = pathname.match(/\/api\/v3\/print-queue\/(\d+)\/(take|done|error|cancel)$/);
    if (m) {
      const id = Number(m[1]); const op = m[2];
      const job = QUEUE.find((j) => j.id === id);
      if (!job) return { error: { code: 'not_found', message: 'job sumiu' } };
      if (op === 'cancel') { job.status = 'cancelled'; QUEUE = QUEUE.filter((j) => j.id !== id); }
      return { data: { job } };
    }
    const st = new URLSearchParams(search).get('status');
    const list = (!st || st === 'all') ? QUEUE : QUEUE.filter((j) => j.status === st);
    return { data: { jobs: list } };
  }

  // ── /api/v3/warehouse/* ─────────────────────────────────────
  if (pathname.startsWith('/api/v3/warehouse/')) {
    const p = pathname.slice('/api/v3/warehouse/'.length);
    if (p === 'overview') return OVERVIEW;
    if (p === 'locations') return LOCATIONS;
    if (p === 'weights') return WEIGHTS;
    if (p === 'drift') return DRIFT;
    if (p === 'import-veeqo') return IMPORT;
    if (p === 'labels') {
      // devolve só as etiquetas pedidas no query, como o backend faz
      const q = new URLSearchParams(search);
      const ids = (k) => (q.get(k) || '').split(',').filter(Boolean).map(Number);
      const bins = ids('bins'); const boxes = ids('boxes');
      const all = LABELS.data.labels;
      const list = all.filter((l) => (l.kind === 'bin' ? bins.includes(l.bin_id) : boxes.includes(l.box_id)));
      return { data: { labels: list.length ? list : all } };
    }
    /* contrato (2): "Mandar pro computador da impressora". O servidor resolve
       as etiquetas AGORA (mesma função do GET /labels) e guarda o desenho no
       payload, pra o papel sair igual ao que estava na tela. */
    if (p === 'mobile/print/submit') {
      const b = body || {};
      const ids = (b.bins || []).length + (b.boxes || []).length;
      const all = LABELS.data.labels;
      const list = all.filter((l) => (l.kind === 'bin' ? (b.bins || []).includes(l.bin_id) : (b.boxes || []).includes(l.box_id)));
      const labels = list.length ? list : all.slice(0, Math.max(1, ids));
      const job = { id: 99, kind: b.kind || 'bin_labels', payload: { labels }, requested_by: 'QA Admin',
        status: 'queued', age_min: 0, taken_by: null, is_test: false, created_at: new Date().toISOString() };
      QUEUE = [job].concat(QUEUE);
      return { data: { job_id: 99, queued: labels.length, labels } };
    }
    if (p === 'requests') {
      const st = new URLSearchParams(search).get('status');
      const all = REQUESTS.data.requests;
      const list = st === 'pending' ? all.filter((r) => r.status === 'pending')
                 : st === 'decided' ? all.filter((r) => r.status !== 'pending')
                 : all;
      return { data: { requests: list } };
    }
    if (p.startsWith('product/')) {
      const id = Number(p.split('/')[1]);
      const row = OVERVIEW.data.products.find((x) => x.product_id === id);
      return row ? { data: { ...PRODUCT.data, product: row } } : PRODUCT;
    }
    if (p.startsWith('family/')) return { data: PRODUCT.data.family };
    /* contrato (4): criar varias prateleiras de uma vez. Cria as que faltam e
       PULA as que ja existem (nunca sobrescreve). O stub finge 2 repetidas. */
    if (p === 'locations/bins/bulk') {
      const list = (body && Array.isArray(body.bins)) ? body.bins : [];
      const skipped = list.slice(0, 2).map((b) => b.bin_code);
      return { data: { created: Math.max(0, list.length - skipped.length), skipped } };
    }
    // qualquer outro POST de escrita (weights/*, locations/box/:id/label-printed…)
    return { data: { ok: true } };
  }

  // ── /api/v3/data/* ──────────────────────────────────────────
  if (pathname === '/api/v3/data/login') return { data: LOGIN };
  if (pathname === '/api/v3/data/health') return { data: { worker: { alive: true }, queue: 0, mode: 'qa' } };
  if (pathname === '/api/v3/data/product-setup') return PSETUP;
  if (pathname === '/api/v3/data/product-setup/tiers') return { data: [] };
  if (pathname.startsWith('/api/v3/data/product-setup/')) return { data: { ok: true } };
  if (pathname === '/api/v3/data/inventory-settings') {
    return { data: { tiers: [], mix: [], supplies: [], size_supply: [], questions: [], bins: [{ n: 8 }], thresholds: [{ n: 0 }] } };
  }
  if (pathname === '/api/v3/data/rbac') return { data: { functions: [], roles: [] } };
  /* Página Impressão: o painel da fila é o que este harness testa; o resto da
     página (impressoras, spooler, histórico) vem vazio de propósito, senão o
     stub viraria uma segunda implementação do backend de impressão. */
  if (pathname === '/api/v3/data/printers') {
    return { data: { printers: [], stats: { jobs: 0, labels: 0, operators: 0 },
      byPrinter: [], byOperator: [], byProduct: [], history: [], transitions: [], incidents: [], errorLog: [] } };
  }
  if (pathname === '/api/v3/data/timeline') return { data: { events: [], operators: [], gaps: [] } };
  if (pathname === '/api/v3/data/deadlines') return { data: { deadlines: [] } };
  return { data: {} };
}

// ── servidor estático de public/ ─────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json', '.ico': 'image/x-icon' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      let p = decodeURIComponent(u.pathname);
      if (p === '/' || p === '/dashboard-v4' || p === '/dashboard-v4/') p = '/dashboard-v4/index.html';
      const file = path.join(PUBLIC, p.replace(/^\/+/, ''));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ── decodificador Code 128 independente ───────────────────────────
   O harness NÃO importa o encoder da página: reimplementa a tabela e decodifica
   as barras que o DOM realmente tem. Se o encoder quebrar, isto falha; se os
   dois usassem o mesmo código, um bug passaria despercebido. */
const C128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','233111'];

/** rects [{x,w}] → texto. Lança se checksum/stop não fecharem. */
function decodeCode128(rects, totalModules) {
  // reconstrói as larguras alternando barra/espaço a partir dos rects
  const widths = [];
  let cursor = 0;
  for (const r of rects) {
    if (r.x > cursor) widths.push(r.x - cursor);     // espaço antes desta barra
    widths.push(r.w);                                // a barra
    cursor = r.x + r.w;
  }
  if (cursor < totalModules) widths.push(totalModules - cursor);
  // a última barra de término (2 módulos) fecha o símbolo; tira o resto
  const w = widths.slice(0, Math.floor((widths.length) / 6) * 6);
  if (!w.length || w.length % 6) throw new Error('larguras não múltiplas de 6 (' + widths.length + ')');
  const syms = [];
  for (let i = 0; i < w.length; i += 6) {
    const v = C128.indexOf(w.slice(i, i + 6).join(''));
    if (v < 0) throw new Error('padrão desconhecido em ' + i);
    syms.push(v);
  }
  const stop = syms.pop();
  if (stop !== 106) throw new Error('sem STOP (achou ' + stop + ')');
  const check = syms.pop();
  const start = syms[0];
  let sum = start;
  syms.slice(1).forEach((v, i) => { sum += v * (i + 1); });
  if (sum % 103 !== check) throw new Error('checksum ' + (sum % 103) + ' != ' + check);
  let mode = start === 105 ? 'C' : 'B';
  let out = '';
  for (const v of syms.slice(1)) {
    if (mode === 'C') {
      if (v === 100) { mode = 'B'; continue; }
      if (v === 99) continue;
      out += String(v).padStart(2, '0');
    } else {
      if (v === 99) { mode = 'C'; continue; }
      if (v === 100) continue;
      out += String.fromCharCode(v + 32);
    }
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(path.join(PUBLIC, 'dashboard-v4', 'index.html'))) {
    console.error('build ausente: rode `node node_modules/vite/bin/vite.js build` em dashboard-v4/');
    process.exit(1);
  }

  const { server, port } = await startServer();
  const BASE = 'http://127.0.0.1:' + port + '/dashboard-v4/';
  console.log('servindo public/ em ' + BASE + '  (API interceptada, sem rede)\n');

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1050, deviceScaleFactor: 1 });

  const EXTERNAL = /fonts\.(googleapis|gstatic)\.com|Failed to load resource/i;
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (EXTERNAL.test(t)) return;
    consoleErrors.push('console.error: ' + t.slice(0, 300));
  });
  page.on('requestfailed', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:' + port)) return;
    consoleErrors.push('requestfailed: ' + r.url() + ' (' + ((r.failure() && r.failure().errorText) || '') + ')');
  });

  const ORIGIN = 'http://127.0.0.1:' + port;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) { req.continue(); return; }
    if (url.startsWith(ORIGIN)) {
      const u = new URL(url);
      if (u.pathname.startsWith('/api/')) {
        let body = null;
        try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch (e) { body = req.postData(); }
        req.respond({
          status: 200, contentType: 'application/json',
          body: JSON.stringify(apiFixture(u.pathname, u.search, req.method(), body)),
        });
        return;
      }
      req.continue(); return;
    }
    req.abort();
  });

  await page.evaluateOnNewDocument((login) => {
    try {
      sessionStorage.setItem('v3pin', '0000');
      sessionStorage.setItem('v3login', JSON.stringify(login));
      sessionStorage.setItem('hf-tweaks', JSON.stringify({ theme: 'light' }));
    } catch (e) { /* ignore */ }
  }, LOGIN);

  const shot = async (name) => {
    const f = path.join(QA, 'p3-' + name + '.png');
    await page.screenshot({ path: f, fullPage: false });
    const kb = Math.round(fs.statSync(f).size / 1024);
    rec('screenshot', name, kb > 4 && kb < 3072, kb + ' KB → ' + path.basename(f));
  };

  async function go(hash) {
    await page.goto('about:blank');
    await page.goto(BASE + '#' + hash, { waitUntil: 'networkidle0' });
    await sleep(600);
    consoleErrors.length = 0;
    await sleep(600);
  }
  const noErr = (group) => rec(group, 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  // ══ 1. HUB: botão de import + modal passo 1 ═══════════════════
  await go('estoque');
  await page.waitForSelector('[data-table="produtos"] tbody tr', { timeout: 10000 }).catch(() => {});
  noErr('hub');

  const importBtn = await page.$('[data-act="importar-veeqo"]');
  rec('hub', 'botão "Importar da Veeqo" no cabeçalho', !!importBtn);
  const importTxt = importBtn ? await page.evaluate((e) => e.textContent.trim(), importBtn) : '';
  rec('hub', 'texto do botão em PT-BR sem travessão',
      importTxt === 'Importar da Veeqo', JSON.stringify(importTxt));
  await shot('hub-import-btn');

  await importBtn.click();
  await page.waitForSelector('.kit-modal', { timeout: 5000 }).catch(() => {});
  await sleep(400);
  const modal1 = await page.$eval('.kit-modal', (e) => e.textContent).catch(() => '');
  rec('hub-import', 'modal abre no passo 1 de 2',
      /Passo 1 de 2/.test(modal1), modal1.slice(0, 50));
  rec('hub-import', 'passo 1 mostra a conta antes de aplicar',
      /Entram/.test(modal1) && /Pra revisar/.test(modal1) && /Já batem/.test(modal1));
  // a fixture do overview tem 1 produto com delta>0 (Ashwagandha +3) e 1 com
  // delta<0 (Benfotiamine -12); o resto bate ou não tem SKU
  rec('hub-import', 'conta bate com a fixture (1 entra +3, 1 revisar)',
      /Ashwagandha/.test(modal1) && /Benfotiamine/.test(modal1) && /\+3/.test(modal1),
      modal1.replace(/\s+/g, ' ').slice(0, 200));
  await shot('hub-import-modal');

  // passo 2 → confirmar → chama o endpoint certo
  await page.evaluate(() => { const b = document.querySelector('[data-act="revisar"]'); if (b) b.click(); });
  await sleep(250);
  const modal2 = await page.$eval('.kit-modal', (e) => e.textContent).catch(() => '');
  rec('hub-import', 'passo 2 pede confirmação explícita',
      /Passo 2 de 2/.test(modal2) && /Confirmar: importar/.test(modal2));
  posted.length = 0;
  await page.evaluate(() => { const b = document.querySelector('[data-act="confirmar"]'); if (b) b.click(); });
  await sleep(700);
  rec('hub-import', 'confirmar chama POST /warehouse/import-veeqo',
      posted.some((p) => p.pathname === '/api/v3/warehouse/import-veeqo'),
      JSON.stringify(posted.map((p) => p.pathname)));
  const toastTxt = await page.$eval('.kit-toast', (e) => e.textContent).catch(() => '');
  rec('hub-import', 'toast resume importados e pendentes de revisão',
      /importado/.test(toastTxt) && /revisar/.test(toastTxt), toastTxt.slice(0, 90));

  // ══ 2. HUB: KPI Δ Veeqo abre o painel de drift ════════════════
  await go('estoque');
  await page.waitForSelector('[data-kpi="drift"]', { timeout: 8000 }).catch(() => {});
  const nKpis = await page.$$eval('[data-kpi]', (e) => e.length);
  rec('hub', 'continua com os 8 KPIs', nKpis === 8, 'kpis=' + nKpis);
  await page.click('[data-kpi="drift"]');
  await page.waitForSelector('[data-panel="drift"]', { timeout: 5000 }).catch(() => {});
  const driftPanel = await page.$('[data-panel="drift"]');
  rec('hub-drift', 'KPI Δ Veeqo abre o painel da lista', !!driftPanel);
  const nDrift = await page.$$eval('[data-table="drift"] tbody tr', (e) => e.length).catch(() => 0);
  rec('hub-drift', 'lista os 2 produtos com diferença', nDrift === 2, 'linhas=' + nDrift);
  const driftTxt = await page.$eval('[data-panel="drift"]', (e) => e.textContent).catch(() => '');
  rec('hub-drift', 'mostra o Δ com sinal dos dois lados',
      /-12/.test(driftTxt) && /\+3/.test(driftTxt));
  await shot('hub-drift');
  noErr('hub-drift');

  // ══ 3. LOCAIS: tara/capacidade/lote/lacre + seleção ═══════════
  await go('estoque-locais');
  await page.waitForSelector('[data-table="bins"] tbody tr', { timeout: 8000 }).catch(() => {});
  noErr('locais');

  /* Espera a coluna Tara aparecer antes de medir. Sem isto, um bundle servido
     pela metade (ex: alguém rodou o build com o harness aberto) faz a tabela
     antiga renderizar e a falha vira "coluna sumiu" em vez de "build velho". */
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-table="bins"] thead th')].some((th) => th.textContent.trim() === 'Tara'),
    { timeout: 8000 },
  ).catch(() => {});

  const heads = await page.$$eval('[data-table="bins"] thead th', (e) => e.map((x) => x.textContent.trim()));
  rec('locais', 'prateleiras têm coluna Tara e Cabe',
      heads.includes('Tara') && heads.includes('Cabe'), heads.join('|'));
  const nTare = await page.$$eval('[data-table="bins"] [data-cell="tare"] input', (e) => e.length);
  rec('locais', 'tara editável em cada prateleira', nTare === 8, 'inputs=' + nTare);
  const tareVal = await page.$eval('[data-bin="1"] [data-cell="tare"] input', (e) => e.value).catch(() => '');
  rec('locais', 'tara vem preenchida da fixture (A03 = 420 g)', tareVal === '420', 'valor=' + tareVal);

  const boxHeads = await page.$$eval('[data-table="boxes"] thead th', (e) => e.map((x) => x.textContent.trim()));
  rec('locais', 'caixas têm Lote, Tara, Lacrada e Etiqueta',
      ['Lote', 'Tara', 'Lacrada', 'Etiqueta'].every((h) => boxHeads.includes(h)), boxHeads.join('|'));
  const batchVal = await page.$eval('[data-box="21"] [data-cell="batch"] input', (e) => e.value).catch(() => '');
  rec('locais', 'lote vem preenchido (BX-0004 = L-2026-07)', batchVal === 'L-2026-07', 'valor=' + batchVal);
  const sealed = await page.$eval('[data-box="21"] [data-cell="sealed"] input', (e) => e.checked).catch(() => null);
  rec('locais', 'lacre marcado na caixa lacrada', sealed === true, 'checked=' + sealed);
  await shot('locais-tara');

  // salvar uma tara chama o endpoint de peso da prateleira
  posted.length = 0;
  await page.focus('[data-bin="5"] [data-cell="tare"] input');
  await page.type('[data-bin="5"] [data-cell="tare"] input', '515');
  await page.evaluate(() => { document.querySelector('[data-bin="5"] [data-cell="tare"] input').blur(); });
  await sleep(600);
  rec('locais', 'editar a tara chama POST /warehouse/weights/bin/5',
      posted.some((p) => p.pathname === '/api/v3/warehouse/weights/bin/5' && p.body && Number(p.body.tare_g) === 515),
      JSON.stringify(posted.map((p) => p.pathname)));

  // seleção 2 bins + 1 caixa → botão leva pro hash de etiquetas
  await page.click('[data-sel-bin="1"]');
  await page.click('[data-sel-bin="7"]');
  await page.click('[data-sel-box="21"]');
  await sleep(200);
  const printBtn = await page.$('[data-act="etiquetas"]');
  const printTxt = printBtn ? await page.evaluate((e) => e.textContent.trim(), printBtn) : '';
  rec('locais', 'botão "Imprimir etiquetas" conta a seleção',
      /Imprimir etiquetas \(3\)/.test(printTxt), JSON.stringify(printTxt));
  await printBtn.click();
  await sleep(900);
  const hash = await page.evaluate(() => location.hash);
  rec('locais', 'leva pro hash das etiquetas com a seleção',
      /^#estoque-etiquetas\?/.test(hash) && /bins=1,7/.test(hash) && /boxes=21/.test(hash), hash);

  // ══ 4. ETIQUETAS: 3 etiquetas com Code 128 real + QR ══════════
  await page.waitForSelector('[data-sheet] [data-label]', { timeout: 8000 }).catch(() => {});
  await sleep(700);
  const nLabels = await page.$$eval('[data-sheet] [data-label]', (e) => e.length);
  rec('etiquetas', 'renderiza as 3 etiquetas escolhidas', nLabels === 3, 'etiquetas=' + nLabels);

  const codes = await page.$$eval('[data-sheet] [data-label]', (e) => e.map((x) => x.dataset.label));
  rec('etiquetas', 'códigos vêm do backend (2 prateleiras + 1 caixa)',
      codes.join(',') === 'A03B2,B03S4,BX-0004', codes.join(','));

  const kinds = await page.$$eval('[data-sheet] [data-label]', (e) => e.map((x) => x.dataset.kind));
  rec('etiquetas', 'a variante de caixa existe junto com as de prateleira',
      kinds.filter((k) => k === 'box').length === 1 && kinds.filter((k) => k === 'bin').length === 2, kinds.join(','));

  // Code 128: <svg> presente E decodificável de volta pro código humano
  const nSvg = await page.$$eval('[data-sheet] svg.lbl-barcode', (e) => e.length);
  rec('etiquetas', 'cada etiqueta tem um <svg> Code 128', nSvg === 3, 'svgs=' + nSvg);
  const bars = await page.$$eval('[data-sheet] svg.lbl-barcode', (els) => els.map((s) => ({
    code: s.dataset.barcode,
    modules: Number((s.getAttribute('viewBox') || '0 0 0 0').split(' ')[2]),
    rects: [...s.querySelectorAll('rect')].map((r) => ({ x: Number(r.getAttribute('x')), w: Number(r.getAttribute('width')) })),
  })));
  let barsOk = 0; const barsDetail = [];
  for (const b of bars) {
    try {
      const decoded = decodeCode128(b.rects, b.modules);
      if (decoded === b.code) barsOk += 1; else barsDetail.push(b.code + '→' + decoded);
    } catch (e) { barsDetail.push(b.code + ': ' + e.message); }
  }
  rec('etiquetas', 'as barras decodificam de volta pro código (Code 128 de verdade)',
      barsOk === 3, barsDetail.length ? barsDetail.join(' | ') : '3/3 conferidas');

  // QR: o svg do npm qrcode dentro do container
  const nQr = await page.$$eval('[data-sheet] .lbl-qr', (e) => e.length);
  const qrWithSvg = await page.$$eval('[data-sheet] .lbl-qr svg', (e) => e.length);
  rec('etiquetas', 'cada etiqueta tem um QR renderizado', nQr === 3 && qrWithSvg === 3,
      'containers=' + nQr + ' svgs=' + qrWithSvg);
  const qrPaths = await page.$$eval('[data-sheet] .lbl-qr svg path', (e) => e.length);
  rec('etiquetas', 'o QR tem desenho, não é caixa vazia', qrPaths >= 3, 'paths=' + qrPaths);

  // 4x6 de verdade + uma por folha
  const dims = await page.$eval('[data-sheet] [data-label]', (e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { w: Math.round(r.width), h: Math.round(r.height), brk: cs.pageBreakAfter || cs.breakAfter };
  });
  rec('etiquetas', 'etiqueta tem 4in x 6in (384x576 px a 96dpi)',
      dims.w === 384 && dims.h === 576, JSON.stringify(dims));
  rec('etiquetas', 'uma etiqueta por folha (page-break-after)',
      /always|page/.test(String(dims.brk)), String(dims.brk));
  const css = await page.evaluate(() => [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n'));
  rec('etiquetas', '@page 4in 6in declarado pra impressão',
      /@page\s*\{\s*size:\s*4in 6in/.test(css));

  // código humano grande e legível de longe
  const codeSize = await page.$eval('[data-sheet] .lbl-code', (e) => parseFloat(getComputedStyle(e).fontSize));
  rec('etiquetas', 'código humano bem grande (>= 48px)', codeSize >= 48, codeSize + 'px');
  const l2 = await page.$$eval('[data-sheet] .lbl-line2', (e) => e.map((x) => x.textContent.trim()));
  const l3 = await page.$$eval('[data-sheet] .lbl-line3', (e) => e.map((x) => x.textContent.trim()));
  rec('etiquetas', 'line2 e line3 aparecem nas 3 etiquetas', l2.length === 3 && l3.length === 3,
      JSON.stringify(l2[2]) + ' / ' + JSON.stringify(l3[2]));
  rec('etiquetas', 'etiqueta de caixa traz produto, qtd e lote',
      /Benfotiamine/.test(l2[2]) && /180/.test(l3[2]) && /L-2026-07/.test(l3[2]), l3[2]);
  await shot('etiquetas');
  noErr('etiquetas');

  // imprimir carimba a caixa (só as caixas têm carimbo)
  posted.length = 0;
  await page.evaluate(() => { window.print = () => {}; });   // não abrir diálogo no headless
  await page.click('[data-act="imprimir"]');
  await sleep(800);
  rec('etiquetas', 'imprimir carimba label-printed só na caixa',
      posted.length === 1 && posted[0].pathname === '/api/v3/warehouse/locations/box/21/label-printed',
      JSON.stringify(posted.map((p) => p.pathname)));

  /* ══ 4b. MANDAR PRO COMPUTADOR DA IMPRESSORA (S15.29) ══════════
     Quem está no celular (ou num PC sem impressora de etiqueta do lado) não
     imprime daqui: manda pra fila e QUEM tem papel puxa. */
  const sendBtn = await page.$('[data-act="mandar-estacao"]');
  rec('fila', 'botão "Mandar pro computador da impressora" ao lado do Imprimir', !!sendBtn);
  const sendTxt = sendBtn ? await page.evaluate((e) => e.textContent.trim(), sendBtn) : '';
  rec('fila', 'texto em PT-BR sem travessão',
      sendTxt === 'Mandar pro computador da impressora', JSON.stringify(sendTxt));
  posted.length = 0;
  if (sendBtn) await sendBtn.click();
  await sleep(900);
  const sub = posted.find((p) => p.pathname === '/api/v3/warehouse/mobile/print/submit');
  rec('fila', 'manda a seleção pro submit do contrato',
      !!sub && Array.isArray(sub.body.bins) && sub.body.bins.join(',') === '1,7'
        && Array.isArray(sub.body.boxes) && sub.body.boxes.join(',') === '21',
      sub ? JSON.stringify(sub.body) : 'sem post');
  const queuedCard = await page.$('[data-card="fila-enviada"]');
  const queuedTxt = queuedCard ? await page.evaluate((e) => e.innerText.replace(/\s+/g, ' '), queuedCard) : '';
  rec('fila', 'a tela diz onde o papel vai sair e que dá pra cancelar',
      /fila do computador da impressora/i.test(queuedTxt) && /Central do operador/.test(queuedTxt)
        && /cancelar/i.test(queuedTxt), queuedTxt.slice(0, 140));
  await shot('etiquetas-mandar-estacao');
  noErr('fila-etiquetas');

  // ══ 5. PRODUCT SETUP: coluna de peso + Calibrar ═══════════════
  await go('produto-setup');
  await page.waitForSelector('[data-table="produto-setup"] tbody tr', { timeout: 8000 }).catch(() => {});
  await sleep(500);
  noErr('produto-setup');

  const psHeads = await page.$$eval('[data-table="produto-setup"] thead th', (e) => e.map((x) => x.textContent.trim()));
  rec('produto-setup', 'coluna "Peso da unidade" existe',
      psHeads.includes('Peso da unidade'), psHeads.join('|'));
  const wCells = await page.$$eval('[data-cell="unit-weight"]', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  rec('produto-setup', 'peso vem de /warehouse/weights e aparece na linha',
      wCells.some((t) => /128\.40 g/.test(t)) && wCells.some((t) => /sem peso/.test(t)),
      JSON.stringify(wCells.slice(0, 3)));
  rec('produto-setup', 'mostra o tamanho da amostra (n=)',
      wCells.some((t) => /n=10/.test(t)), JSON.stringify(wCells[0]));

  // Calibrar: 10 garrafas, bruto 1704 g, tara 420 → (1704-420)/10 = 128,40 g
  await page.click('[data-table="produto-setup"] tbody tr:first-child [data-act="calibrar"]');
  await page.waitForSelector('[data-modal="calibrar"]', { timeout: 5000 }).catch(() => {});
  await page.click('[data-field="gross"]'); await page.type('[data-field="gross"]', '1704');
  await page.click('[data-field="tare"]'); await page.type('[data-field="tare"]', '420');
  await page.evaluate(() => { const c = document.querySelector('[data-field="count"]'); c.value = ''; });
  await page.click('[data-field="count"]'); await page.type('[data-field="count"]', '10');
  await sleep(350);
  const previewUnit = await page.$eval('[data-preview="unit"]', (e) => e.textContent.trim()).catch(() => '');
  rec('produto-setup', 'Calibrar faz a conta (1704 - 420) / 10 = 128.40 g',
      previewUnit === '128.40 g', 'preview=' + previewUnit);
  await shot('produto-setup-calibrar');

  posted.length = 0;
  await page.click('[data-act="salvar-peso"]');
  await sleep(700);
  const calPost = posted.find((p) => p.pathname === '/api/v3/warehouse/weights/product/1');
  rec('produto-setup', 'salvar manda sample_gross_g / sample_count / sample_tare_g',
      !!calPost && Number(calPost.body.sample_gross_g) === 1704
      && Number(calPost.body.sample_count) === 10 && Number(calPost.body.sample_tare_g) === 420,
      JSON.stringify(calPost && calPost.body));

  // ══ 6. APROVAÇÕES: meta da pesagem e da caixa ═════════════════
  await go('estoque-aprovacoes');
  await page.waitForSelector('[data-table="requests"] tbody tr', { timeout: 8000 }).catch(() => {});
  noErr('aprovacoes');

  const nReq = await page.$$eval('[data-table="requests"] tbody tr', (e) => e.length);
  rec('aprovacoes', 'lista as 4 propostas pendentes', nReq === 4, 'linhas=' + nReq);
  const nWeigh = await page.$$eval('[data-meta="weigh"]', (e) => e.length);
  rec('aprovacoes', 'as 2 contagens por peso mostram o detalhe', nWeigh === 2, 'metas=' + nWeigh);
  const weighTxt = await page.$eval('[data-meta="weigh"]', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  rec('aprovacoes', 'detalhe traz bruto, tara, unidade, contou e confiança',
      /Bruto/.test(weighTxt) && /Tara/.test(weighTxt) && /Unidade/.test(weighTxt)
      && /Contou/.test(weighTxt) && /confiança/.test(weighTxt), weighTxt.slice(0, 140));
  const tones = await page.$$eval('[data-meta="weigh"] .kit-chip', (e) => e.map((x) => x.className + ':' + x.textContent.trim()));
  rec('aprovacoes', 'confiança baixa aparece marcada em vermelho',
      tones.some((t) => /bad/.test(t) && /baixa/.test(t)), JSON.stringify(tones));
  const boxMeta = await page.$eval('[data-meta="box"]', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  rec('aprovacoes', 'entrada de caixa nova mostra lote e área',
      /caixa nova/.test(boxMeta) && /L-2026-09/.test(boxMeta) && /Palete 3/.test(boxMeta), boxMeta.slice(0, 120));
  rec('aprovacoes', 'avisa que o número da caixa sai só na aprovação',
      /número da caixa sai na aprovação/.test(boxMeta));
  rec('aprovacoes', 'proposta sem meta não quebra a linha', nReq === 4 && nWeigh === 2);
  await shot('aprovacoes-meta');

  // ══ 7. CONFIG: taras padrão ═══════════════════════════════════
  await go('config-estoque');
  await page.waitForSelector('[data-section="taras"]', { timeout: 8000 }).catch(() => {});
  await sleep(400);
  noErr('config-estoque');
  const taraSec = await page.$('[data-section="taras"]');
  rec('config-estoque', 'seção de taras padrão existe', !!taraSec);
  const nTaras = await page.$$eval('[data-table="taras"] tbody tr', (e) => e.length).catch(() => 0);
  rec('config-estoque', 'lista as 3 taras da fixture', nTaras === 3, 'linhas=' + nTaras);
  const taraTxt = await page.$eval('[data-section="taras"]', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
  rec('config-estoque', 'mostra pra que serve cada tara (prateleira / caixa)',
      /bandeja azul/.test(taraTxt) && /caixa grande palete/.test(taraTxt)
      && /prateleira/.test(taraTxt) && /caixa/.test(taraTxt), taraTxt.slice(0, 120));
  posted.length = 0;
  await page.$eval('[data-section="taras"] input[placeholder="nome, ex: bandeja azul"]', (e) => { e.focus(); });
  await page.type('[data-section="taras"] input[placeholder="nome, ex: bandeja azul"]', 'bandeja verde');
  await page.type('[data-section="taras"] input[placeholder="tara g"]', '390');
  await sleep(200);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-section="taras"] button')].find((x) => x.textContent.trim() === 'Adicionar tara');
    if (b) b.click();
  });
  await sleep(600);
  const tarePost = posted.find((p) => p.pathname === '/api/v3/warehouse/weights/tare');
  rec('config-estoque', 'adicionar tara chama POST /warehouse/weights/tare',
      !!tarePost && tarePost.body.name === 'bandeja verde' && Number(tarePost.body.tare_g) === 390,
      JSON.stringify(tarePost && tarePost.body));
  await shot('config-taras');

  /* ══ 7b. IMPRESSÃO: painel "Fila do celular" (S15.29) ══════════
     A janela do admin pra fila: o que está esperando papel, quem pediu, há
     quanto tempo, quem pegou. Cancelar só vale enquanto ninguém pegou. */
  await go('impressao');
  await page.waitForSelector('[data-table="fila-celular"] tbody tr', { timeout: 8000 }).catch(() => {});
  await sleep(500);

  const qPanel = await page.$('[data-panel="fila-celular"]');
  rec('fila-impressao', 'painel "Fila do celular" existe na página Impressão', !!qPanel);
  const qRows = await page.$$eval('[data-table="fila-celular"] tbody tr', (rs) => rs.map((r) => ({
    job: r.dataset.job,
    txt: r.innerText.replace(/\s+/g, ' ').trim(),
    hasCancel: !!r.querySelector('[data-act="cancelar-job"]'),
  })));
  rec('fila-impressao', 'lista os 4 pedidos (o mandado agora + os 3 do stub)',
      qRows.length === 4, 'linhas=' + qRows.length);
  rec('fila-impressao', 'tipo em PT, quem pediu e idade em cada linha',
      qRows.some((r) => /Etiquetas de prateleira/.test(r.txt) && /Bruno/.test(r.txt) && /há 3 min/.test(r.txt)),
      JSON.stringify(qRows[1] && qRows[1].txt));
  rec('fila-impressao', 'chip de estado por linha (na fila · imprimindo · impresso)',
      qRows.some((r) => /na fila/.test(r.txt)) && qRows.some((r) => /imprimindo/.test(r.txt))
        && qRows.some((r) => /impresso/.test(r.txt)),
      qRows.map((r) => (r.txt.match(/na fila|imprimindo|impresso|deu erro|cancelado/) || [''])[0]).join('|'));
  rec('fila-impressao', 'quem pegou aparece na linha que está imprimindo',
      qRows.some((r) => /imprimindo/.test(r.txt) && /Simone/.test(r.txt)), '');
  rec('fila-impressao', 'pedido de teste sai marcado como teste',
      qRows.some((r) => /teste/.test(r.txt)), '');
  // Cancelar SÓ no que ainda está na fila: depois de pego o papel já pode estar saindo
  const cancelable = qRows.filter((r) => r.hasCancel);
  rec('fila-impressao', 'Cancelar só nos que ninguém pegou ainda',
      cancelable.length === 2 && cancelable.every((r) => /na fila/.test(r.txt)),
      'com botão=' + cancelable.length + '/' + qRows.length);
  await shot('impressao-fila-celular');

  posted.length = 0;
  await page.click('[data-table="fila-celular"] tr[data-job="21"] [data-act="cancelar-job"]');
  await sleep(900);
  rec('fila-impressao', 'Cancelar chama POST /print-queue/:id/cancel',
      posted.some((p) => p.pathname === '/api/v3/print-queue/21/cancel'),
      JSON.stringify(posted.map((p) => p.pathname)));
  const afterRows = await page.$$eval('[data-table="fila-celular"] tbody tr', (rs) => rs.map((r) => r.dataset.job));
  rec('fila-impressao', 'o pedido cancelado some da lista', afterRows.indexOf('21') < 0, afterRows.join(','));
  noErr('fila-impressao');

  // ══ 8. NAV: Etiquetas logo depois de Locais ═══════════════════
  await page.evaluate(() => {
    document.querySelectorAll('.nav-group').forEach((g) => {
      if (!g.classList.contains('open')) { const b = g.querySelector('.nav-section-btn'); if (b) b.click(); }
    });
  });
  await sleep(300);
  const estItems = await page.evaluate(() => {
    const g = [...document.querySelectorAll('.nav-group')].find((x) => {
      const l = x.querySelector('.nav-section-label');
      return l && l.textContent.trim() === 'Estoque';
    });
    return g ? [...g.querySelectorAll('.nav-item')].map((a) => a.getAttribute('href')) : [];
  });
  const iLoc = estItems.indexOf('#estoque-locais');
  rec('nav', 'Etiquetas entra logo depois de Locais',
      iLoc >= 0 && estItems[iLoc + 1] === '#estoque-etiquetas', estItems.join(','));

  await browser.close();
  server.close();

  const fails = results.filter((r) => !r.pass);
  console.log('\n' + '─'.repeat(60));
  console.log(results.length - fails.length + ' PASS  ·  ' + fails.length + ' FAIL');
  fs.writeFileSync(path.join(QA, 'qa-dashboard-phase3-report.json'),
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (fails.length) { fails.forEach((f) => console.log('  FAIL [' + f.group + '] ' + f.name + '  ' + f.detail)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
