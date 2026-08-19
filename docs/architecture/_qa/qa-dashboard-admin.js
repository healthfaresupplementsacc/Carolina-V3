'use strict';
/**
 * QA harness do GRUPO C do dashboard-v4 (Admin, Operadores, Usuarios, Sistema,
 * Impressao, Cameras) — copia do qa-dashboard.js com fixtures proprias, pra nao
 * disputar o harness compartilhado com os outros agentes.
 *
 * Rodar da RAIZ do projeto:  node docs/architecture/_qa/qa-dashboard-admin.js
 *
 * O que faz:
 *   1. sobe um servidor http estatico servindo `public/` (o build ja tem que
 *      existir: rode `node node_modules/vite/bin/vite.js build` em dashboard-v4);
 *   2. INTERCEPTA toda requisicao pra /api/** e responde das fixtures
 *      docs/architecture/_qa/fixtures/admC-*.json — NUNCA fala com servidor
 *      nem banco;
 *   3. injeta sessionStorage v3pin + v3login (functions ['*']) e o cache do
 *      admin (hf-admin-me) antes do bundle, pra pular o form de login;
 *   4. abre cada rota, tira screenshot em docs/architecture/_qa/theme-C-*.png e
 *      roda as assercoes (sem erro de console + H1 DM Serif com <em>);
 *   5. imprime PASS/FAIL e sai com 1 se algo falhar.
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

// ── fixtures NOVAS do grupo C (nao toca nas existentes) ───────────
const AP = readFix('admC-adminpanel.json');   // /api/adminpanel/*
const DT = readFix('admC-data.json');         // /api/v3/data/{rbac,system-health,printers}
const CAM = readFix('admC-cam.json');         // /api/cam/*

const LOGIN = { name: 'QA Admin', role: 'admin', functions: ['*'] };

/** /api/adminpanel/** — o cliente admin-api.js espera o objeto CRU (sem {data}). */
function adminFixture(pathname, search) {
  const p = pathname.slice('/api/adminpanel'.length);
  if (p === '/auth/login')  return { admin: AP.me };
  if (p === '/auth/logout') return { ok: true };
  if (p === '/auth/me')     return { admin: AP.me };

  if (p === '/metrics/realtime')        return AP.metrics_realtime;
  if (p === '/metrics/production-line') return AP.metrics_production_line;
  if (p === '/metrics/anomalies')       return AP.metrics_anomalies;
  if (p === '/metrics/rankings')        return AP.metrics_rankings;
  if (p === '/analytics/summary')       return AP.analytics_summary;
  if (p === '/gaps')                    return AP.gaps;
  if (p === '/action-log')              return AP.action_log;
  if (p === '/ems-activity')            return AP.ems_activity;
  if (p === '/voice/recent')            return AP.voice_recent;
  if (p === '/activity-types')          return AP.activity_types;
  if (p === '/operators')               return AP.operators;
  if (/^\/operators\/\d+\/schedule$/.test(p)) return AP.operator_schedule;
  if (/^\/operators\/\d+\/events$/.test(p))   return AP.operator_events;
  return { ok: true };
}

/** Resposta pra qualquer /api/**. */
function apiFixture(pathname, search) {
  if (pathname.startsWith('/api/adminpanel')) return adminFixture(pathname, search);

  // /api/cam/* — a sessao devolve o token cru; health idem.
  if (pathname === '/api/cam/session') return CAM.session;
  if (pathname === '/api/cam/health')  return CAM.health;

  // /api/v3/data/* — envelope { data: ... } (contrato do from-api.js)
  if (pathname === '/api/v3/data/login')         return { data: LOGIN };
  if (pathname === '/api/v3/data/health')        return { data: { worker: { alive: true }, queue: 0, mode: 'qa' } };
  if (pathname === '/api/v3/data/rbac')          return { data: DT.rbac };
  if (pathname === '/api/v3/data/system-health') return { data: DT.system_health };
  if (pathname === '/api/v3/data/printers')      return { data: DT.printers };
  if (pathname === '/api/v3/data/search')        return { data: [] };
  if (pathname === '/api/v3/data/incidents')     return { data: [] };
  if (pathname === '/api/v3/data/timeline')      return { data: { events: [], operators: [], gaps: [] } };
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

  // Erros externos (fontes do Google) sao bloqueados DE PROPOSITO pelo harness.
  // O <video>/<img> das cameras e o EventSource do spooler tambem morrem aqui
  // porque nao ha gateway nem SSE nas fixtures — sao ruido do harness, nao bug.
  const EXTERNAL = /fonts\.(googleapis|gstatic)\.com|Failed to load resource/i;
  const HARNESS_NOISE = /\/api\/cam\/|print-stream|Empty src|MEDIA_ELEMENT/i;
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (EXTERNAL.test(t) || HARNESS_NOISE.test(t)) return;
    consoleErrors.push('console.error: ' + t.slice(0, 300));
  });
  page.on('requestfailed', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:' + port)) return;   // externo: bloqueio proposital
    if (HARNESS_NOISE.test(r.url())) return;                       // stream de camera/SSE sem backend
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
      // stream de video da camera e o SSE do spooler: nao existem no harness.
      if (/^\/api\/cam\/[^/]+(\/mp4)?$/.test(u.pathname) && u.pathname !== '/api/cam/health' && u.pathname !== '/api/cam/session') {
        req.abort(); return;
      }
      if (u.pathname === '/api/v3/data/print-stream') { req.abort(); return; }
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

  // sessao autenticada: PIN do dashboard + cache do admin (pula o form)
  await page.evaluateOnNewDocument((login, me, camTok) => {
    try {
      sessionStorage.setItem('v3pin', '0000');
      sessionStorage.setItem('v3login', JSON.stringify(login));
      sessionStorage.setItem('hf-admin-me', JSON.stringify(me));
      sessionStorage.setItem('hf-tweaks', JSON.stringify({ theme: 'light' }));
      localStorage.setItem('hf_cam_tok', camTok);
    } catch (e) { /* ignore */ }
  }, LOGIN, AP.me, CAM.session.token);

  const shot = async (name) => {
    const f = path.join(QA, 'theme-C-' + name + '.png');
    await page.screenshot({ path: f, fullPage: true });
    const kb = Math.round(fs.statSync(f).size / 1024);
    rec('screenshot', name, kb > 5, kb + ' KB → ' + path.basename(f));
  };

  async function go(hash) {
    await page.goto('about:blank');
    await page.goto(BASE + '#' + hash, { waitUntil: 'networkidle0' }).catch(() => {});
    await sleep(700);
    consoleErrors.length = 0;
    await sleep(700);      // janela de observacao em regime
  }

  /* Regra do STYLE-KIT: toda pagina abre com eyebrow + H1 DM Serif contendo
     UMA palavra italica verde (<em>). Confere a fonte computada tambem. */
  async function assertKitHeader(group) {
    const h = await page.evaluate(() => {
      const h1 = document.querySelector('.kit-h1');
      if (!h1) return null;
      const em = h1.querySelector('em');
      const cs = getComputedStyle(h1);
      const eyebrow = document.querySelector('.kit-eyebrow');
      return {
        text: h1.textContent.trim(), em: em ? em.textContent.trim() : null,
        font: cs.fontFamily, eyebrow: !!eyebrow,
      };
    });
    rec(group, 'H1 do kit existe', !!h, h ? h.text.slice(0, 60) : 'sem .kit-h1');
    rec(group, 'H1 usa DM Serif Display', !!h && /DM Serif Display/i.test(h.font), h ? h.font : '');
    rec(group, 'H1 tem uma palavra em <em>', !!h && !!h.em, h && h.em ? h.em : 'sem <em>');
    rec(group, 'eyebrow presente', !!h && h.eyebrow);
  }

  /* Nada de classes do tema ANTIGO sobrando nas paginas do grupo. */
  async function assertNoLegacyChrome(group) {
    const n = await page.evaluate(() => {
      const scope = document.querySelector('.main') || document.body;
      return scope.querySelectorAll('.card, .btn, .pill, .filter-chip, .drill-table, .kpi-grid').length;
    });
    rec(group, 'sem classes do tema antigo (.card/.btn/.pill/.filter-chip)', n === 0, 'restam=' + n);
  }

  // ══ #admin ════════════════════════════════════════════════════
  await go('admin');
  await page.waitForSelector('[data-tabs="admin"]', { timeout: 10000 }).catch(() => {});
  await shot('admin');
  rec('admin', 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  await assertKitHeader('admin');
  await assertNoLegacyChrome('admin');
  const nOps = await page.$$eval('[data-table="realtime-ops"] tbody tr', (e) => e.length).catch(() => 0);
  rec('admin', 'aba Hoje lista os 4 operadores logados', nOps === 4, 'linhas=' + nOps);
  const segOn = await page.$$eval('.kit-seg button.on', (e) => e.map((x) => x.textContent.trim()));
  rec('admin', 'sub-nav e um kit-seg com aba ativa', segOn.length === 1 && segOn[0] === 'Hoje', segOn.join(','));

  // aba Metricas → Linha de Producao (exceptions em card warn)
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.kit-seg button')].find((x) => x.textContent.trim() === 'Métricas');
    if (b) b.click();
  });
  await sleep(900);
  const warnCards = await page.$$eval('.kit-card.warn', (e) => e.length);
  rec('admin', 'excecoes aparecem em kit-card warn', warnCards >= 1, 'cards warn=' + warnCards);
  await shot('admin-metricas');

  // aba Analytics (barras proporcionais do kit)
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.kit-seg button')].find((x) => x.textContent.trim() === 'Analytics');
    if (b) b.click();
  });
  await sleep(900);
  const bars = await page.$$eval('.adm-bar-fill', (e) => e.length);
  rec('admin', 'Analytics desenha as barras do kit', bars >= 4, 'barras=' + bars);
  await shot('admin-analytics');

  // ══ #operadores ═══════════════════════════════════════════════
  await go('operadores');
  await page.waitForSelector('[data-list="operadores"]', { timeout: 10000 }).catch(() => {});
  await shot('operadores');
  rec('operadores', 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  await assertKitHeader('operadores');
  await assertNoLegacyChrome('operadores');
  const nCards = await page.$$eval('[data-list="operadores"] > .kit-card', (e) => e.length).catch(() => 0);
  rec('operadores', 'lista os 5 operadores da fixture', nCards === 5, 'cards=' + nCards);
  const chips = await page.$$eval('[data-list="operadores"] .kit-chip', (e) => e.map((x) => x.textContent.trim()));
  rec('operadores', 'chips de estado ativo/inativo', chips.includes('ativo') && chips.includes('inativo'), chips.join(','));

  // abre o painel Gerenciar do primeiro operador + a escala
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-list="operadores"] .kit-btn')].find((x) => x.textContent.trim() === 'Gerenciar');
    if (b) b.click();
  });
  await sleep(500);
  const panel = await page.$('[data-panel="operador"]');
  rec('operadores', 'painel Gerenciar abre', !!panel);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-panel="operador"] .kit-btn')].find((x) => /Editar escala/.test(x.textContent));
    if (b) b.click();
  });
  await sleep(700);
  const timeInputs = await page.$$eval('[data-panel="operador"] input[type="time"]', (e) => e.length).catch(() => 0);
  rec('operadores', 'editor de escala com 14 campos de hora (7 dias)', timeInputs === 14, 'inputs=' + timeInputs);
  await shot('operadores-escala');

  // ══ #usuarios ═════════════════════════════════════════════════
  await go('usuarios');
  await page.waitForSelector('[data-table="permissoes"]', { timeout: 10000 }).catch(() => {});
  await shot('usuarios');
  rec('usuarios', 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  await assertKitHeader('usuarios');
  await assertNoLegacyChrome('usuarios');
  const nLogins = await page.$$eval('[data-table="logins"] tbody tr', (e) => e.length).catch(() => 0);
  rec('usuarios', 'tabela de logins com 3 linhas', nLogins === 3, 'linhas=' + nLogins);
  const nBoxes = await page.$$eval('[data-table="permissoes"] input[type="checkbox"]', (e) => e.length).catch(() => 0);
  rec('usuarios', 'matriz 11 funcoes x 3 cargos = 33 checkboxes', nBoxes === 33, 'checkboxes=' + nBoxes);
  const adminLocked = await page.$$eval('[data-table="permissoes"] input[type="checkbox"]',
    (e) => e.filter((x) => x.disabled).length);
  rec('usuarios', 'coluna Admin fica travada (sempre tem tudo)', adminLocked === 11, 'travados=' + adminLocked);

  // ══ #sistema ══════════════════════════════════════════════════
  await go('sistema');
  await page.waitForSelector('[data-table="processos"]', { timeout: 10000 }).catch(() => {});
  await shot('sistema');
  rec('sistema', 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  await assertKitHeader('sistema');
  await assertNoLegacyChrome('sistema');
  const nProcs = await page.$$eval('[data-proc]', (e) => e.length).catch(() => 0);
  rec('sistema', 'registro lista os 12 processos', nProcs === 12, 'linhas=' + nProcs);
  const tones = await page.$$eval('[data-table="processos"] .kit-chip', (e) => e.map((x) => x.className));
  rec('sistema', 'estados usam chips tonais ok/warn/bad',
      tones.some((c) => /ok/.test(c)) && tones.some((c) => /warn/.test(c)) && tones.some((c) => /bad/.test(c)),
      tones.slice(0, 5).join(' | '));
  const critWarn = await page.$$eval('.kit-card.bad', (e) => e.length);
  rec('sistema', 'aviso de critico parado em kit-card bad', critWarn >= 1, 'cards bad=' + critWarn);
  // clique abre o detalhe do processo
  await page.click('[data-proc="worker_main"]');
  await sleep(400);
  const detail = await page.$('.sys-detail');
  rec('sistema', 'clique na linha abre o detalhe', !!detail);
  await shot('sistema-detalhe');

  // ══ #impressao ════════════════════════════════════════════════
  await go('impressao');
  await page.waitForSelector('[data-list="impressoras"]', { timeout: 10000 }).catch(() => {});
  await shot('impressao');
  rec('impressao', 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  await assertKitHeader('impressao');
  await assertNoLegacyChrome('impressao');
  const nPrinters = await page.$$eval('[data-list="impressoras"] > .kit-card', (e) => e.length).catch(() => 0);
  rec('impressao', '3 cards de impressora', nPrinters === 3, 'cards=' + nPrinters);
  const inkBars = await page.$$eval('.ink-fill', (e) => e.length).catch(() => 0);
  rec('impressao', 'barras de tinta CMYK + caixa de manutencao (5)', inkBars === 5, 'barras=' + inkBars);
  const inc = await page.$$eval('[data-list="incidentes"] > .kit-card.bad', (e) => e.length).catch(() => 0);
  rec('impressao', 'incidente aberto em kit-card bad', inc === 1, 'incidentes=' + inc);
  const nHist = await page.$$eval('[data-table="historico"] tbody tr', (e) => e.length).catch(() => 0);
  rec('impressao', 'historico com 4 impressoes', nHist === 4, 'linhas=' + nHist);
  const kpis = await page.$$eval('[data-kpis="impressao"] .adm-kpi .v', (e) => e.map((x) => x.textContent.replace(/\D/g, '')));
  rec('impressao', 'KPIs batem com a fixture (3860 labels, 14 jobs, 3 impressoras)',
      kpis[0] === '3860' && kpis[1] === '14' && kpis[2] === '3', kpis.join(','));

  // ══ #cameras ══════════════════════════════════════════════════
  await go('cameras');
  await page.waitForSelector('[data-bar="cameras"]', { timeout: 10000 }).catch(() => {});
  await sleep(900);
  await shot('cameras');
  rec('cameras', 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  await assertKitHeader('cameras');
  await assertNoLegacyChrome('cameras');
  const nCams = await page.$$eval('[data-cam]', (e) => e.length).catch(() => 0);
  rec('cameras', '3 tiles de camera', nCams === 3, 'tiles=' + nCams);
  const heads = await page.$$eval('.cam-head', (e) => e.length).catch(() => 0);
  rec('cameras', 'header do tile no chrome do kit', heads === 3, 'headers=' + heads);
  const stages = await page.$$eval('.cam-stage video, .cam-stage img', (e) => e.length).catch(() => 0);
  rec('cameras', 'mecanica do video preservada (elemento por tile)', stages === 3, 'players=' + stages);
  // minimizar/expandir continua funcionando (clique no header)
  await page.evaluate(() => { const h = document.querySelector('.cam-head'); if (h) h.click(); });
  await sleep(400);
  const stagesAfter = await page.$$eval('.cam-stage', (e) => e.length).catch(() => 0);
  rec('cameras', 'clique no header minimiza o tile', stagesAfter === 2, 'stages=' + stagesAfter);

  await browser.close();
  server.close();

  const fails = results.filter((r) => !r.pass);
  console.log('\n' + '─'.repeat(64));
  console.log(results.length - fails.length + ' PASS  ·  ' + fails.length + ' FAIL');
  fs.writeFileSync(path.join(QA, 'qa-dashboard-admin-report.json'),
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (fails.length) { fails.forEach((f) => console.log('  FAIL [' + f.group + '] ' + f.name + '  ' + f.detail)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
