'use strict';
/**
 * QA harness — PAGE GROUP A (Operação). Copia de qa-dashboard.js com as
 * fixtures opA-* e as assercoes do tema STYLE-KIT.
 *
 * Rodar da RAIZ do projeto:  node docs/architecture/_qa/qa-dashboard-operacao.js
 *
 * O que faz:
 *   1. sobe um servidor http estatico servindo `public/` (o build ja tem que
 *      existir: `node node_modules/vite/bin/vite.js build` em dashboard-v4);
 *   2. INTERCEPTA toda requisicao pra /api/** e responde das fixtures
 *      (docs/architecture/_qa/fixtures/opA-*.json) — nunca fala com servidor
 *      nem banco;
 *   3. injeta sessionStorage v3pin + v3login (functions ['*']) antes do bundle;
 *   4. abre cada rota do grupo A, tira screenshot em theme-A-<rota>.png e roda
 *      as assercoes de tema (DM Serif nos h1, <em> no h1, sem erro de console).
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

// ── fixtures do grupo A ───────────────────────────────────────────
const TIMELINE = readFix('opA-timeline.json');
const DAY = readFix('opA-day.json');

const LOGIN = { name: 'QA Admin', role: 'admin', functions: ['*'] };

// ── freight cost watch (card Frete da pagina P&P, Bruno 08-28) ─────────
const FREIGHT_SUMMARY = {
  days: [
    { day: '2026-08-28', shipments: 126, labeled: 114, walmart_zero: 12, total_cost: 692.04, avg_cost: 6.07, outliers: 2, outlier_excess: 3.54 },
    { day: '2026-08-27', shipments: 160, labeled: 154, walmart_zero: 6, total_cost: 890.92, avg_cost: 5.79, outliers: 0, outlier_excess: 0 },
    { day: '2026-08-26', shipments: 155, labeled: 153, walmart_zero: 2, total_cost: 910.34, avg_cost: 5.95, outliers: 1, outlier_excess: 2.10 },
  ],
  avg_30d: 6.02, labeled_30d: 481,
};
const FREIGHT_OUTLIERS = { outliers: [
  // Fase A (09-01): o copiloto cotou este — tem valida mais barata (verde + dica)
  { shipment_id: 501, order_number: '2751', channel: 'eBay', service: 'USPS Ground Advantage',
    cost: 7.86, expected_cost: 6.09, band: 'usps_ga|4-8oz', outlier_reason: 'acima_da_faixa',
    due_date: '2026-09-04T16:00:00Z', alerted_at: '2026-08-28T13:45:00Z',
    quoted_best_cost: 5.62, quoted_best_service: 'USPS GA', quoted_valid_count: 4,
    quoted_at: '2026-08-28T13:44:00Z' },
  // este ainda sem cotacao (quoted_at null) — a linha diz "sem cotação", sem dica
  { shipment_id: 502, order_number: '2760', channel: 'Amazon', service: 'UPS 2nd Day Air',
    cost: 12.50, expected_cost: null, band: 'ups_2nd_day_air|4-8oz', outlier_reason: 'teto_absoluto',
    due_date: null, alerted_at: null,
    quoted_best_cost: null, quoted_best_service: null, quoted_valid_count: null, quoted_at: null },
] };

// ── planejamento (Bruno 09-04): o funil do EMS + plano por dia ─────────
// Board fixo (7 colunas); plano/notas MUTÁVEIS pra testar o PUT da lista
// ordenada (drag/+) e o autosave das anotações. planningLog grava cada
// escrita pra assercao em node land.
const planningLog = [];
const PLAN_STATE = { items: [], notes: {} };
const PLAN_BOARD = { columns: [
  { id: 'formulating', title: 'Formulando', count: 2, cards: [
    { batch_number: 'B-1001', product: 'Ashwagandha', product_id: 1, column: 'formulating', ems_stage: 'weighing', days_in_stage: 0.4, who: [], bottles: null, boxed_auto: false, manual_boxed: false, na_fila: false },
    { batch_number: 'B-1002', product: 'Turmeric', product_id: null, column: 'formulating', ems_stage: null, days_in_stage: null, who: [], bottles: null, boxed_auto: false, manual_boxed: false, na_fila: true },
  ] },
  { id: 'encapsulating', title: 'Encapsulando', count: 1, cards: [
    { batch_number: 'B-1003', product: 'Berberine', product_id: 2, column: 'encapsulating', ems_stage: 'encapsulating', days_in_stage: 0.2, who: [{ name: 'Vitor', slug: 'encapsulation', since: '2026-09-04T12:00:00Z' }], bottles: null, boxed_auto: false, manual_boxed: false, na_fila: false },
  ] },
  { id: 'waiting', title: 'Esperando revisão', count: 1, cards: [
    { batch_number: 'B-1004', product: 'Charcoal', product_id: 3, column: 'waiting', ems_stage: 'finalized', days_in_stage: 4.2, who: [], bottles: null, boxed_auto: false, manual_boxed: false, na_fila: false },
  ] },
  { id: 'revising', title: 'Em revisão', count: 1, cards: [
    { batch_number: 'B-1005', product: 'NAC', product_id: 4, column: 'revising', ems_stage: 'finalized', days_in_stage: 0.1, who: [{ name: 'Simone', slug: 'review', since: '2026-09-04T13:00:00Z' }], bottles: null, boxed_auto: false, manual_boxed: false, na_fila: false },
  ] },
  { id: 'ready', title: 'Pronto pra produção', count: 1, cards: [
    { batch_number: 'B-1006', product: 'Omega', product_id: 5, column: 'ready', ems_stage: 'finalized', days_in_stage: 1.5, who: [], bottles: null, boxed_auto: false, manual_boxed: false, na_fila: false },
  ] },
  { id: 'produced', title: 'Produzido', count: 1, cards: [
    { batch_number: 'B-1007', product: 'Zinc', product_id: 6, column: 'produced', ems_stage: 'finalized', days_in_stage: 2.0, who: [], bottles: 480, boxed_auto: false, manual_boxed: false, na_fila: false },
  ] },
  { id: 'boxed', title: 'Encaixotado', count: 1, cards: [
    { batch_number: 'B-1008', product: 'Magnesium', product_id: 7, column: 'boxed', ems_stage: 'finalized', days_in_stage: 3.0, who: [], bottles: 512, boxed_auto: true, manual_boxed: false, na_fila: false },
  ] },
], generated_at: '2026-09-04T15:00:00Z', ems_ok: true };

function planningFixture(pathname, method, body) {
  if (pathname === '/api/v3/planning/board') return { data: PLAN_BOARD };
  if (pathname === '/api/v3/planning/plan') {
    if (method === 'PUT') {
      planningLog.push({ method, pathname, body });
      PLAN_STATE.items = (body.items || []).map((it, i) => ({ id: 900 + i, plan_date: '2026-09-05', position: i, ...it }));
      return { data: { date: '2026-09-05', items: PLAN_STATE.items } };
    }
    return { data: { date: '2026-09-05', items: PLAN_STATE.items } };
  }
  if (pathname === '/api/v3/planning/notes') {
    if (method === 'PUT') {
      planningLog.push({ method, pathname, body });
      PLAN_STATE.notes = { plan_date: '2026-09-05', body: body.body, updated_at: new Date().toISOString() };
      return { data: PLAN_STATE.notes };
    }
    return { data: PLAN_STATE.notes.body ? PLAN_STATE.notes : { plan_date: '2026-09-05', body: '', updated_at: null } };
  }
  if (pathname === '/api/v3/planning/board/boxed') {
    planningLog.push({ method, pathname, body });
    return { data: { batch_number: body.batch_number, manual_boxed: body.manual_boxed } };
  }
  return null;
}

/** Resposta pra qualquer /api/**. */
function apiFixture(pathname, method, body) {
  const pl = planningFixture(pathname, method || 'GET', body || {});
  if (pl) return pl;
  if (pathname === '/api/v3/data/login') return { data: LOGIN };
  if (pathname === '/api/v3/data/health') return { data: { worker: { alive: true }, queue: 0, mode: 'qa' } };
  if (pathname === '/api/v3/data/timeline') return TIMELINE;
  if (pathname === '/api/v3/data/production') return { data: DAY.production };
  if (pathname === '/api/v3/data/pp') return { data: DAY.pp };
  if (pathname === '/api/v3/data/fnsku') return { data: DAY.fnsku };
  if (pathname === '/api/v3/data/support') return { data: DAY.support };
  if (pathname === '/api/v3/data/goals') return { data: DAY.goals };
  if (pathname === '/api/v3/data/counts') return { data: DAY.counts };
  if (pathname === '/api/v3/data/deadlines') return { data: DAY.deadlines };
  if (pathname === '/api/v3/data/review-rate') return { data: DAY.review };
  if (pathname === '/api/v3/data/veeqo-today') return { data: DAY.veeqo };
  if (pathname === '/api/v3/freight/summary') return { data: FREIGHT_SUMMARY };
  if (pathname === '/api/v3/freight/outliers') return { data: FREIGHT_OUTLIERS };
  if (pathname === '/api/v3/data/attendance') return { data: DAY.attendance };
  if (pathname === '/api/v3/data/incidents') return { data: DAY.incidents };
  if (pathname === '/api/v3/data/pending-totals') return { data: DAY.pending_totals };
  if (pathname === '/api/v3/data/batches') return { data: { active: [] } };
  if (pathname === '/api/v3/data/cameras') return { data: { cameras: [] } };
  if (pathname.startsWith('/api/v3/data/catalog/')) {
    const k = pathname.split('/').pop();
    if (k === 'persons') return { data: { persons: DAY.catalog.persons } };
    if (k === 'activity-types') return { data: { activity_types: DAY.catalog.activity_types } };
    return { data: { products: DAY.catalog.products } };
  }
  if (pathname === '/api/v3/data/roadmap') {
    return { data: { columns: [
      { id: 'todo', title: 'A fazer', cards: [{ id: 1, title: 'Tema STYLE-KIT', summary: 'S15 fase 2', status: 'doing' }] },
      { id: 'doing', title: 'Fazendo', cards: [] },
      { id: 'done', title: 'Feito', cards: [] },
    ], cards: [{ id: 1, title: 'Tema STYLE-KIT', summary: 'S15 fase 2', status: 'doing', column: 'todo' }], areas: [] } };
  }
  if (pathname === '/api/v3/data/rbac') return { data: { functions: [], roles: [] } };
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

// rotas do grupo A: [hash, seletor de sanidade, temTitulo]
const ROUTES = [
  ['hoje', '[data-page-op="hoje"]', true],
  ['producao', '[data-page-op="producao"]', true],
  ['metas', '[data-page-op="metas"]', true],
  ['pessoas', '[data-page-op="pessoas"]', true],
  ['pp', '[data-page-op="pp"]', true],
  ['suporte', '[data-page-op="suporte"]', true],
  ['produto', '[data-page-op="produto"]', true],
  ['falar', '[data-page-op="falar"]', true],
  ['planejamento', '[data-page-op="planejamento"]', true],
  ['carolina', '[data-page-op="placeholder"]', true],
  ['config', '[data-page-op="config"]', true],
  ['floor', '.fd-shell.opa-fd', false],       // TV: sem h1, header proprio
  ['roadmap', '.rm-root', true],              // ja no kit (verificacao)
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
  await page.setViewport({ width: 1600, height: 1100, deviceScaleFactor: 1 });

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
        let postBody = {};
        try { postBody = req.postData() ? JSON.parse(req.postData()) : {}; } catch (e) { postBody = {}; }
        req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(apiFixture(u.pathname, req.method(), postBody)) });
        return;
      }
      req.continue(); return;
    }
    req.abort();   // nada de rede externa (fontes do Google, CDNs)
  });

  await page.evaluateOnNewDocument((login) => {
    try {
      sessionStorage.setItem('v3pin', '0000');
      sessionStorage.setItem('v3login', JSON.stringify(login));
      sessionStorage.setItem('hf-tweaks', JSON.stringify({ theme: 'light' }));
    } catch (e) { /* ignore */ }
  }, LOGIN);

  const shot = async (name) => {
    const f = path.join(QA, 'theme-A-' + name + '.png');
    await page.screenshot({ path: f, fullPage: true });
    const kb = Math.round(fs.statSync(f).size / 1024);
    rec('screenshot', name, kb > 4, kb + ' KB → ' + path.basename(f));
  };

  /* O modal de EMERGENCIA abre sozinho quando chega um alerta critico novo
     (a fixture tem 1 downtime). E comportamento real da pagina, mas tapa a
     tela: fecha no OK antes de fotografar. */
  async function dismissEmergency() {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.kit-modal .foot button')]
        .find((x) => x.textContent.trim() === 'OK');
      if (b) b.click();
    }).catch(() => {});
    await sleep(200);
  }

  async function go(hash) {
    await page.goto('about:blank');
    await page.goto(BASE + '#' + hash, { waitUntil: 'networkidle0' });
    await sleep(700);
    consoleErrors.length = 0;
    await sleep(700);      // janela de observacao em regime
    await dismissEmergency();
  }

  for (const [route, sel, hasTitle] of ROUTES) {
    await go(route);
    await page.waitForSelector(sel, { timeout: 9000 }).catch(() => {});
    await shot(route);

    rec(route, 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
    const found = await page.$(sel);
    rec(route, 'renderizou (' + sel + ')', !!found);

    if (hasTitle) {
      // h1 da PAGINA (nao o do topbar): o primeiro h1 dentro de .main-inner
      const h1 = await page.evaluate(() => {
        const el = document.querySelector('.main-inner h1');
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          text: el.textContent.trim(),
          family: cs.fontFamily,
          weight: cs.fontWeight,
          color: cs.color,
          emCount: el.querySelectorAll('em').length,
          emText: [...el.querySelectorAll('em')].map((e) => e.textContent.trim()).join('|'),
          emColor: el.querySelector('em') ? getComputedStyle(el.querySelector('em')).color : null,
          emStyle: el.querySelector('em') ? getComputedStyle(el.querySelector('em')).fontStyle : null,
        };
      });
      rec(route, 'tem h1 de pagina', !!h1, h1 ? h1.text.slice(0, 50) : 'sem h1 em .main-inner');
      if (h1) {
        rec(route, 'h1 usa DM Serif Display', /DM Serif Display/i.test(h1.family), h1.family);
        rec(route, 'h1 tem exatamente 1 <em>', h1.emCount === 1, 'em=' + h1.emCount + ' "' + h1.emText + '"');
        rec(route, '<em> italico e verde',
            h1.emStyle === 'italic' && /46,\s*139,\s*60/.test(h1.emColor || ''),
            h1.emStyle + ' / ' + h1.emColor);
      }
      // eyebrow do kit
      const eyebrow = await page.$eval('.main-inner .kit-eyebrow, .main-inner .rm-eyebrow',
        (e) => e.textContent.trim()).catch(() => null);
      rec(route, 'eyebrow ● HEALTHFARE presente', !!eyebrow && /HEALTHFARE/.test(eyebrow), eyebrow || 'ausente');
    }
  }

  // ── assercoes extras por pagina ───────────────────────────────

  /* modal de EMERGENCIA: abre so quando o nº de criticos SOBE depois do
     baseline (nao no 1º load), entao nao da pra forcar de forma estavel aqui.
     A pele dele (kit-modal + titulo DM Serif com 1 <em>) esta em
     CommandCenter.jsx e aparece em theme-A-hoje-emergencia.png quando cai
     numa janela de poll. Sem assercao pra nao virar teste intermitente. */

  // #hoje: KPIs, faixa de ponto, incidentes, resumo do dia
  await go('hoje');
  await page.waitForSelector('[data-page-op="hoje"]', { timeout: 9000 }).catch(() => {});
  const hojeStats = await page.evaluate(() => ({
    kpis: document.querySelectorAll('[data-page-op="hoje"] .card.kpi').length,
    // Ponto virou PontoStrip (components/PontoStrip.jsx): 1 chip por pessoa
    att: document.querySelectorAll('[data-ponto-person]').length,
    alertBoxes: document.querySelectorAll('.opa-alertbox').length,
    strips: document.querySelectorAll('.opa-strip-item').length,
    kitChips: document.querySelectorAll('[data-page-op="hoje"] .kit-chip').length,
    mlabels: document.querySelectorAll('[data-page-op="hoje"] .kit-mlabel').length,
    oldPills: document.querySelectorAll('[data-page-op="hoje"] .section-title').length,
  }));
  rec('hoje', 'KPI cards renderizados', hojeStats.kpis >= 4, 'kpis=' + hojeStats.kpis);
  rec('hoje', 'faixa de Ponto com 3 pessoas', hojeStats.att === 3, 'cards=' + hojeStats.att);
  rec('hoje', 'incidente + 2 pendencias em caixa tonal do kit', hojeStats.alertBoxes === 3, 'boxes=' + hojeStats.alertBoxes);
  rec('hoje', 'Resumo do dia usa opa-strip-item', hojeStats.strips > 5, 'strips=' + hojeStats.strips);
  rec('hoje', 'usa kit-chip e kit-mlabel', hojeStats.kitChips > 0 && hojeStats.mlabels > 5,
      'chips=' + hojeStats.kitChips + ' mlabels=' + hojeStats.mlabels);
  rec('hoje', 'section-title antiga removida', hojeStats.oldPills === 0, 'restantes=' + hojeStats.oldPills);

  // KPI value em DM Serif (o numero grande do card)
  const kpiFont = await page.evaluate(() => {
    const v = document.querySelector('[data-page-op="hoje"] .card.kpi .value');
    return v ? getComputedStyle(v).fontFamily : null;
  });
  rec('hoje', 'valor do KPI em DM Serif', /DM Serif Display/i.test(kpiFont || ''), kpiFont);

  // #producao: 2 lotes
  await go('producao');
  await page.waitForSelector('[data-page-op="producao"] .lote-card', { timeout: 9000 }).catch(() => {});
  const nLotes = await page.$$eval('[data-page-op="producao"] .lote-card', (e) => e.length).catch(() => 0);
  rec('producao', 'lista os 2 lotes da fixture', nLotes === 2, 'lotes=' + nLotes);

  // #metas: 2 metas + chips de estado
  await go('metas');
  await page.waitForSelector('[data-page-op="metas"] .goal-card', { timeout: 9000 }).catch(() => {});
  const metas = await page.evaluate(() => ({
    n: document.querySelectorAll('[data-page-op="metas"] .goal-card').length,
    chips: [...document.querySelectorAll('[data-page-op="metas"] .kit-chip')].map((c) => c.textContent.trim()),
    numFont: (() => { const n = document.querySelector('[data-page-op="metas"] .goal-card .num');
      return n ? getComputedStyle(n).fontFamily : null; })(),
  }));
  rec('metas', 'lista as 2 metas', metas.n === 2, 'metas=' + metas.n);
  rec('metas', 'chip "batido" na meta completa', metas.chips.includes('batido'), metas.chips.join(','));
  rec('metas', 'numero da meta em DM Serif', /DM Serif Display/i.test(metas.numFont || ''), metas.numFont);

  // #pessoas: 3 cards
  await go('pessoas');
  await page.waitForSelector('[data-page-op="pessoas"] .person-card', { timeout: 9000 }).catch(() => {});
  const nPeople = await page.$$eval('[data-page-op="pessoas"] .person-card', (e) => e.length).catch(() => 0);
  rec('pessoas', 'lista as 3 pessoas', nPeople === 3, 'cards=' + nPeople);

  // #suporte: tabela do kit com 3 ocorrencias
  await go('suporte');
  await page.waitForSelector('[data-page-op="suporte"] .kit-table tbody tr', { timeout: 9000 }).catch(() => {});
  const sup = await page.evaluate(() => ({
    rows: document.querySelectorAll('[data-page-op="suporte"] .kit-table tbody tr').length,
    thFont: (() => { const t = document.querySelector('[data-page-op="suporte"] .kit-table thead th');
      return t ? getComputedStyle(t).fontFamily : null; })(),
    oldTable: document.querySelectorAll('[data-page-op="suporte"] table:not(.kit-table)').length,
  }));
  rec('suporte', 'tabela lista as 3 ocorrencias', sup.rows === 3, 'linhas=' + sup.rows);
  rec('suporte', 'thead da kit-table em DM Mono', /DM Mono/i.test(sup.thFont || ''), sup.thFont);
  rec('suporte', 'nenhuma tabela fora do kit', sup.oldTable === 0, 'tabelas antigas=' + sup.oldTable);

  // #pp: 3 sub-passos + KPIs
  await go('pp');
  await page.waitForSelector('[data-page-op="pp"]', { timeout: 9000 }).catch(() => {});
  const ppStats = await page.evaluate(() => ({
    rows: document.querySelectorAll('[data-page-op="pp"] .opa-row').length,
    kpis: document.querySelectorAll('[data-page-op="pp"] .card.kpi').length,
  }));
  rec('pp', 'lista os 3 sub-passos', ppStats.rows === 3, 'linhas=' + ppStats.rows);
  rec('pp', '3 KPIs do bloco', ppStats.kpis === 3, 'kpis=' + ppStats.kpis);

  // card Frete (freight cost watch, Bruno 08-28)
  await page.waitForSelector('[data-page-op="pp"] .freight-card', { timeout: 9000 }).catch(() => {});
  const fr = await page.evaluate(() => {
    const card = document.querySelector('[data-page-op="pp"] .freight-card');
    if (!card) return null;
    return {
      badge: (card.querySelector('.fr-badge') || {}).textContent || '',
      badgeBad: !!card.querySelector('.fr-badge.bad'),
      stats: card.querySelectorAll('.fr-stat').length,
      tableRows: card.querySelectorAll('.fr-table tbody tr').length,
      text: card.textContent,
    };
  });
  rec('pp', 'card Frete presente', !!fr, fr ? 'ok' : 'card ausente');
  if (fr) {
    rec('pp', 'badge de outliers em tom bad com a contagem', fr.badgeBad && /2 acima do normal/.test(fr.badge), fr.badge);
    rec('pp', '3 stats do dia (gasto, etiquetas, media)', fr.stats === 3, 'stats=' + fr.stats);
    rec('pp', 'mini tabela de 14d com os 3 dias da fixture', fr.tableRows === 3, 'linhas=' + fr.tableRows);
    rec('pp', 'gasto de hoje e media vs 30d na tela', /\$692\.04/.test(fr.text) && /\$6\.02/.test(fr.text), '');
    rec('pp', 'sem em dash no card', !/[—–]/.test(fr.text), '');
    // expande a lista de etiquetas caras
    await 0;
  }
  if (fr) {
    const opened = await page.evaluate(() => {
      const btn = document.querySelector('[data-page-op="pp"] .fr-toggle');
      if (!btn) return null;
      btn.click();
      return true;
    });
    await sleep(300);
    const out = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-page-op="pp"] .fr-outlier').length,
      text: (document.querySelector('[data-page-op="pp"] .fr-outliers') || {}).textContent || '',
    }));
    rec('pp', 'expande as 2 etiquetas caras', opened === true && out.rows === 2, 'linhas=' + out.rows);
    rec('pp', 'outlier mostra custo vs normal', /\$7\.86/.test(out.text) && /\$6\.09/.test(out.text), '');
    // Fase A: a dica de deletar SO aparece quando a cotacao achou mais barata
    rec('pp', 'veredito da cotacao: "cotei $5.62 USPS GA" verde + dica de deletar nessa linha',
      /cotei: \$5\.62 USPS GA/.test(out.text) && /deleta o envio na Veeqo/.test(out.text), '');
    rec('pp', 'etiqueta sem cotacao diz "sem cotação" e NAO leva dica de deletar',
      /sem cotação/.test(out.text) && (out.text.match(/deleta o envio na Veeqo/g) || []).length === 1, '');
    rec('pp', 'teto absoluto aparece rotulado', /teto absoluto/.test(out.text), '');
  }

  // #produto: 2 produtos com atividade
  await go('produto');
  await page.waitForSelector('[data-page-op="produto"]', { timeout: 9000 }).catch(() => {});
  const nProds = await page.$$eval('[data-page-op="produto"] .lote-card', (e) => e.length).catch(() => 0);
  rec('produto', 'lista os 2 produtos com atividade', nProds === 2, 'cards=' + nProds);

  // #config: 2 deadlines
  await go('config');
  await page.waitForSelector('[data-page-op="config"]', { timeout: 9000 }).catch(() => {});
  const nDl = await page.$$eval('[data-page-op="config"] .opa-row', (e) => e.length).catch(() => 0);
  rec('config', 'lista os 2 deadlines', nDl === 2, 'linhas=' + nDl);

  // #floor: TV no kit — fundo navy-deep, numeros DM Serif, 3 cards
  await go('floor');
  await page.waitForSelector('.fd-shell.opa-fd', { timeout: 9000 }).catch(() => {});
  const fd = await page.evaluate(() => {
    const shell = document.querySelector('.fd-shell.opa-fd');
    const timer = document.querySelector('.opa-fd .fd-current .timer');
    const clock = document.querySelector('.opa-fd .fd-day-clock');
    return {
      cards: document.querySelectorAll('.opa-fd .fd-card').length,
      bg: shell ? getComputedStyle(shell).backgroundColor : null,
      bgImage: shell ? getComputedStyle(shell).backgroundImage : null,
      timerFont: timer ? getComputedStyle(timer).fontFamily : null,
      timerSize: timer ? getComputedStyle(timer).fontSize : null,
      clockFont: clock ? getComputedStyle(clock).fontFamily : null,
      footChips: document.querySelectorAll('.opa-fd .opa-fd-foot-chip').length,
    };
  });
  rec('floor', '3 cards de operador', fd.cards === 3, 'cards=' + fd.cards);
  rec('floor', 'fundo navy-deep chapado do kit', /13,\s*31,\s*60/.test(fd.bg || ''), fd.bg);
  rec('floor', 'sem gradiente water-drop', fd.bgImage === 'none', fd.bgImage);
  rec('floor', 'cronometro em DM Serif e grande (TV)',
      /DM Serif Display/i.test(fd.timerFont || '') && parseFloat(fd.timerSize) >= 26,
      fd.timerFont + ' @ ' + fd.timerSize);
  rec('floor', 'relogio NY em DM Serif', /DM Serif Display/i.test(fd.clockFont || ''), fd.clockFont);
  rec('floor', 'rodape com chips do kit', fd.footChips >= 3, 'chips=' + fd.footChips);

  // #planejamento: o funil do EMS (7 colunas) + plano por dia (Bruno 09-04)
  planningLog.length = 0; PLAN_STATE.items = []; PLAN_STATE.notes = {};
  await go('planejamento');
  await page.waitForSelector('[data-pl-board]', { timeout: 9000 }).catch(() => {});
  const plBoard = await page.evaluate(() => ({
    cols: [...document.querySelectorAll('[data-pl-col]')].map((c) => c.getAttribute('data-pl-col')),
    heads: [...document.querySelectorAll('.pl-col-head .kit-mlabel')].map((h) => h.textContent.trim()),
    cards: document.querySelectorAll('.pl-card').length,
    naFila: [...document.querySelectorAll('.pl-card .kit-chip')].filter((c) => c.textContent.trim() === 'na fila').length,
    who: (document.querySelector('[data-pl-col="revising"] .pl-who') || {}).textContent || '',
    bottles: [...document.querySelectorAll('[data-pl-col="produced"] .kit-chip')].map((c) => c.textContent.trim()).join(','),
  }));
  rec('planejamento', '7 colunas na ordem do Bruno', plBoard.cols.join(',') === 'formulating,encapsulating,waiting,revising,ready,produced,boxed', plBoard.cols.join(','));
  rec('planejamento', 'cabecalhos PT-BR das colunas', plBoard.heads.join('|') === 'Formulando|Encapsulando|Esperando revisão|Em revisão|Pronto pra produção|Produzido|Encaixotado', plBoard.heads.join('|'));
  rec('planejamento', '8 cartoes da fixture renderizados', plBoard.cards === 8, 'cards=' + plBoard.cards);
  rec('planejamento', 'lote da fila viva marcado "na fila"', plBoard.naFila === 1, 'na_fila=' + plBoard.naFila);
  rec('planejamento', 'quem esta no lote agora (Simone em revisao)', /Simone/.test(plBoard.who), plBoard.who.trim());
  rec('planejamento', 'garrafas do produzido no cartao', /480 garrafas/.test(plBoard.bottles), plBoard.bottles);
  {
    const f = path.join(QA, 'planejamento-01.png');
    await page.screenshot({ path: f, fullPage: true });
    rec('screenshot', 'planejamento-01', fs.statSync(f).size / 1024 > 4, path.basename(f));
  }

  // + do cartao (caminho de toque do drag) → item entra em Amanha e PUT leva a lista ordenada
  await page.click('[data-pl-col="waiting"] .pl-card .pl-add');
  await sleep(500);
  const afterAdd = await page.evaluate(() => document.querySelectorAll('.pl-item').length);
  const putsAfterAdd = planningLog.filter((l) => l.method === 'PUT' && l.pathname === '/api/v3/planning/plan');
  rec('planejamento', 'clique no + adiciona o lote no plano de Amanha', afterAdd === 1, 'itens=' + afterAdd);
  rec('planejamento', 'PUT /plan levou a lista ordenada com o lote', putsAfterAdd.length === 1 && putsAfterAdd[0].body.items.length === 1 && putsAfterAdd[0].body.items[0].batch_number === 'B-1004',
    JSON.stringify((putsAfterAdd[0] || {}).body || {}));

  // drag HTML5 de verdade: dragstart no cartao do quadro → drop na lane
  const dragOk = await page.evaluate(() => {
    try {
      const card = document.querySelector('[data-pl-col="ready"] .pl-card');
      const lane = document.querySelector('[data-pl-lane]');
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      lane.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      lane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    } catch (e) { return 'erro: ' + e.message; }
  });
  await sleep(500);
  const afterDrag = await page.evaluate(() => document.querySelectorAll('.pl-item').length);
  rec('planejamento', 'drag do quadro pra lane adiciona o 2o item', dragOk === true && afterDrag === 2, 'itens=' + afterDrag + ' drag=' + dragOk);
  const lastPut = planningLog.filter((l) => l.method === 'PUT' && l.pathname === '/api/v3/planning/plan').pop();
  rec('planejamento', 'PUT do drag persistiu a ordem (B-1004, B-1006)',
    !!lastPut && lastPut.body.items.map((i) => i.batch_number).join(',') === 'B-1004,B-1006',
    lastPut ? lastPut.body.items.map((i) => i.batch_number).join(',') : 'sem PUT');

  // item livre (+ Adicionar) via prompt
  await page.evaluate(() => { window.prompt = () => 'Trocar bobina da impressora'; });
  await page.click('[data-pl-addcustom]');
  await sleep(500);
  const custom = await page.evaluate(() => [...document.querySelectorAll('.pl-item .t')].map((t) => t.textContent.trim()));
  rec('planejamento', 'item livre entra no fim do plano', custom.length === 3 && custom[2] === 'Trocar bobina da impressora', custom.join(' | '));

  // estagio AO VIVO re-derivado: item planejado que ja esta Pronto ganha chip
  const liveChips = await page.evaluate(() => [...document.querySelectorAll('.pl-item .kit-chip')].map((c) => c.textContent.trim()));
  rec('planejamento', 'itens do plano mostram o estagio ao vivo do quadro',
    liveChips.some((c) => /Esperando revisão/.test(c)) && liveChips.some((c) => /Pronto pra produção/.test(c)), liveChips.join(' | '));

  // anotacoes: digita e espera o autosave debounced (800ms) virar PUT /notes
  await page.click('[data-pl-notes] textarea');
  await page.type('[data-pl-notes] textarea', 'Amanha comecar pelo Charcoal');
  await sleep(1400);
  const notePut = planningLog.filter((l) => l.method === 'PUT' && l.pathname === '/api/v3/planning/notes').pop();
  rec('planejamento', 'anotacao autosalvou (PUT /notes com o texto)',
    !!notePut && /Charcoal/.test(notePut.body.body), notePut ? notePut.body.body : 'sem PUT');
  const saved = await page.evaluate(() => (document.querySelector('[data-pl-notes] .pl-empty') || {}).textContent || '');
  rec('planejamento', 'rodape mostra "Salvo HH:MM"', /Salvo/.test(saved), saved.trim());
  {
    const f = path.join(QA, 'planejamento-02.png');
    await page.screenshot({ path: f, fullPage: true });
    rec('screenshot', 'planejamento-02', fs.statSync(f).size / 1024 > 4, path.basename(f));
  }

  // #roadmap: verificacao (ja estava no kit)
  await go('roadmap');
  await page.waitForSelector('.rm-root', { timeout: 9000 }).catch(() => {});
  const rmOk = await page.evaluate(() => {
    const h1 = document.querySelector('.rm-h1');
    return h1 ? { family: getComputedStyle(h1).fontFamily, em: h1.querySelectorAll('em').length } : null;
  });
  rec('roadmap', 'h1 DM Serif com 1 <em> (ja era kit)',
      !!rmOk && /DM Serif Display/i.test(rmOk.family) && rmOk.em === 1,
      rmOk ? rmOk.family + ' em=' + rmOk.em : 'sem .rm-h1');

  await browser.close();
  server.close();

  const fails = results.filter((r) => !r.pass);
  console.log('\n' + '─'.repeat(60));
  console.log(results.length - fails.length + ' PASS  ·  ' + fails.length + ' FAIL');
  fs.writeFileSync(path.join(QA, 'qa-dashboard-operacao-report.json'),
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (fails.length) { fails.forEach((f) => console.log('  FAIL [' + f.group + '] ' + f.name + '  ' + f.detail)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
