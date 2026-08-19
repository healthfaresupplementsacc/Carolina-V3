'use strict';
/**
 * /**
 * QA harness do TEMA (agente THEME LEAD) — copia de qa-dashboard.js.
 * Roda TODAS as rotas do dashboard-v4 e checa a pele do STYLE-KIT:
 *   - zero erro de console por rota;
 *   - getComputedStyle(body).fontFamily contem DM Sans;
 *   - NENHUM ::before dentro de .card pinta gradiente (o water-drop morreu);
 *   - .card = branco chapado, sem background-image.
 * Screenshots: docs/architecture/_qa/theme-<rota>.png
 * Rodar da RAIZ:  node docs/architecture/_qa/qa-dashboard-theme.js
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
/* Todas as rotas da nav (Shell.jsx) + as soltas. A ordem segue o menu.
   `estoque-geral` e `inventory` SAIRAM do menu (08-19) mas continuam abrindo
   por hash, entao continuam sendo auditadas: pagina fora do menu que ninguem
   olha e exatamente onde o tema velho sobrevive. */
const ROUTES = [
  'hoje', 'producao', 'metas', 'pessoas',
  'pp', 'picklist',
  'estoque', 'estoque-aprovacoes', 'estoque-locais', 'estoque-etiquetas',
  'estoque-geral', 'inventory', 'produto-setup', 'config-estoque',
  'impressao', 'floor', 'cameras', 'roadmap',
  'admin', 'operadores', 'usuarios', 'sistema', 'config',
  'suporte', 'produto', 'falar', 'planejamento', 'carolina',
];

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
    const err = (r.failure() && r.failure().errorText) || '';
    consoleErrors.push('requestfailed: ' + r.url() + ' (' + err + ')');
  });

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
    const f = path.join(QA, 'theme-' + name + '.png');
    await page.screenshot({ path: f });
    const kb = Math.round(fs.statSync(f).size / 1024);
    return kb;
  };

  async function go(hash) {
    await page.goto('about:blank');
    await page.goto(BASE + '#' + hash, { waitUntil: 'networkidle0' });
    await sleep(600);
    consoleErrors.length = 0;
    await sleep(600);
  }

  /* ── As tres checagens do tema, rodadas DENTRO da pagina ───────── */
  const themeProbe = () => page.evaluate(() => {
    const out = {};

    // 1. fonte do kit no body
    out.bodyFont = getComputedStyle(document.body).fontFamily;

    // 2. NENHUM ::before dentro de .card pode pintar gradiente (water-drop).
    //    Varre o proprio .card e todo descendente.
    const grads = [];
    document.querySelectorAll('.card').forEach((card) => {
      const scope = [card, ...card.querySelectorAll('*')];
      scope.forEach((el) => {
        ['::before', '::after'].forEach((pe) => {
          let bi = '';
          try { bi = getComputedStyle(el, pe).backgroundImage || ''; } catch (e) { return; }
          if (/gradient/i.test(bi)) {
            grads.push((el.className && String(el.className).slice(0, 40)) + pe + ' ' + bi.slice(0, 70));
          }
        });
      });
    });
    out.cardGradients = grads;

    // 3. .card = branco chapado (sem background-image proprio)
    const cards = [...document.querySelectorAll('.card')];
    out.cardCount = cards.length;
    out.cardBadBg = cards
      .filter((c) => {
        const s = getComputedStyle(c);
        return s.backgroundImage && s.backgroundImage !== 'none';
      })
      .map((c) => String(c.className).slice(0, 40) + ' ' + getComputedStyle(c).backgroundImage.slice(0, 60));

    // extra: sidebar tambem sem overlay
    const sb = document.querySelector('.sidebar');
    out.sidebarBefore = sb ? (getComputedStyle(sb, '::before').backgroundImage || 'none') : 'no-sidebar';

    /* ── 4. TEXTO EM GRADIENTE (S15 08-19) ────────────────────────
       O truque `background-clip:text` + `color:transparent` era a assinatura
       do tema anterior. Se sobrou em algum titulo, o texto nao tem cor real e
       some no dark. Varre a pagina inteira, nao so os cards. */
    out.gradText = [];
    document.querySelectorAll('.main *').forEach((el) => {
      const s = getComputedStyle(el);
      const clip = s.webkitBackgroundClip || s.backgroundClip || '';
      if (/text/i.test(clip) && /gradient/i.test(s.backgroundImage || '')) {
        out.gradText.push(String(el.className).slice(0, 40) + ' ' + (el.textContent || '').trim().slice(0, 24));
      }
    });

    /* ── 5. PALETA VELHA ──────────────────────────────────────────
       Roxo/indigo/ciano do tema antigo nao existem no kit (navy + verde +
       os tons semanticos). Qualquer superficie visivel pintada com eles e
       sobra que ninguem reescreveu. */
    const isOld = (rgb) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(rgb || '');
      if (!m) return false;
      const [r, g, b] = [+m[1], +m[2], +m[3]];
      const a = m[4] === undefined ? 1 : +m[4];
      if (a < 0.15) return false;                       // quase transparente, nao pinta
      // roxo/violeta: azul e vermelho altos, verde baixo (o --dispute do kit e
      // #5b4a9e = 91,74,158 e e LEGITIMO, entao exige saturacao maior que ele)
      const purple = b > 150 && r > 110 && g < r - 45 && g < b - 55;
      // ciano/turquesa berrante (o --teal do kit e #1a7a7a = escuro, passa)
      const cyan = g > 165 && b > 165 && r < 110;
      return purple || cyan;
    };
    out.oldPalette = [];
    document.querySelectorAll('.main *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) return;          // invisivel, nao conta
      const s = getComputedStyle(el);
      if (isOld(s.backgroundColor)) {
        out.oldPalette.push('bg ' + String(el.className).slice(0, 34) + ' ' + s.backgroundColor);
      }
      if (/gradient/i.test(s.backgroundImage || '') && isOld(s.backgroundImage)) {
        out.oldPalette.push('grad ' + String(el.className).slice(0, 34) + ' ' + s.backgroundImage.slice(0, 50));
      }
    });

    /* ── 6. BOTOES / INPUTS / TABELAS FORA DO KIT ─────────────────
       Um <button> que nao e .kit-btn nem um dos botoes de chrome conhecidos
       (icone do topbar, nav, tabs, seg) foi escrito a mao e nao segue o pill
       navy. Mesma ideia pros inputs e pras tabelas. Reporta o que achou pra o
       relatorio dizer ONDE, nao so que existe. */
    /* Vale como "do kit" qualquer classe .kit-* (kit-btn, kit-kpi-card clicavel,
       kit-seg…), o chrome do app (.btn/.icon-btn do shell) e o que vive dentro
       de um container do kit (abas do drawer, segmented, sidebar, topbar). */
    const okBtn = (el) => el.closest('.kit-seg, .kit-drawer .tabs, .kit-modal, .sidebar, .topbar, .tweaks, .float-panel')
      || [...el.classList].some((c) => c.startsWith('kit-'))
      || el.classList.contains('icon-btn')
      || el.classList.contains('btn') || el.classList.contains('nav-item')
      || el.classList.contains('nav-section-btn');
    /* O que caca de verdade e o botao PINTADO A MAO: fundo/borda em cor
       literal (#hex ou rgb fora do kit) em vez de token. Um <button> sem
       classe que so herda (fundo transparente, sem borda) e um controle
       inline legitimo (o "x" de remover chip, o gear que abre um popover),
       nao um segundo design system. */
    /* Fundos que o kit realmente usa em botao: navy escuro (primary-deep),
       navy (primary), branco (surface), cinza-azulado (surface-2), vermelho
       (bad-deep) e os fundos tonais dos chips. Qualquer outro fundo solido num
       botao e cor escrita a mao. */
    const CANON = [
      'rgb(13, 31, 60)', 'rgb(26, 58, 107)', 'rgb(255, 255, 255)', 'rgb(247, 250, 253)',
      'rgb(160, 44, 32)', 'rgb(232, 247, 234)', 'rgb(253, 246, 227)', 'rgb(253, 238, 236)',
      'rgb(234, 240, 251)', 'rgb(230, 243, 243)',
    ];
    const painted = (el) => {
      const bg = getComputedStyle(el).backgroundColor || '';
      // sem fundo solido = so herda o do card: controle inline legitimo
      if (!bg || bg === 'transparent' || /rgba\([^)]*,\s*0\)\s*$/.test(bg)) return false;
      return !CANON.includes(bg);
    };
    out.rawButtons = [...document.querySelectorAll('.main button, .main a.btn')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; })
      .filter((el) => !okBtn(el))
      .filter(painted)
      .map((el) => String(el.className || '(sem classe)').slice(0, 34) + ':' + (el.textContent || '').trim().slice(0, 18)
        + ' bg=' + getComputedStyle(el).backgroundColor);

    const okInput = (el) => el.classList.contains('kit-input') || el.classList.contains('input')
      || ['checkbox', 'radio', 'file', 'range', 'color', 'hidden', 'submit', 'button'].includes(el.type)
      || el.closest('.sidebar, .topbar, .tweaks, .float-panel, .date-picker');
    out.rawInputs = [...document.querySelectorAll('.main input, .main select, .main textarea')]
      .filter((el) => !okInput(el))
      .map((el) => (el.tagName + '.' + String(el.className || '(sem classe)')).slice(0, 44));

    out.rawTables = [...document.querySelectorAll('.main table')]
      .filter((el) => !el.classList.contains('kit-table') && !el.closest('[data-sheet]'))
      .map((el) => String(el.className || '(sem classe)').slice(0, 40));

    return out;
  });

  let shotCount = 0;
  for (const r of ROUTES) {
    await go(r);
    await page.waitForSelector('.app', { timeout: 8000 }).catch(() => {});
    const kb = await shot(r);
    shotCount++;

    rec(r, 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
    rec(r, 'screenshot', kb > 0 && kb < 2048, kb + ' KB → theme-' + r + '.png');

    const p = await themeProbe();
    rec(r, 'body em DM Sans', /DM Sans/.test(p.bodyFont), p.bodyFont.slice(0, 60));
    rec(r, 'nenhum ::before com gradiente em .card',
        p.cardGradients.length === 0,
        p.cardGradients.slice(0, 2).join(' | '));
    rec(r, '.card chapado (sem background-image)',
        p.cardBadBg.length === 0,
        p.cardBadBg.slice(0, 2).join(' | ') || (p.cardCount + ' cards'));
    rec(r, 'sidebar sem overlay water-drop',
        p.sidebarBefore === 'none' || p.sidebarBefore === 'no-sidebar',
        String(p.sidebarBefore).slice(0, 50));

    // ── auditoria STYLE-KIT (Bruno 08-19: "o layout vai no dashboard todo")
    rec(r, 'nenhum título com texto em gradiente',
        p.gradText.length === 0, p.gradText.slice(0, 3).join(' | '));
    rec(r, 'nenhuma superfície na paleta antiga (roxo/ciano)',
        p.oldPalette.length === 0, p.oldPalette.slice(0, 3).join(' | '));
    rec(r, 'todo botão da página é do kit',
        p.rawButtons.length === 0, p.rawButtons.slice(0, 4).join(' | '));
    rec(r, 'todo campo da página é do kit',
        p.rawInputs.length === 0, p.rawInputs.slice(0, 4).join(' | '));
    rec(r, 'toda tabela da página é kit-table',
        p.rawTables.length === 0, p.rawTables.slice(0, 3).join(' | '));
  }

  /* ── Dark theme: o toggle continua funcionando e nada fica ilegivel ── */
  await go('hoje');
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
  await sleep(500);
  await shot('dark-hoje');
  const dark = await page.evaluate(() => {
    const bs = getComputedStyle(document.body);
    const card = document.querySelector('.card');
    return {
      bodyBg: bs.backgroundColor,
      bodyColor: bs.color,
      font: bs.fontFamily,
      cardBg: card ? getComputedStyle(card).backgroundColor : 'no-card',
      cardImg: card ? getComputedStyle(card).backgroundImage : 'no-card',
    };
  });
  // luminancia do fundo tem que ser BAIXA e a do texto ALTA (senao o dark quebrou)
  const lum = (rgb) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '');
    if (!m) return null;
    return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
  };
  const bgL = lum(dark.bodyBg), fgL = lum(dark.bodyColor), cardL = lum(dark.cardBg);
  rec('dark', 'fundo escuro', bgL !== null && bgL < 0.25, dark.bodyBg + ' L=' + (bgL || 0).toFixed(2));
  rec('dark', 'texto claro', fgL !== null && fgL > 0.6, dark.bodyColor + ' L=' + (fgL || 0).toFixed(2));
  rec('dark', 'card escuro (nao branco)', cardL !== null && cardL < 0.35, dark.cardBg + ' L=' + (cardL || 0).toFixed(2));
  rec('dark', 'card sem gradiente', dark.cardImg === 'none', String(dark.cardImg).slice(0, 50));
  rec('dark', 'fonte do kit tambem no dark', /DM Sans/.test(dark.font), dark.font.slice(0, 50));

  await browser.close();
  server.close();

  const fails = results.filter((r) => !r.pass);
  console.log('\n' + '─'.repeat(60));
  console.log(shotCount + ' rotas  ·  ' + (results.length - fails.length) + ' PASS  ·  ' + fails.length + ' FAIL');
  fs.writeFileSync(path.join(QA, 'qa-theme-report.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (fails.length) { fails.forEach((f) => console.log('  FAIL [' + f.group + '] ' + f.name + '  ' + f.detail)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
