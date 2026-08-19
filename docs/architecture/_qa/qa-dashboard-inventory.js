'use strict';
/**
 * QA harness do GRUPO B (Inventario & produtos) — tema STYLE-KIT.
 * Copia de qa-dashboard.js com fixtures proprias (invB-*.json) pra nao
 * disputar o harness compartilhado com os outros agentes.
 *
 * Rodar da RAIZ do projeto:  node docs/architecture/_qa/qa-dashboard-inventory.js
 *
 * Rotas cobertas: #inventory #estoque-geral #produto-setup #config-estoque
 *                 #picklist #estoque #estoque-aprovacoes #estoque-locais
 * Screenshots:    docs/architecture/_qa/theme-B-<rota>.png
 *
 * Assercoes de TEMA (o que a fase 2 promete):
 *   T1. zero erro de console por rota;
 *   T2. h1.kit-h1 em DM Serif Display com UMA palavra <em> verde;
 *   T3. SEM linha do topo apagada: a cor computada da 1a celula da 1a linha
 *       tem que ser IDENTICA a da ultima linha (era o bug do --drop-hl);
 *   T4. nenhum .card / .kit-card com gradiente no ::before.
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

// ── fixtures do grupo B + as do hub (so leitura, nao editadas) ────
const B_OV = readFix('invB-stock-overview.json');
const B_INV = readFix('invB-inventory.json');
const B = readFix('invB-misc.json');
const OVERVIEW = readFix('warehouse-overview.json');
const PRODUCT = readFix('warehouse-product.json');
const REQUESTS = readFix('warehouse-requests.json');
const LOCATIONS = readFix('warehouse-locations.json');

const LOGIN = { name: 'QA Admin', role: 'admin', functions: ['*'] };

function apiFixture(pathname, search) {
  // hub novo (#estoque, #estoque-aprovacoes, #estoque-locais)
  if (pathname.startsWith('/api/v3/warehouse/')) {
    const p = pathname.slice('/api/v3/warehouse/'.length);
    if (p === 'overview') return OVERVIEW;
    if (p.startsWith('product/')) {
      const id = Number(p.split('/')[1]);
      const row = OVERVIEW.data.products.find((x) => x.product_id === id);
      return row ? { data: { ...PRODUCT.data, product: row } } : PRODUCT;
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
    return { data: { ok: true, product: PRODUCT.data.product } };
  }

  // paginas do grupo B (/api/v3/data/*)
  if (pathname === '/api/v3/data/login') return { data: LOGIN };
  if (pathname === '/api/v3/data/health') return { data: { worker: { alive: true }, queue: 0, mode: 'qa' } };
  if (pathname === '/api/v3/data/stock-overview') return B_OV;
  if (pathname === '/api/v3/data/inventory') return B_INV;
  if (pathname === '/api/v3/data/stock/summary') return { data: B.stock_summary };
  if (pathname === '/api/v3/data/stock/bins') return { data: B.stock_bins };
  if (pathname === '/api/v3/data/stock/boxes') return { data: B.stock_boxes };
  if (pathname === '/api/v3/data/stock/planner') return { data: B.stock_planner };
  if (pathname === '/api/v3/data/stock/issues') return { data: B.stock_issues };
  if (pathname === '/api/v3/data/stock/skus') return { data: B.stock_skus };
  if (pathname === '/api/v3/data/supplies') return { data: B.supplies };
  if (pathname === '/api/v3/data/product-setup') return { data: B.product_setup };
  if (pathname === '/api/v3/data/product-setup/tiers') return { data: B.product_setup_tiers };
  if (pathname.startsWith('/api/v3/data/product-setup/channel-skus')) {
    return { data: { items: [
      { sku: 'B0BENF300', title: 'Benfotiamine 300 mg | HealthFare', attached_product_id: 1, attached_product: 'Benfotiamine 300 mg' },
      { sku: 'B0BERB500', title: 'Berberine 500 mg | HealthFare', attached_product_id: null, attached_product: null },
      { sku: 'B0CHLO473', title: 'Chlorophyll Liquid 473 ml | HealthFare', attached_product_id: null, attached_product: null },
    ] } };
  }
  if (pathname === '/api/v3/data/inventory-settings') return { data: B.inventory_settings };
  if (pathname === '/api/v3/data/picklist') return { data: B.picklist };

  // resto: vazio seguro (nao pendura nenhuma pagina)
  if (pathname === '/api/v3/data/incidents') return { data: [] };
  if (pathname === '/api/v3/data/pending-totals') return { data: [] };
  if (pathname === '/api/v3/data/attendance') return { data: [] };
  if (pathname === '/api/v3/data/batches') return { data: [] };
  if (pathname === '/api/v3/data/search') return { data: [] };
  if (pathname === '/api/v3/data/timeline') return { data: { events: [], operators: [], gaps: [] } };
  if (pathname === '/api/v3/data/deadlines') return { data: { deadlines: [] } };
  if (pathname === '/api/v3/data/veeqo-today') return { data: { total_orders: 0, total_units: 0, by_channel: [], by_product: [] } };
  if (pathname === '/api/v3/data/rbac') return { data: { functions: [], roles: [] } };
  if (pathname.startsWith('/api/v3/data/catalog/')) {
    const k = pathname.split('/').pop();
    return { data: { [k === 'persons' ? 'persons' : k === 'activity-types' ? 'activity_types' : 'products']: [] } };
  }
  return { data: {} };
}

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
        req.respond({ status: 200, contentType: 'application/json',
          body: JSON.stringify(apiFixture(u.pathname, u.search)) });
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
    const f = path.join(QA, 'theme-B-' + name + '.png');
    await page.screenshot({ path: f, fullPage: true });
    const kb = Math.round(fs.statSync(f).size / 1024);
    rec('screenshot', name, kb > 4, kb + ' KB → ' + path.basename(f));
  };

  /* Navega pra uma rota. Uma unica carga por rota (about:blank primeiro, senao
     mudar so o hash nao remonta o app).
     `domcontentloaded` + espera fixa em vez de `networkidle0`: paginas que
     fazem @import de fonte do Google (picklist, config-estoque) nunca chegam a
     networkidle0 aqui, porque o harness ABORTA todo host externo de proposito
     e a request fica pendurada ate o timeout de navegacao. */
  async function go(hash) {
    // Page.stopLoading mata o que ficou em voo da rota anterior. Sem isso, uma
    // request de fonte externa (abortada de proposito) segura o lifecycle e ate
    // o goto('about:blank') estoura o timeout de navegacao.
    await page._client().send('Page.stopLoading').catch(() => {});
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.goto(BASE + '#' + hash, { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    consoleErrors.length = 0;
    await sleep(800);
  }

  /* T2 — h1 do kit: DM Serif Display + UMA palavra <em> em verde. */
  async function checkH1(route) {
    const h = await page.evaluate(() => {
      const el = document.querySelector('h1.kit-h1');
      if (!el) return null;
      const cs = getComputedStyle(el);
      const em = el.querySelector('em');
      const ecs = em ? getComputedStyle(em) : null;
      return {
        text: el.textContent.trim(),
        font: cs.fontFamily,
        hasEm: !!em,
        emText: em ? em.textContent.trim() : '',
        emStyle: ecs ? ecs.fontStyle : '',
        emColor: ecs ? ecs.color : '',
      };
    });
    if (!h) { rec(route, 'T2 h1.kit-h1 presente', false, 'nenhum h1.kit-h1'); return; }
    rec(route, 'T2 h1 em DM Serif Display', /DM Serif Display/i.test(h.font), h.font);
    rec(route, 'T2 h1 tem <em> italico verde', h.hasEm && h.emStyle === 'italic' && /46,\s*139,\s*60/.test(h.emColor),
        '"' + h.emText + '" ' + h.emStyle + ' ' + h.emColor);
  }

  /* T3 — NENHUMA linha do topo apagada. Era o bug do --drop-hl: o ::before do
     card punha um gradiente branco por cima e o texto do TOPO da tabela saia
     mais claro que o de baixo, so por causa da POSICAO.
     Compara a 1a com a ULTIMA linha comparavel: linhas marcadas .off sao
     apagadas DE PROPOSITO (produto inativo, caixa vazia, issue resolvida), o
     que e semantico e nao posicional, entao ficam de fora da comparacao.
     Confere cor + opacity + filter da 1a celula; e tambem a cor de TODAS as
     linhas comparaveis, pra pegar qualquer degrade no meio. */
  async function checkNoFade(route) {
    const out = await page.evaluate(() => {
      const bad = [];
      let checked = 0;
      const tables = [...document.querySelectorAll('table')];
      for (const t of tables) {
        const rows = [...t.querySelectorAll('tbody tr')].filter((r) =>
          r.offsetParent !== null && r.querySelector('td') && !r.classList.contains('off'));
        if (rows.length < 2) continue;
        checked++;
        const styles = rows.map((r) => getComputedStyle(r.querySelector('td')));
        const ref = styles[0];
        const name = t.dataset.table || t.className || '?';
        styles.forEach((cs, i) => {
          if (cs.color !== ref.color) bad.push({ table: name, row: i, first: ref.color, got: cs.color, why: 'color' });
          else if (cs.opacity !== ref.opacity) bad.push({ table: name, row: i, first: ref.opacity, got: cs.opacity, why: 'opacity' });
          else if (cs.filter !== ref.filter) bad.push({ table: name, row: i, why: 'filter' });
        });
      }
      return { bad, checked };
    });
    rec(route, 'T3 sem linha do topo apagada (todas as linhas com a mesma tinta)',
        out.bad.length === 0, out.checked + ' tabela(s) conferida(s)' + (out.bad.length ? ' | ' + JSON.stringify(out.bad).slice(0, 220) : ''));
  }

  /* T4 — nenhum .card/.kit-card com gradiente no ::before (o "water-drop"). */
  async function checkNoDropGradient(route) {
    const out = await page.evaluate(() => {
      const bad = [];
      const els = [...document.querySelectorAll('.card, .kit-card')];
      for (const el of els) {
        const bs = getComputedStyle(el, '::before');
        const img = bs.backgroundImage || '';
        if (/gradient/i.test(img)) bad.push((el.className || '?').slice(0, 40) + ' :: ' + img.slice(0, 60));
      }
      return { bad, n: els.length };
    });
    rec(route, 'T4 nenhum ::before com gradiente em .card/.kit-card',
        out.bad.length === 0, out.n + ' card(s)' + (out.bad.length ? ' | ' + out.bad.slice(0, 2).join(' | ') : ''));
  }

  async function route(hash, waitSel, opts) {
    const o = opts || {};
    await go(hash);
    if (waitSel) await page.waitForSelector(waitSel, { timeout: 9000 }).catch(() => {});
    await sleep(250);
    await shot(hash);
    rec(hash, 'T1 sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    if (o.h1 !== false) await checkH1(hash);
    await checkNoFade(hash);
    await checkNoDropGradient(hash);
  }

  // ══ paginas restiladas ═══════════════════════════════════════
  await route('inventory', '[data-page="inv-armazem"] table tbody tr');

  // abas do #inventory como segmented control do kit
  const segN = await page.$$eval('[data-page="inv-armazem"] .kit-seg.pgi-seg button', (e) => e.length);
  rec('inventory', 'abas como segmented control do kit (10)', segN === 10, 'botoes=' + segN);
  const segOn = await page.$eval('[data-page="inv-armazem"] .kit-seg.pgi-seg button.on', (e) => e.textContent.trim()).catch(() => '');
  rec('inventory', 'aba ativa marcada .on', /Estoque/.test(segOn), segOn.slice(0, 24));
  const nStock = await page.$$eval('[data-table="inv-stock"] tbody tr', (e) => e.length);
  rec('inventory', 'aba Estoque lista os 8 produtos da fixture', nStock === 8, 'linhas=' + nStock);

  // percorre as abas pesadas e refaz o teste do topo apagado em cada tabela
  for (const t of ['bins', 'boxes', 'planner', 'issues', 'supplies', 'matched']) {
    await page.evaluate((id) => {
      const b = document.querySelector('[data-tab="' + id + '"]');
      if (b) b.click();
    }, t);
    await sleep(450);
    const n = await page.$$eval('[data-page="inv-armazem"] .kit-table tbody tr', (e) => e.length).catch(() => 0);
    rec('inventory', 'aba ' + t + ' renderiza linhas', n > 0, 'linhas=' + n);
    await checkNoFade('inventory/' + t);
  }
  await page.evaluate(() => { const b = document.querySelector('[data-tab="supplies"]'); if (b) b.click(); });
  await sleep(450);
  await shot('inventory-suprimentos');
  await page.evaluate(() => { const b = document.querySelector('[data-tab="planner"]'); if (b) b.click(); });
  await sleep(450);
  await shot('inventory-planner');

  // ── #estoque-geral (Ver estoque) + modal protegido 2 passos ──
  await route('estoque-geral', '[data-table="ver-estoque"] tbody tr');
  const nVe = await page.$$eval('[data-table="ver-estoque"] tbody tr', (e) => e.length);
  rec('estoque-geral', 'tabela lista os 8 produtos', nVe === 8, 'linhas=' + nVe);

  // abre o modal do 1o produto com SKU Veeqo
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-table="ver-estoque"] tbody button')]
      .find((x) => x.textContent.trim() === 'editar');
    if (b) b.click();
  });
  await sleep(400);
  const modalIs = await page.$('.kit-modal[data-modal="editar-veeqo"]');
  rec('estoque-geral', 'modal de editar usa .kit-modal', !!modalIs);
  const step1 = await page.$eval('.kit-modal', (e) => e.textContent).catch(() => '');
  rec('estoque-geral', 'passo 1 mostra Revisar', /Revisar/.test(step1), step1.slice(0, 60));
  // preenche e vai pro passo 2
  await page.type('.kit-modal input.kit-input.mono', '150').catch(() => {});
  await sleep(200);
  await page.evaluate(() => { const b = document.querySelector('[data-act="revisar"]'); if (b) b.click(); });
  await sleep(300);
  const step2 = await page.$eval('.kit-modal', (e) => e.textContent).catch(() => '');
  rec('estoque-geral', 'passo 2 mostra Confirmar + aviso "Passo 2 de 2"',
      /Confirmar/.test(step2) && /Passo 2 de 2/.test(step2), step2.slice(-70));
  await shot('estoque-geral-modal');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.kit-modal .foot button')].find((x) => x.textContent.trim() === 'Cancelar');
    if (b) b.click();
  });
  await sleep(200);

  // ── #produto-setup ───────────────────────────────────────────
  await route('produto-setup', '[data-table="produto-setup"] tbody tr');
  const nPs = await page.$$eval('[data-table="produto-setup"] tbody tr', (e) => e.length);
  rec('produto-setup', 'tabela lista os 5 produtos da fixture', nPs === 5, 'linhas=' + nPs);
  const chips = await page.$$eval('.pgi-ch', (e) => e.length);
  rec('produto-setup', 'SKUs viram chips tonais por canal', chips >= 8, 'chips=' + chips);
  const hold = await page.$$eval('[data-table="produto-setup"] .kit-chip.bad', (e) => e.map((x) => x.textContent.trim()));
  rec('produto-setup', 'produto em hold marcado com chip bad', hold.some((t) => /hold/i.test(t)), hold.join(','));

  // ── verificacao (nao restiladas por mim) ─────────────────────
  await route('config-estoque', '.is-root', { h1: false });
  const isH1 = await page.$eval('h1.is-h1', (e) => ({ f: getComputedStyle(e).fontFamily, em: !!e.querySelector('em') })).catch(() => null);
  rec('config-estoque', 'h1 escopado (is-h1) em DM Serif com <em>',
      !!isH1 && /DM Serif Display/i.test(isH1.f) && isH1.em, isH1 ? isH1.f : 'sem h1.is-h1');

  await route('picklist', '.pl-root', { h1: false });
  const plH1 = await page.$eval('h1.pl-h1', (e) => ({ f: getComputedStyle(e).fontFamily, em: !!e.querySelector('em') })).catch(() => null);
  rec('picklist', 'h1 escopado (pl-h1) em DM Serif com <em>',
      !!plH1 && /DM Serif Display/i.test(plH1.f) && plH1.em, plH1 ? plH1.f : 'sem h1.pl-h1');

  await route('estoque', '[data-table="produtos"] tbody tr');
  await route('estoque-aprovacoes', '[data-table="requests"] tbody tr');
  await route('estoque-locais', '[data-table="bins"] tbody tr');

  await browser.close();
  server.close();

  const fails = results.filter((r) => !r.pass);
  console.log('\n' + '─'.repeat(64));
  console.log(results.length - fails.length + ' PASS  ·  ' + fails.length + ' FAIL');
  fs.writeFileSync(path.join(QA, 'qa-dashboard-inventory-report.json'),
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (fails.length) { fails.forEach((f) => console.log('  FAIL [' + f.group + '] ' + f.name + '  ' + f.detail)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
