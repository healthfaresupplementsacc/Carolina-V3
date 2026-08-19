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
const SUGGESTIONS = readFix('warehouse-sku-suggestions.json');

/* Query string que a pagina mandou no ultimo GET /overview. A ordenacao e os
   filtros agora sao do SERVIDOR (contrato P2): sem guardar isto, o harness so
   conseguiria provar que a TELA reordenou, nao que ela PEDIU a ordem. */
const overviewCalls = [];

/* ── overview FILTRADO/ORDENADO no servidor (stub do contrato P2) ──
   Faz de verdade o que o backend fara: aplica q, status (E, nao OU),
   only_with_qty, sort/dir e a janela limit/offset, e devolve `total` = quantos
   passaram no filtro (o M do "N de M"). Os produtos aposentados nunca entram. */
const SORT_GET = {
  name: (r) => String(r.nickname || r.name || '').toLowerCase(),
  total: (r) => Number(r.total || 0),
  shelf: (r) => Number(r.shelf_qty || 0),
  box: (r) => Number(r.box_qty || 0),
  unplaced: (r) => Number(r.unplaced_qty || 0),
  reserved: (r) => Number(r.reserved || 0),
  pending: (r) => Number(r.pending_in || 0) - Number(r.pending_out || 0),
  available: (r) => Number(r.available || 0),
  separated: (r) => Number(r.separated || 0),
  days: (r) => (r.days_of_stock == null ? null : Number(r.days_of_stock)),
  veeqo: (r) => (r.veeqo && r.veeqo.physical != null ? Number(r.veeqo.physical) : null),
};

function overviewFiltered(search) {
  const sp = new URLSearchParams(search || '');
  overviewCalls.push({
    q: sp.get('q') || '', sort: sp.get('sort') || '', dir: sp.get('dir') || '',
    status: sp.get('status') || '', only_with_qty: sp.get('only_with_qty') || '',
    limit: sp.get('limit') || '', offset: sp.get('offset') || '',
  });

  let list = OVERVIEW.data.products.slice();
  const q = (sp.get('q') || '').trim().toLowerCase();
  if (q) {
    list = list.filter((r) => [r.nickname, r.name, r.base_sku, r.barcode]
      .concat((r.children || []).map((c) => c.sku))
      .filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  const st = (sp.get('status') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (st.length) list = list.filter((r) => st.every((s) => (r.status || []).includes(s)));
  if (sp.get('only_with_qty') === '1') list = list.filter((r) => Number(r.total || 0) > 0);

  const get = SORT_GET[sp.get('sort')] || SORT_GET.available;
  const mul = sp.get('dir') === 'desc' ? -1 : 1;
  list.sort((a, b) => {
    const va = get(a); const vb = get(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;                      // vazio sempre no fim
    if (vb == null) return -1;
    if (va === vb) return 0;
    return (typeof va === 'string' ? (va < vb ? -1 : 1) : va - vb) * mul;
  });

  const total = list.length;
  const off = Number(sp.get('offset') || 0) || 0;
  const lim = Number(sp.get('limit') || 0) || total;
  return { data: { ...OVERVIEW.data, products: list.slice(off, off + lim), total } };
}

const LOGIN = { name: 'QA Admin', role: 'admin', functions: ['*'] };

/** POSTs que a pagina fez. Guardado pra conferir que a UI chamou o endpoint certo. */
const posted = [];

/* ── PREFERENCIAS POR CONTA — /api/v3/prefs/* ─────────────────────
   A VISTA SALVA do hub (busca + chips + ordem) mora aqui, chave 'estoque.view'.
   Guardar de verdade importa: o teste precisa provar que salvar manda PUT com o
   valor certo, e nao so que o botao existe. */
const PREFS = { account: { id: 1, name: 'QA Admin', role: 'admin' }, values: {}, updated_at: {} };
const prefPuts = [];

function prefsFixture(pathname, method, body) {
  const m = /^\/api\/v3\/prefs\/(.+)$/.exec(pathname);
  const key = m ? decodeURIComponent(m[1]) : null;
  if (method === 'GET' && !key) return { data: { prefs: PREFS.values, account: PREFS.account } };
  if (method === 'GET') {
    return { data: { key, value: PREFS.values[key] != null ? PREFS.values[key] : null,
                     updated_at: PREFS.updated_at[key] || null, account: PREFS.account } };
  }
  if (method === 'PUT') {
    prefPuts.push({ key, value: body && body.value });
    PREFS.values[key] = body && body.value;
    PREFS.updated_at[key] = new Date().toISOString();
    return { data: { key, updated_at: PREFS.updated_at[key], account: PREFS.account } };
  }
  if (method === 'DELETE') { delete PREFS.values[key]; return { data: { key, deleted: true } }; }
  return { data: {} };
}

/** Resposta pra qualquer /api/**. Devolve null se nao souber (vira {data:{}}). */
function apiFixture(pathname, search, method, body) {
  if (pathname.startsWith('/api/v3/prefs')) return prefsFixture(pathname, method, body);
  if (method === 'POST') posted.push({ pathname, body });
  // ── /api/v3/warehouse/* (o hub) ────────────────────────────────
  if (pathname.startsWith('/api/v3/warehouse/')) {
    const p = pathname.slice('/api/v3/warehouse/'.length);
    if (p === 'overview') return overviewFiltered(search);
    if (p === 'sku-suggestions') return SUGGESTIONS;
    /* merge-bulk / unmerge: o backend devolve quantos viraram filho. A linha
       some da tabela na hora e o proximo /overview ja vem sem ela. */
    if (p === 'family/merge-bulk') {
      const gs = (body && Array.isArray(body.groups)) ? body.groups : [];
      const gone = gs.reduce((a, g) => a.concat(g.from_product_ids || []), []);
      return { data: { ok: true, merged: gone.length, product_ids: gone } };
    }
    if (p === 'family/unmerge') return { data: { ok: true, product_id: body && body.product_id } };
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
    /* contrato (4): criar varias prateleiras. Responde como o backend: cria as
       que faltam e PULA as que ja existem (nunca sobrescreve). Aqui o stub
       finge que 2 codigos ja existiam, pra tela ter que mostrar os dois
       numeros e nao so o total. */
    if (p === 'locations/bins/bulk') {
      const list = (body && Array.isArray(body.bins)) ? body.bins : [];
      const skipped = list.slice(0, 2).map((b) => b.bin_code);
      return { data: { created: Math.max(0, list.length - skipped.length), skipped } };
    }
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
      canonical_name: p.name,
      /* familia: na fixture o produto 3 e casepack do 5, o mesmo par que o
         teste ad-hoc do hub junta. Duas telas, a MESMA verdade. */
      parent_product_id: p.product_id === 3 ? 5 : null,
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
        let payload = null;
        try { payload = req.postData() ? JSON.parse(req.postData()) : null; } catch (e) { payload = req.postData(); }
        req.respond({
          status: 200, contentType: 'application/json',
          body: JSON.stringify(apiFixture(u.pathname, u.search, req.method(), payload)),
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
      /* A vista do hub tem cache em localStorage (useAccountPref). Sem limpar,
         um teste deixaria filtro ligado pro proximo e a falha apareceria na
         assercao errada. O teste da vista salva usa a CONTA (o stub de prefs),
         que e o caminho de verdade. */
      localStorage.removeItem('hf-estoque-view');
      localStorage.removeItem('hf-estoque-view.dirty');
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

  /* ── coluna "Dias de estoque" (contrato 3) ─────────────────────
     A coluna entra DEPOIS de Disponivel: quem le a tabela ve quanto tem e,
     em seguida, quanto tempo aquilo dura. */
  const heads = await page.$$eval('[data-table="produtos"] thead th', (e) => e.map((x) => x.textContent.trim()));
  const iAvail = heads.findIndex((h) => /^Disponível/.test(h));
  const iDays = heads.findIndex((h) => /^Dias de estoque/.test(h));
  rec('estoque', 'coluna "Dias de estoque" logo depois de Disponível',
      iAvail >= 0 && iDays === iAvail + 1, heads.join('|'));

  /* Os 4 casos da fixture: ok (71.3), warn (9.3 NAC), bad (0 Magnesium) e o
     traco de quem nao vendeu nada em 7 dias (Chlorophyll / Ashwagandha). */
  const daysCells = await page.$$eval('[data-table="produtos"] tbody tr[data-row]', (rows) =>
    rows.map((r) => ({
      id: r.dataset.row,
      txt: (r.querySelector('[data-cell="days"]') || {}).textContent || '',
      color: (() => {
        const s = r.querySelector('[data-cell="days"] span');
        return s ? getComputedStyle(s).color : '';
      })(),
    })));
  const byId = (id) => daysCells.find((c) => c.id === String(id)) || {};
  rec('estoque', 'dias de estoque vem da fixture (Benfotiamine 71)',
      /71/.test(byId(1).txt), JSON.stringify(byId(1).txt));
  rec('estoque', 'sem venda em 7 dias mostra travessinho, nao zero',
      byId(3).txt.trim() === '—' && byId(8).txt.trim() === '—',
      JSON.stringify([byId(3).txt, byId(8).txt]));
  // tom: bad e warn tem cor propria; ok herda a cor normal da celula
  const lum = (rgb) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || ''); return m ? [+m[1], +m[2], +m[3]] : null; };
  const badRgb = lum(byId(7).color);   // Magnesium, 0 dias
  const okRgb = lum(byId(1).color);    // Benfotiamine, 71 dias
  rec('estoque', 'abaixo de 7 dias pinta vermelho (Magnesium 0)',
      !!badRgb && badRgb[0] > badRgb[1] + 40 && badRgb[0] > badRgb[2] + 40, byId(7).color);
  rec('estoque', 'entre 7 e 14 dias pinta ambar (NAC 9.3)',
      /9[,.]3/.test(byId(5).txt) && byId(5).color !== byId(1).color,
      byId(5).txt + ' ' + byId(5).color);
  rec('estoque', 'acima de 14 dias fica sem cor de alerta',
      !!okRgb && !(okRgb[0] > okRgb[1] + 40), byId(1).color);

  /* ══ UMA LINHA POR PRODUTO + CHIP DE SKU (a regra do Bruno) ══════
     Casepack e a MESMA garrafa. L-Carnitine tem base + C2/C3/C4 na fixture:
     se a tabela mostrar 4 linhas pra isso, o estoque conta a mesma garrafa 4
     vezes. Entao: 1 linha, e o chip diz "+3". */
  const chip6 = await page.$eval('[data-row="6"] [data-sku-chip]',
    (e) => ({ txt: e.textContent.replace(/\s+/g, ' ').trim(), count: e.dataset.skuCount })).catch(() => null);
  rec('sku-chip', 'chip mostra SKU base + quantos filhos ("HF-LCAR-1500 +3")',
      !!chip6 && /HF-LCAR-1500/.test(chip6.txt) && /\+3/.test(chip6.txt) && chip6.count === '3',
      JSON.stringify(chip6));
  const rowsForLcar = await page.$$eval('[data-table="produtos"] tbody tr[data-row]',
    (rows) => rows.filter((r) => /HF-LCAR-1500/.test(r.textContent)).length);
  rec('sku-chip', 'UMA linha pra L-Carnitine, nao uma por casepack', rowsForLcar === 1, 'linhas=' + rowsForLcar);
  const chip2 = await page.$eval('[data-row="2"] [data-sku-chip]',
    (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  rec('sku-chip', 'produto de SKU unico nao ganha "+0"', /^HF-BERB-500$/.test(chip2), chip2);
  const chip7 = await page.$eval('[data-row="7"] [data-sku-chip]', (e) => e.dataset.skuChip).catch(() => '');
  rec('sku-chip', 'produto sem SKU diz "sem SKU" em vez de celula vazia', chip7 === 'none', chip7);

  // abrir o chip lista os filhos com SKU, kit e o numero da Veeqo
  await page.click('[data-row="6"] [data-sku-chip]');
  await sleep(250);
  const kids = await page.$$eval('[data-sku-kids="6"] [data-sku-kid]',
    (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  rec('sku-chip', 'abrir o chip lista os 3 filhos', kids.length === 3, kids.join(' | '));
  rec('sku-chip', 'cada filho mostra SKU, x3 kit e a qtd da Veeqo',
      kids.some((k) => /-C3/.test(k) && /×3 kit/.test(k) && /Veeqo/.test(k)), kids.join(' | '));
  rec('sku-chip', 'cada filho tem "desagrupar"',
      (await page.$$('[data-sku-kids="6"] [data-unmerge]')).length === 3);
  // abrir o SKU NAO pode abrir o painel lateral junto
  rec('sku-chip', 'abrir o SKU nao abre o painel do produto', !(await page.$('[data-panel="produto"]')));

  // desagrupar chama o endpoint certo
  posted.length = 0;
  await page.click('[data-sku-kids="6"] [data-unmerge]');
  await sleep(600);
  rec('sku-chip', 'desagrupar chama POST /warehouse/family/unmerge',
      posted.some((p) => p.pathname === '/api/v3/warehouse/family/unmerge'),
      JSON.stringify(posted.map((p) => p.pathname)));
  await page.click('[data-row="6"] [data-sku-chip]').catch(() => {});
  await sleep(200);

  /* ══ EDICAO NA CELULA: um clique, digita, pronto ═════════════════
     A celula tem que POSTAR o DELTA no endpoint que ja existe (adjust, que
     passa pelo StockService). Escrever quantidade direto no banco seria o
     unico jeito de errar feio aqui, entao o teste olha o corpo. */
  const editable = await page.$$eval('[data-row="1"] [data-inline-cell]',
    (e) => e.map((x) => x.dataset.inlineField));
  rec('inline', 'Prateleira, Caixa e A organizar sao editaveis na linha',
      ['shelf', 'box', 'unplaced'].every((f) => editable.includes(f)), editable.join(','));

  posted.length = 0;
  await page.click('[data-row="1"] [data-inline-field="shelf"]');
  await sleep(250);
  const inputOpen = await page.$('[data-inline-input="1:shelf"]');
  rec('inline', 'clicar na celula abre um input', !!inputOpen);
  /* "valor atual JA selecionado" so se prova DIGITANDO: input[type=number] nao
     expoe selectionStart no Chrome (fica null), entao ler a propriedade
     testaria o navegador, nao a tela. Se a selecao estiver certa, digitar 5
     SUBSTITUI o 46; se estiver errada, vira "465" ou "546". */
  const before = await page.$eval('[data-inline-input="1:shelf"]', (e) => e.value);
  await page.keyboard.type('5');
  const afterType = await page.$eval('[data-inline-input="1:shelf"]', (e) => e.value);
  rec('inline', 'o input abre com o valor atual JA selecionado (digitar substitui)',
      before === '46' && afterType === '5', before + ' + tecla 5 = ' + afterType);
  const reasonField = await page.$('[data-row="1"] [data-inline-reason]');
  rec('inline', 'o motivo e um campo na propria celula, nao um modal', !!reasonField);

  // digita 50 (era 46) + motivo, Enter salva
  await page.evaluate(() => {
    const i = document.querySelector('[data-inline-input="1:shelf"]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(i, '50'); i.dispatchEvent(new Event('input', { bubbles: true }));
    const r = document.querySelector('[data-row="1"] [data-inline-reason]');
    set.call(r, 'contagem do dia'); r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.focus('[data-inline-input="1:shelf"]');
  await page.keyboard.press('Enter');
  await sleep(700);
  const adj = posted.find((p) => /\/warehouse\/product\/1\/adjust$/.test(p.pathname));
  rec('inline', 'Enter chama POST /warehouse/product/1/adjust (nunca escreve qtd direto)',
      !!adj, JSON.stringify(posted.map((p) => p.pathname)));
  rec('inline', 'manda o DELTA (+4), o motivo e o bin, nao o total novo',
      !!adj && adj.body.qty === 4 && adj.body.reason === 'contagem do dia' && adj.body.bin_id === 1,
      JSON.stringify(adj && adj.body));
  const tick = await page.$('[data-row="1"] [data-inline-saved]');
  rec('inline', 'um tique discreto confirma que salvou', !!tick);

  // Esc cancela sem postar nada
  posted.length = 0;
  await page.click('[data-row="2"] [data-inline-field="box"]');
  await sleep(200);
  await page.keyboard.press('Escape');
  await sleep(300);
  rec('inline', 'Esc fecha sem salvar nada',
      !posted.length && !(await page.$('[data-inline-input="2:box"]')),
      JSON.stringify(posted.map((p) => p.pathname)));

  await shot('estoque-inline');

  /* ══ FILTRO E ORDEM PEDIDOS AO SERVIDOR ══════════════════════════
     Com ~190 produtos, filtrar/ordenar so a pagina baixada mostraria "o maior
     desta tela". O teste prova que a TELA PEDE, nao so que ela reordena. */
  const chipsN = await page.$$eval('[data-filter-chips] [data-chip]', (e) => e.map((x) => x.dataset.chip));
  rec('filtro', 'os 5 chips rapidos + "so com quantidade" existem',
      ['pend', 'zerado', 'sem_local', 'drift', 'sem_sku', 'only_qty'].every((k) => chipsN.includes(k)),
      chipsN.join(','));

  overviewCalls.length = 0;
  await page.click('[data-chip="drift"]');
  await sleep(700);
  const driftCall = overviewCalls[overviewCalls.length - 1] || {};
  rec('filtro', 'chip "Veeqo diferente" vira status=drift na query',
      driftCall.status === 'drift', JSON.stringify(driftCall));
  const driftRows = await page.$$eval('[data-table="produtos"] tbody tr[data-row]', (e) => e.map((r) => r.dataset.row));
  rec('filtro', 'a tabela fica so com os 2 produtos com Veeqo diferente',
      driftRows.sort().join(',') === '1,8', driftRows.join(','));
  const countNote = await page.$eval('[data-count-note]', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  rec('filtro', 'o rodape diz "N de M produtos"', /^2 de 2 produtos$/.test(countNote), countNote);
  await shot('estoque-filtro');

  await page.click('[data-filter-clear]');
  await sleep(700);
  rec('filtro', 'limpar devolve os 8 produtos',
      (await page.$$('[data-table="produtos"] tbody tr[data-row]')).length === 8);

  // busca com debounce: uma chamada, nao uma por tecla
  overviewCalls.length = 0;
  await page.click('[data-filter-q]');
  await page.type('[data-filter-q]', 'carn', { delay: 40 });
  await sleep(900);
  const qCalls = overviewCalls.filter((c) => c.q);
  rec('filtro', 'a busca espera parar de digitar (1 chamada, nao 4)',
      qCalls.length === 1 && qCalls[0].q === 'carn', JSON.stringify(qCalls));
  rec('filtro', 'buscar "carn" deixa so L-Carnitine',
      (await page.$$('[data-table="produtos"] tbody tr[data-row]')).length === 1);
  // buscar pelo SKU FILHO tem que achar o pai: o C3 nao tem linha propria
  await page.evaluate(() => {
    const i = document.querySelector('[data-filter-q]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(i, 'LCAR-1500-C3'); i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(900);
  const kidSearch = await page.$$eval('[data-table="produtos"] tbody tr[data-row]', (e) => e.map((r) => r.dataset.row));
  rec('filtro', 'buscar o SKU de um casepack acha o PAI (o filho nao tem linha)',
      kidSearch.join(',') === '6', kidSearch.join(','));
  await page.click('[data-filter-clear]');
  await sleep(700);

  // ordem: clicar em Total manda sort=total&dir=desc (maior primeiro)
  overviewCalls.length = 0;
  await page.click('[data-sort="total"]');
  await sleep(700);
  const totCall = overviewCalls[overviewCalls.length - 1] || {};
  rec('ordem', 'clicar em Total pede sort=total&dir=desc ao servidor',
      totCall.sort === 'total' && totCall.dir === 'desc', JSON.stringify(totCall));
  const totOrder = await page.$$eval('[data-table="produtos"] tbody tr[data-row]', (e) => e.map((r) => r.dataset.row));
  rec('ordem', 'maior primeiro: L-Carnitine (300) na frente', totOrder[0] === '6', totOrder.join(','));
  await page.click('[data-sort="total"]');
  await sleep(700);
  const totCall2 = overviewCalls[overviewCalls.length - 1] || {};
  rec('ordem', '2o clique inverte pra asc no servidor tambem', totCall2.dir === 'asc', JSON.stringify(totCall2));
  // toda coluna numerica ordena, nao so duas
  const sortables = await page.$$eval('[data-table="produtos"] thead th[data-sort]', (e) => e.map((x) => x.dataset.sort));
  rec('ordem', 'todas as colunas numericas ordenam',
      ['total', 'shelf', 'box', 'unplaced', 'reserved', 'pending', 'available', 'days', 'separated', 'veeqo']
        .every((c) => sortables.includes(c)), sortables.join(','));

  /* ══ VISTA SALVA NA CONTA ════════════════════════════════════════ */
  await page.click('[data-chip="zerado"]');
  await sleep(600);
  const saveBtn = await page.$('[data-act="salvar-vista"]');
  rec('vista', 'mexer no filtro acende o botao de salvar a vista', !!saveBtn);
  prefPuts.length = 0;
  await page.click('[data-act="salvar-vista"]');
  await sleep(900);
  const put = prefPuts.find((p) => p.key === 'estoque.view');
  rec('vista', 'salvar manda PUT /api/v3/prefs/estoque.view', !!put, JSON.stringify(prefPuts.map((p) => p.key)));
  rec('vista', 'a vista salva leva chips e ordem juntos',
      !!put && put.value && put.value.chips && put.value.chips.zerado === true
      && put.value.sort && put.value.sort.col === 'total',
      JSON.stringify(put && put.value));
  const viewStatus = await page.$eval('[data-view-status]', (e) => e.textContent.trim());
  rec('vista', 'a tela diz que a vista e da CONTA, nao do navegador',
      /vista salva na sua conta/.test(viewStatus), viewStatus);

  // reabrir a pagina: a conta manda, e a tela volta filtrada
  await go('estoque');
  await page.waitForSelector('[data-table="produtos"] tbody tr', { timeout: 10000 }).catch(() => {});
  await sleep(600);
  const backChip = await page.$eval('[data-chip="zerado"]', (e) => e.getAttribute('aria-pressed')).catch(() => '');
  rec('vista', 'reabrir a pagina volta com a vista salva ligada', backChip === 'true', 'aria-pressed=' + backChip);
  await page.click('[data-act="resetar-vista"]');
  await sleep(800);
  rec('vista', 'Vista padrao devolve os 8 produtos',
      (await page.$$('[data-table="produtos"] tbody tr[data-row]')).length === 8);

  /* ══ JUNTAR SKUs ═════════════════════════════════════════════════
     O painel PROPOE, a pessoa confirma. Nada e aplicado sozinho, e o passo 2
     diz com todas as letras quem vira filho de quem e o que some. */
  await page.click('[data-act="juntar-skus"]');
  await page.waitForSelector('[data-panel="juntar-skus"]', { timeout: 5000 }).catch(() => {});
  rec('juntar', 'o painel "Juntar SKUs" abre', !!(await page.$('[data-panel="juntar-skus"]')));
  const nGroups = await page.$$eval('[data-merge-group]', (e) => e.length);
  rec('juntar', 'mostra os 2 grupos propostos pelo backend', nGroups === 2, 'grupos=' + nGroups);
  const g0 = await page.$eval('[data-merge-group="0"]', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
  rec('juntar', 'o grupo traz o pai proposto e os membros com SKU e Veeqo',
      /HF-BENF-300/.test(g0) && /-C3/.test(g0) && /-C4/.test(g0) && /confiança alta/.test(g0), g0.slice(0, 130));
  rec('juntar', 'membro com estoque avisa que o estoque vai pro pai',
      /tem estoque, vai pro pai/.test(g0));
  await shot('estoque-juntar');

  // passo 2: a frase inteira, com nome, SKU e o que some
  await page.click('[data-act="merge-todos"]');
  await sleep(400);
  const confirmTxt = await page.$eval('[data-merge-confirm]', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
  rec('juntar', '"juntar todos os obvios" abre um passo 2 antes de aplicar',
      /Passo 2 de 2/.test(confirmTxt), confirmTxt.slice(0, 80));
  rec('juntar', 'o passo 2 diz quem vira pai de quem, pra onde vai o estoque e o que some',
      /HF-BENF-300 vira o pai de HF-BENF-300-C3 e HF-BENF-300-C4/.test(confirmTxt)
      && /o estoque de HF-BENF-300-C4 vai pro pai/.test(confirmTxt)
      && /as linhas antigas somem do estoque/.test(confirmTxt), confirmTxt.slice(0, 260));
  await shot('estoque-juntar-confirmar');

  posted.length = 0;
  await page.click('[data-act="merge-confirmar"]');
  await sleep(900);
  const mrg = posted.find((p) => p.pathname === '/api/v3/warehouse/family/merge-bulk');
  rec('juntar', 'confirmar chama POST /warehouse/family/merge-bulk',
      !!mrg, JSON.stringify(posted.map((p) => p.pathname)));
  rec('juntar', 'manda o grupo com o pai e os filhos, no formato do contrato',
      !!mrg && Array.isArray(mrg.body.groups) && mrg.body.groups[0].into_product_id === 1
      && mrg.body.groups[0].from_product_ids.join(',') === '91,92',
      JSON.stringify(mrg && mrg.body));

  // ad-hoc: marcar 2 linhas na tabela e juntar
  await page.evaluate(() => { const b = document.querySelector('.kit-drawer-back'); if (b) b.click(); });
  await sleep(400);
  await page.click('[data-select="3"]');
  await page.click('[data-select="5"]');
  await sleep(300);
  const selbar = await page.$eval('[data-selbar]', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  rec('juntar', 'marcar 2 linhas abre a barra "Juntar selecionados"',
      /2 linhas marcadas/.test(selbar), selbar.slice(0, 70));
  await page.click('[data-act="juntar-selecionados"]');
  await page.waitForSelector('[data-merge-adhoc]', { timeout: 5000 }).catch(() => {});
  const adhocOpts = await page.$$eval('[data-adhoc-parent] option', (e) => e.map((o) => o.textContent.trim()));
  rec('juntar', 'da pra escolher qual das linhas marcadas e o pai',
      adhocOpts.length === 2 && adhocOpts.some((t) => /Chlorophyll/.test(t)), adhocOpts.join(' | '));
  posted.length = 0;
  await page.click('[data-act="merge-adhoc"]');
  await sleep(300);
  await page.click('[data-act="merge-confirmar"]');
  await sleep(900);
  const mrg2 = posted.find((p) => p.pathname === '/api/v3/warehouse/family/merge-bulk');
  rec('juntar', 'juntar ad-hoc tambem passa pelo merge-bulk', !!mrg2, JSON.stringify(mrg2 && mrg2.body));
  await sleep(600);
  /* O pai sugerido e o SKU MAIS CURTO das marcadas (HF-NAC-600 tem 10 letras,
     HF-CHLO-100 tem 11), entao Chlorophyll (3) e quem vira filha. A linha some
     NA HORA, sem esperar o poll de 20s: foi a pessoa que mandou juntar. */
  const afterRows = await page.$$eval('[data-table="produtos"] tbody tr[data-row]', (e) => e.map((r) => r.dataset.row));
  rec('juntar', 'depois de juntar, a linha que virou filha some da tabela',
      afterRows.length === 7 && !afterRows.includes('3'), afterRows.join(','));

  await go('estoque');
  await page.waitForSelector('[data-table="produtos"] tbody tr', { timeout: 10000 }).catch(() => {});
  await sleep(400);

  // ordenacao: clicar no cabecalho troca a coluna e inverte no 2o clique
  await page.click('[data-sort="days"]');
  await sleep(300);
  const order1 = await page.$$eval('[data-table="produtos"] tbody tr[data-row]', (e) => e.map((r) => r.dataset.row));
  const note1 = await page.$eval('[data-sort-note]', (e) => e.textContent.trim());
  rec('estoque', 'ordenar por dias poe o mais critico primeiro e o "sem venda" no fim',
      order1[0] === '4' && order1.slice(-2).sort().join(',') === '3,8', order1.join(','));
  rec('estoque', 'rodape diz por qual coluna esta ordenado', /dias de estoque ↑/.test(note1), note1);
  await page.click('[data-sort="days"]');
  await sleep(300);
  const order2 = await page.$$eval('[data-table="produtos"] tbody tr[data-row]', (e) => e.map((r) => r.dataset.row));
  rec('estoque', '2o clique inverte a ordem', order2[0] === '1', order2.join(','));
  await page.click('[data-sort="available"]');
  await sleep(300);

  /* ── aviso de propostas paradas (contrato 3, pending_summary) ─── */
  const notice = await page.$('[data-pending-notice]');
  rec('estoque', 'aviso de propostas esperando aparece', !!notice);
  const noticeTxt = notice ? await page.evaluate((e) => e.textContent.replace(/\s+/g, ' ').trim(), notice) : '';
  const PS = OVERVIEW.data.pending_summary;
  rec('estoque', 'aviso traz a contagem e a idade da mais antiga',
      new RegExp('^' + PS.count + ' propostas esperando').test(noticeTxt)
      && /a mais antiga há 5h/.test(noticeTxt), noticeTxt.slice(0, 90));
  const noticeHref = notice ? await page.$eval('[data-pending-notice] a', (e) => e.getAttribute('href')) : '';
  rec('estoque', 'aviso leva pra Aprovações', noticeHref === '#estoque-aprovacoes', noticeHref);

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
  rec('nav', 'subgrupo P&P dentro de Estoque', !!est && est.subs.includes('P&P'), est ? est.subs.join(',') : '');
  rec('nav', 'P&P e Picklist estão em Estoque, não em Operação',
      !!est && est.items.includes('#pp') && est.items.includes('#picklist'));

  /* Ordem FINAL da seção (Bruno 08-19 "organizar tudo"): as duas telas
     "(antigo)" sairam do menu e o subgrupo P&P fecha a lista. */
  const WANT_EST = ['#estoque', '#estoque-aprovacoes', '#estoque-locais', '#estoque-etiquetas',
                    '#produto-setup', '#config-estoque', '#pp', '#picklist'];
  rec('nav', 'ordem exata de Estoque (hub, aprovações, locais, etiquetas, setup, config, P&P)',
      !!est && est.items.join(',') === WANT_EST.join(','), est ? est.items.join(',') : '');
  rec('nav', 'nenhuma entrada "(antigo)" no menu inteiro',
      !nav.some((s) => s.items.includes('#estoque-geral') || s.items.includes('#inventory')),
      JSON.stringify(nav.map((s) => s.items).flat()));
  const legacyLabels = await page.$$eval('.nav-item .nav-label', (e) => e.map((x) => x.textContent));
  rec('nav', 'a palavra "antigo" sumiu dos rótulos do menu',
      !legacyLabels.some((t) => /antigo/i.test(t)), legacyLabels.filter((t) => /antigo/i.test(t)).join(','));

  /* Badge de aprovações: le pending_summary.count do mesmo /overview. */
  const badge = await page.$eval('[data-nav-badge="estoque-aprovacoes"]', (e) => e.textContent.trim()).catch(() => null);
  rec('nav', 'Aprovações mostra o contador de propostas esperando',
      badge === String(OVERVIEW.data.pending_summary.count), 'badge=' + badge);
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

  /* Idade com cor: >4h ambar, >24h vermelho, o resto cinza. Quem abre a fila
     precisa ver de longe quem esta esperando desde ontem. */
  const ageTones = await page.$$eval('[data-cell="age"] [data-age-tone]',
    (e) => e.map((x) => ({ tone: x.dataset.ageTone, txt: x.textContent.trim() })));
  rec('estoque-aprovacoes', 'cada linha tem chip de espera', ageTones.length === nReq,
      JSON.stringify(ageTones));
  rec('estoque-aprovacoes', 'espera curta fica neutra, longa fica ambar/vermelha',
      ageTones.every((a) => ['neutral', 'warn', 'bad'].includes(a.tone))
      && ageTones.some((a) => a.tone !== 'neutral'), JSON.stringify(ageTones));

  // locais: 8 bins + 4 caixas
  await go('estoque-locais');
  await page.waitForSelector('[data-table="bins"] tbody tr', { timeout: 8000 }).catch(() => {});
  const nBins = await page.$$eval('[data-table="bins"] tbody tr', (e) => e.length);
  const nBoxes = await page.$$eval('[data-table="boxes"] tbody tr', (e) => e.length);
  rec('estoque-locais', 'tabelas de prateleiras (8) e caixas (4)', nBins === 8 && nBoxes === 4, nBins + ' bins / ' + nBoxes + ' caixas');

  /* ── acelerador do dia 1: criar varias prateleiras (contrato 4) ─── */
  const bulkCard = await page.$('[data-bulk="prateleiras"]');
  rec('locais-bulk', 'card "Criar várias prateleiras" existe', !!bulkCard);
  await page.click('[data-act="bulk-abrir"]');
  await sleep(300);
  // padrao da fixture: area A, 8 prateleiras, niveis A,B,C, 4 posicoes = 96
  const count0 = await page.$eval('[data-bulk-count]', (e) => e.textContent.trim()).catch(() => '');
  rec('locais-bulk', 'preview conta 96 (8 prateleiras x 3 niveis x 4 posições)', count0 === '96', 'contou=' + count0);
  const codesTxt = await page.$eval('[data-bulk-codes]', (e) => e.textContent).catch(() => '');
  rec('locais-bulk', 'códigos no esquema <área><prateleira><nível><posição>',
      /A01A1/.test(codesTxt) && /A01A2/.test(codesTxt) && /A08C4/.test(codesTxt), codesTxt.slice(0, 120));

  // mexer no formulario muda o preview AO VIVO (o numero e a ultima ponta)
  await page.$eval('[data-field="shelves"]', (e) => { e.value = ''; });
  await page.click('[data-field="shelves"]'); await page.type('[data-field="shelves"]', '2');
  await sleep(300);
  const count1 = await page.$eval('[data-bulk-count]', (e) => e.textContent.trim());
  rec('locais-bulk', 'preview refaz a conta ao vivo (2 x 3 x 4 = 24)', count1 === '24', 'contou=' + count1);

  // cap de 300: 30 prateleiras x 3 niveis x 4 posicoes = 360, corta em 300
  await page.$eval('[data-field="shelves"]', (e) => { e.value = ''; });
  await page.click('[data-field="shelves"]'); await page.type('[data-field="shelves"]', '30');
  await sleep(300);
  const capTxt = await page.$eval('[data-bulk-preview]', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
  rec('locais-bulk', 'acima de 300 avisa o limite em vez de mandar tudo',
      /limite é 300 por vez/.test(capTxt), capTxt.slice(0, 140));

  // volta pro caso normal e cria: POST no endpoint certo, com os codigos certos
  await page.$eval('[data-field="shelves"]', (e) => { e.value = ''; });
  await page.click('[data-field="shelves"]'); await page.type('[data-field="shelves"]', '2');
  await sleep(300);
  posted.length = 0;
  await page.click('[data-act="bulk-criar"]');
  await sleep(800);
  const bulkPost = posted.find((p) => p.pathname === '/api/v3/warehouse/locations/bins/bulk');
  rec('locais-bulk', 'criar chama POST /warehouse/locations/bins/bulk',
      !!bulkPost, JSON.stringify(posted.map((p) => p.pathname)));
  rec('locais-bulk', 'manda os 24 bins com bin_code e shelf',
      !!bulkPost && Array.isArray(bulkPost.body.bins) && bulkPost.body.bins.length === 24
      && bulkPost.body.bins[0].bin_code === 'A01A1' && bulkPost.body.bins[0].shelf === 'A01',
      JSON.stringify(bulkPost && bulkPost.body.bins && bulkPost.body.bins.slice(0, 2)));
  // o stub finge 2 codigos ja existentes → a tela mostra os DOIS numeros
  const bulkRes = await page.$eval('[data-bulk-result]', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  rec('locais-bulk', 'resultado diz quantas criou e quantas já existiam',
      /Criadas 22, já existiam 2/.test(bulkRes), bulkRes);
  const nextStep = await page.$eval('[data-act="bulk-etiquetas"]', (e) => e.getAttribute('href')).catch(() => '');
  rec('locais-bulk', 'depois de criar, o caminho pras Etiquetas fica na cara',
      nextStep === '#estoque-etiquetas', nextStep);
  await shot('estoque-locais-bulk');

  /* ══ PRODUCT SETUP: parentar SKU vale EM TODO LUGAR ══════════════
     A mesma decisao ("este produto e casepack daquele") tem que sair pela
     MESMA porta das duas telas. Se o Product Setup tivesse rota propria, um
     produto poderia ser casepack numa tela e garrafa na outra. */
  await go('produto-setup');
  await page.waitForSelector('[data-table="produto-setup"] tbody tr', { timeout: 8000 }).catch(() => {});
  const famHead = await page.$$eval('[data-table="produto-setup"] thead th', (e) => e.map((x) => x.textContent.trim()));
  rec('produto-setup', 'coluna Família existe', famHead.includes('Família'), famHead.join('|'));
  const isKid = await page.$eval('[data-family="3"]', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  rec('produto-setup', 'produto que ja e casepack mostra de QUEM ele e',
      /casepack de/.test(isKid) && /NAC 600/.test(isKid), isKid.slice(0, 70));
  const isParent = await page.$eval('[data-family="5"]', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  rec('produto-setup', 'a garrafa mostra quantos casepacks pendurados',
      /garrafa de 1 casepack/.test(isParent), isParent.slice(0, 70));

  posted.length = 0;
  await page.select('[data-family-pick="2"]', '1');
  await sleep(250);
  await page.click('[data-family="2"] [data-act="juntar"]');
  await sleep(800);
  const psMerge = posted.find((p) => p.pathname === '/api/v3/warehouse/family/merge-bulk');
  rec('produto-setup', 'juntar aqui usa a MESMA rota do hub (merge-bulk)',
      !!psMerge, JSON.stringify(posted.map((p) => p.pathname)));
  rec('produto-setup', 'manda o pai e o filho no formato do contrato',
      !!psMerge && psMerge.body.groups[0].into_product_id === 1
      && psMerge.body.groups[0].from_product_ids.join(',') === '2',
      JSON.stringify(psMerge && psMerge.body));

  posted.length = 0;
  await page.click('[data-family="3"] [data-act="desagrupar"]');
  await sleep(800);
  rec('produto-setup', 'desagrupar aqui usa a MESMA rota do hub (unmerge)',
      posted.some((p) => p.pathname === '/api/v3/warehouse/family/unmerge'),
      JSON.stringify(posted.map((p) => p.pathname)));
  rec('produto-setup', 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  await shot('produto-setup-familia');

  /* ── rotas legadas: fora do menu, mas vivas por hash + faixa ──── */
  for (const r of ['estoque-geral', 'inventory']) {
    await go(r);
    await page.waitForSelector('[data-legacy-banner]', { timeout: 8000 }).catch(() => {});
    const b = await page.$eval('[data-legacy-banner]', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
    rec('legado', r + ' abre por hash com a faixa de página antiga',
        /Página antiga\. O hub Estoque substitui esta tela\./.test(b), b.slice(0, 90));
    const href = await page.$eval('[data-legacy-banner] a', (e) => e.getAttribute('href')).catch(() => '');
    rec('legado', r + ' tem botão pro hub', href === '#estoque', href);
    /* A faixa diz "pagina antiga"; isto diz POR QUE o numero daqui difere: uma
       linha por listagem, entao a mesma garrafa aparece duas vezes. Sem essa
       frase alguem soma os casepacks e conta a garrafa em dobro. */
    const hint = await page.$eval('[data-casepack-hint]', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
    rec('legado', r + ' avisa que aqui casepack conta como linha separada',
        /Uma linha por listagem/.test(hint) && /hub Estoque/.test(hint), hint.slice(0, 100));
    rec('legado', r + ' sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
    await shot('legado-' + r);
  }

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
