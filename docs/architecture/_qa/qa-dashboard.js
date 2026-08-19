'use strict';
/**
 * QA harness do dashboard-v4 (S15 — hub de estoque).
 * Rodar da RAIZ do projeto:  node docs/architecture/_qa/qa-dashboard.js
 *
 * O que faz:
 *   1. sobe um servidor http estatico servindo `public/` (o build ja tem que
 *      existir: rode `node node_modules/vite/bin/vite.js build` em dashboard-v4);
 *   2. INTERCEPTA toda requisicao pra /api/** e responde das fixtures em
 *      docs/architecture/_qa/fixtures/ — NUNCA fala com servidor nem banco;
 *   3. injeta sessionStorage v3pin + v3login (functions ['*']) antes do bundle;
 *   4. abre cada rota, tira screenshot em docs/architecture/_qa/dash-*.png e
 *      roda as assercoes; imprime PASS/FAIL e sai com 1 se algo falhar.
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

// ── fixtures carregadas 1x ────────────────────────────────────────
const OVERVIEW = readFix('warehouse-overview.json');
const PRODUCT = readFix('warehouse-product.json');
const REQUESTS = readFix('warehouse-requests.json');
const LOCATIONS = readFix('warehouse-locations.json');

const LOGIN = { name: 'QA Admin', role: 'admin', functions: ['*'] };

/** Resposta pra qualquer /api/**. Devolve null se nao souber (vira {data:{}}). */
function apiFixture(pathname, search) {
  // ── /api/v3/warehouse/* (o hub) ────────────────────────────────
  if (pathname.startsWith('/api/v3/warehouse/')) {
    const p = pathname.slice('/api/v3/warehouse/'.length);
    if (p === 'overview') return OVERVIEW;
    if (p.startsWith('product/')) {
      // detalhe do produto CLICADO: reusa as listas ricas da fixture mas com a
      // Row real do overview, senao o painel mostraria outro produto.
      const id = Number(p.split('/')[1]);
      const row = OVERVIEW.data.products.find((x) => x.product_id === id);
      if (!row) return PRODUCT;
      return { data: { ...PRODUCT.data, product: row } };
    }
    if (p === 'requests') {
      const st = new URLSearchParams(search).get('status');
      const all = REQUESTS.data.requests;
      const list = st === 'pending' ? all.filter((r) => r.status === 'pending')
                 : st === 'decided' ? all.filter((r) => r.status !== 'pending')
                 : all;
      return { data: { requests: list } };
    }
    if (p === 'locations') return LOCATIONS;
    if (p.startsWith('family/')) return { data: PRODUCT.data.family };
    // qualquer POST de escrita devolve a linha fresca (contrato: {ok, product})
    return { data: { ok: true, product: PRODUCT.data.product } };
  }

  // ── /api/v3/data/* (paginas antigas — so pra nao pendurar) ─────
  if (pathname === '/api/v3/data/login') return { data: LOGIN };
  if (pathname === '/api/v3/data/health') return { data: { worker: { alive: true }, queue: 0, mode: 'qa' } };
  if (pathname === '/api/v3/data/picklist') {
    return { data: { total_orders: 2, total_bottles: 3, product_count: 1, names_loading: false, groups: [
      { key: 'g1', nickname: 'L-Carnitine 1500', mapped: true, order_count: 2, multi_count: 1,
        multi_summary: [{ orders: 1, bottles: 2 }],
        location: { shelf: 'S4', bin: 'B03', pallet: null, area: 'P&P' },
        orders: [
          { order_number: '12-345', patient: 'Wayne Ellis', channel: 'ebay', bottles: 1, multi: false },
          { order_number: '12-401', patient: 'Nina Park', channel: 'tiktok', bottles: 2, multi: true },
        ] },
    ] } };
  }
  // NOTA: estes endpoints legados devolvem ARRAY direto em `data` (nao objeto)
  // — StockOverviewPage/InventoryPage fazem `.reduce` em cima. Ver A2 §C.2/C.3.
  if (pathname === '/api/v3/data/stock-overview') {
    return { data: OVERVIEW.data.products.map((p) => ({
      product_id: p.product_id, name: p.name, nickname: p.nickname,
      bins_qty: p.shelf_qty, boxes_qty: p.box_qty, warehouse_total: p.total,
      total_qty: p.total,
      veeqo_stock: p.veeqo ? p.veeqo.physical : null, has_veeqo_sku: !!p.base_sku,
      skus: (p.skus || []).map((s) => s.sku),
    })) };
  }
  if (pathname === '/api/v3/data/stock/bins') return { data: LOCATIONS.data.bins };
  if (pathname === '/api/v3/data/stock/boxes') return { data: LOCATIONS.data.boxes };
  if (pathname === '/api/v3/data/stock/issues') return { data: PRODUCT.data.issues };
  if (pathname === '/api/v3/data/stock/skus') return { data: [] };
  if (pathname === '/api/v3/data/stock/planner') return { data: [] };
  if (pathname === '/api/v3/data/stock/summary') {
    return { data: OVERVIEW.data.products.map((p) => ({ product_id: p.product_id, name: p.name, total_qty: p.total })) };
  }
  if (pathname === '/api/v3/data/inventory') {
    return { data: { loading: false, stats: {}, matched: [], ours_unmatched: [], veeqo_unmatched: [], veeqo_plans: [] } };
  }
  if (pathname === '/api/v3/data/supplies') return { data: [] };
  if (pathname === '/api/v3/data/product-setup') {
    return { data: OVERVIEW.data.products.map((p) => ({
      id: p.product_id, name: p.name, nickname: p.nickname, bottle_color: p.bottle_color,
      active: true, on_hold: false, veeqo_stock: p.veeqo ? p.veeqo.physical : null,
      skus: (p.skus || []).map((s) => ({ id: s.id, sku: s.sku, channel: s.channel, units_per_pack: s.units_per_pack })),
    })) };
  }
  if (pathname === '/api/v3/data/product-setup/tiers') return { data: [] };
  if (pathname === '/api/v3/data/incidents') return { data: [] };
  if (pathname === '/api/v3/data/pending-totals') return { data: [] };
  if (pathname === '/api/v3/data/attendance') return { data: [] };
  if (pathname === '/api/v3/data/batches') return { data: [] };
  if (pathname === '/api/v3/data/search') return { data: [] };
  if (pathname === '/api/v3/data/support') return { data: {} };
  if (pathname === '/api/v3/data/production') return { data: {} };
  if (pathname === '/api/v3/data/pp') return { data: {} };
  if (pathname === '/api/v3/data/fnsku') return { data: {} };
  if (pathname === '/api/v3/data/goals') return { data: {} };
  if (pathname === '/api/v3/data/counts') return { data: {} };
  if (pathname === '/api/v3/data/review-rate') return { data: {} };
  if (pathname === '/api/v3/data/roadmap') {
    return { data: { columns: [
      { id: 'todo', title: 'A fazer', cards: [{ id: 1, title: 'Hub de estoque', summary: 'S15 fase 1', status: 'doing' }] },
      { id: 'doing', title: 'Fazendo', cards: [] },
      { id: 'done', title: 'Feito', cards: [] },
    ], cards: [{ id: 1, title: 'Hub de estoque', summary: 'S15 fase 1', status: 'doing', column: 'todo' }] } };
  }
  if (pathname === '/api/v3/data/inventory-settings') {
    return { data: { tiers: [], mix: [], supplies: [], size_supply: [], questions: [], bins: [{ n: 8 }], thresholds: [{ n: 0 }] } };
  }
  if (pathname.startsWith('/api/v3/data/catalog/')) {
    const k = pathname.split('/').pop();
    return { data: { [k === 'persons' ? 'persons' : k === 'activity-types' ? 'activity_types' : 'products']: [] } };
  }
  if (pathname === '/api/v3/data/timeline') return { data: { events: [], operators: [], gaps: [] } };
  if (pathname === '/api/v3/data/deadlines') return { data: { deadlines: [] } };
  if (pathname === '/api/v3/data/veeqo-today') return { data: { total_orders: 0, total_units: 0, by_channel: [], by_product: [] } };
  if (pathname === '/api/v3/data/rbac') return { data: { functions: [], roles: [] } };

  // default seguro pro resto do /api/v3/data/*
  return { data: {} };
}

// ── servidor estatico de public/ ─────────────────────────────────
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

  // Erros externos ao app (fontes do Google, CDNs) sao bloqueados DE PROPOSITO
  // pelo harness — o browser loga "Failed to load resource" pra eles. Filtra.
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
    if (!r.url().startsWith('http://127.0.0.1:' + port)) return;   // externo: bloqueio proposital
    const err = (r.failure() && r.failure().errorText) || '';
    consoleErrors.push('requestfailed: ' + r.url() + ' (' + err + ')');
  });

  // INTERCEPTA /api/** com fixtures; BLOQUEIA qualquer host externo.
  const ORIGIN = 'http://127.0.0.1:' + port;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) { req.continue(); return; }
    if (url.startsWith(ORIGIN)) {
      const u = new URL(url);
      if (u.pathname.startsWith('/api/')) {
        req.respond({
          status: 200, contentType: 'application/json',
          body: JSON.stringify(apiFixture(u.pathname, u.search)),
        });
        return;
      }
      req.continue(); return;             // arquivo estatico do build
    }
    req.abort();                           // nada de rede externa (fontes, CDNs)
  });

  // sessao autenticada (mesmas chaves do PinGate / from-api.js)
  await page.evaluateOnNewDocument((login) => {
    try {
      sessionStorage.setItem('v3pin', '0000');
      sessionStorage.setItem('v3login', JSON.stringify(login));
      sessionStorage.setItem('hf-tweaks', JSON.stringify({ theme: 'light' }));
    } catch (e) { /* ignore */ }
  }, LOGIN);

  const shot = async (name) => {
    const f = path.join(QA, 'dash-' + name + '.png');
    await page.screenshot({ path: f });
    const kb = Math.round(fs.statSync(f).size / 1024);
    rec('screenshot', name, kb < 1024, kb + ' KB → ' + path.basename(f));
  };

  /* Navega pra uma rota. Uma unica carga por rota (about:blank primeiro, senao
     mudar so o hash nao remonta o app e a carga anterior fica em voo, gerando
     ERR_ABORTED falso). O buffer de erros so e zerado DEPOIS que a pagina
     assentou, entao o que sobrar e erro de regime, nao de navegacao. */
  async function go(hash) {
    await page.goto('about:blank');
    await page.goto(BASE + '#' + hash, { waitUntil: 'networkidle0' });
    await sleep(600);
    consoleErrors.length = 0;
    await sleep(600);      // janela de observacao em regime
  }

  // ══ 1. HUB #estoque ═══════════════════════════════════════════
  await go('estoque');
  await page.waitForSelector('[data-table="produtos"] tbody tr', { timeout: 10000 }).catch(() => {});
  await shot('estoque');
  rec('estoque', 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  const nRows = await page.$$eval('[data-table="produtos"] tbody tr[data-row]', (e) => e.length);
  rec('estoque', 'tabela com 8 produtos', nRows === 8, 'linhas=' + nRows);

  const kpiVals = await page.$$eval('[data-kpi]', (els) => els.map((e) => ({
    k: e.dataset.kpi, v: e.querySelector('.kit-kpi').textContent.replace(/\D/g, ''),
  })));
  const K = OVERVIEW.data.kpis;
  const want = { todos: K.total_bottles, reservadas: K.reserved, dispon: K.available, separadas: K.separated,
                 organizar: K.unplaced, repor: K.bins_to_restock, pendente: K.pending_requests, drift: K.drift_products };
  const bad = kpiVals.filter((x) => String(want[x.k]) !== x.v);
  rec('estoque', 'KPIs batem com a fixture', bad.length === 0 && kpiVals.length === 8,
      bad.length ? JSON.stringify(bad) : (kpiVals.length + ' KPIs'));

  const hasAttention = await page.$('[data-attention]');
  rec('estoque', 'card "Precisa de atenção hoje" presente', !!hasAttention);

  const veeqoOk = await page.$$eval('[data-table="produtos"] tbody tr', (rows) =>
    rows.some((r) => /Δ/.test(r.textContent)) && rows.some((r) => /✓/.test(r.textContent)));
  rec('estoque', 'coluna Veeqo mostra ✓ e Δ', veeqoOk);

  // painel lateral ao clicar na linha (produto 6 = familia L-Carnitine C1..C4)
  await page.click('[data-table="produtos"] tbody tr[data-row="6"]');
  await page.waitForSelector('[data-panel="produto"]', { timeout: 5000 }).catch(() => {});
  const panelOpen = await page.$('[data-panel="produto"]');
  rec('estoque', 'painel do produto abre no clique da linha', !!panelOpen);
  const panelName = await page.$eval('[data-panel="produto"] .head', (e) => e.textContent).catch(() => '');
  rec('estoque', 'painel mostra o produto clicado', /L-Carnitine 1500/.test(panelName), panelName.slice(0, 40));
  const tabsN = await page.$$eval('[data-panel="produto"] .tabs button', (e) => e.length).catch(() => 0);
  rec('estoque', 'painel tem as 7 abas', tabsN === 7, 'abas=' + tabsN);
  await shot('estoque-painel');

  // aba Familia: base + membros kit com unidades por pack
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-panel="produto"] .tabs button')].find((x) => x.textContent.trim() === 'Família');
    if (b) b.click();
  });
  await sleep(400);
  const famTxt = await page.$eval('[data-panel="produto"] .body', (e) => e.textContent).catch(() => '');
  rec('estoque', 'aba Família lista base + membros kit',
      /HF-LCAR-1500/.test(famTxt) && /-C2/.test(famTxt) && /-C4/.test(famTxt) && /kit/.test(famTxt));
  await shot('estoque-familia');
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => { const b = document.querySelector('.kit-drawer-back'); if (b) b.click(); });
  await sleep(300);

  // modal de ação 2 passos (menu ⋯ do produto 6)
  await page.click('[data-menu="6"]');
  await sleep(200);
  const menuBtns = await page.$$('.kit-card button');
  let opened = false;
  for (const b of menuBtns) {
    const t = await page.evaluate((e) => e.textContent.trim(), b);
    if (t === 'Entrada') { await b.click(); opened = true; break; }
  }
  await sleep(400);
  const modalTxt = await page.$eval('.kit-modal', (e) => e.textContent).catch(() => '');
  rec('estoque', 'modal de ação abre com Revisar', opened && /Revisar/.test(modalTxt), modalTxt.slice(0, 60));
  // passo 2 → Confirmar
  await page.evaluate(() => { const b = document.querySelector('[data-act="revisar"]'); if (b) b.click(); });
  await sleep(250);
  const step2 = await page.$eval('.kit-modal', (e) => e.textContent).catch(() => '');
  rec('estoque', 'passo 2 mostra Confirmar', /Confirmar/.test(step2) && /Passo 2 de 2/.test(step2));
  await shot('estoque-modal');
  await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.kit-modal .foot button')];
    const c = bs.find((b) => b.textContent.trim() === 'Cancelar'); if (c) c.click();
  });
  await sleep(200);

  // ══ 2. NAV ════════════════════════════════════════════════════
  // secoes sao colapsaveis: abre TODAS antes de ler a ordem dos itens
  await page.evaluate(() => {
    document.querySelectorAll('.nav-group').forEach((g) => {
      if (!g.classList.contains('open')) { const b = g.querySelector('.nav-section-btn'); if (b) b.click(); }
    });
  });
  await sleep(300);
  const nav = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.nav-group').forEach((g) => {
      const sec = g.querySelector('.nav-section-label');
      const items = [...g.querySelectorAll('.nav-item')].map((a) => a.getAttribute('href'));
      const subs = [...g.querySelectorAll('.nav-subgroup')].map((s) => s.textContent.trim());
      out.push({ section: sec ? sec.textContent.trim() : '?', items, subs });
    });
    return out;
  });
  const est = nav.find((s) => s.section === 'Estoque');
  rec('nav', 'seção Estoque existe', !!est, est ? est.items.join(',') : JSON.stringify(nav.map((s) => s.section)));
  rec('nav', 'Estoque tem o hub #estoque, aprovações e locais',
      !!est && ['#estoque', '#estoque-aprovacoes', '#estoque-locais'].every((h) => est.items.includes(h)));
  rec('nav', 'subgrupo P&P dentro de Estoque', !!est && est.subs.includes('P&P'), est ? est.subs.join(',') : '');
  rec('nav', 'P&P e Picklist estão em Estoque, não em Operação',
      !!est && est.items.includes('#pp') && est.items.includes('#picklist'));
  const op = nav.find((s) => s.section === 'Operação');
  const iM = op ? op.items.indexOf('#metas') : -1;
  rec('nav', 'Planejamento e Produto logo depois de Metas',
      !!op && op.items[iM + 1] === '#planejamento' && op.items[iM + 2] === '#produto',
      op ? op.items.join(',') : '');
  rec('nav', 'Operação já não tem pp/picklist', !!op && !op.items.includes('#pp') && !op.items.includes('#picklist'));

  // ══ 3. demais rotas ═══════════════════════════════════════════
  const ROUTES = [
    ['estoque-aprovacoes', '[data-table="requests"] tbody tr'],
    ['estoque-locais', '[data-table="bins"] tbody tr'],
    ['picklist', '.pl-root'],
    ['hoje', '.app'],
    ['inventory', '.app'],
    ['produto-setup', '.app'],
    ['roadmap', '.app'],
  ];
  for (const [r, sel] of ROUTES) {
    await go(r);
    await page.waitForSelector(sel, { timeout: 8000 }).catch(() => {});
    await shot(r);
    rec(r, 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
    const found = await page.$(sel);
    rec(r, 'renderizou (' + sel + ')', !!found);
  }

  // aprovações: 3 pendentes na fixture
  await go('estoque-aprovacoes');
  await page.waitForSelector('[data-table="requests"] tbody tr', { timeout: 8000 }).catch(() => {});
  const nReq = await page.$$eval('[data-table="requests"] tbody tr', (e) => e.length);
  rec('estoque-aprovacoes', 'lista 3 propostas pendentes', nReq === 3, 'linhas=' + nReq);

  // locais: 8 bins + 4 caixas
  await go('estoque-locais');
  await page.waitForSelector('[data-table="bins"] tbody tr', { timeout: 8000 }).catch(() => {});
  const nBins = await page.$$eval('[data-table="bins"] tbody tr', (e) => e.length);
  const nBoxes = await page.$$eval('[data-table="boxes"] tbody tr', (e) => e.length);
  rec('estoque-locais', 'tabelas de prateleiras (8) e caixas (4)', nBins === 8 && nBoxes === 4, nBins + ' bins / ' + nBoxes + ' caixas');

  await browser.close();
  server.close();

  const fails = results.filter((r) => !r.pass);
  console.log('\n' + '─'.repeat(60));
  console.log(results.length - fails.length + ' PASS  ·  ' + fails.length + ' FAIL');
  fs.writeFileSync(path.join(QA, 'qa-dashboard-report.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (fails.length) { fails.forEach((f) => console.log('  FAIL [' + f.group + '] ' + f.name + '  ' + f.detail)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
