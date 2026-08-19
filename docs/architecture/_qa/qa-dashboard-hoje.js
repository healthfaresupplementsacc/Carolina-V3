'use strict';
/**
 * QA harness da página HOJE (Bruno 08-19).
 * Rodar da RAIZ do projeto:  node docs/architecture/_qa/qa-dashboard-hoje.js
 *
 * Cobre os três pedidos do Bruno:
 *   1. PONTO no topbar — as pills "ao vivo · live" e "edição ativa · write"
 *      sumiram; no lugar entram os chips do ponto com botão de POWER, e o
 *      clique dispara o POST certo pra cada estado da pessoa.
 *   2. GRADE — 7 widgets, arrastar muda a posição, puxar o canto muda o
 *      tamanho, os dois sobrevivem ao F5; desligar Câmeras persiste;
 *      "Restaurar padrão" volta ao layout de fábrica.
 *   3. SEM GRADIENTE — nenhum elemento com background-clip:text nem gradiente
 *      em texto; as linhas do Resumo têm cor idêntica em todos os rótulos e
 *      idêntica em todos os valores.
 *
 * Mesmo padrão do qa-dashboard.js: servidor estático de public/ + TODA /api/**
 * respondida por fixture local. Nunca fala com servidor nem banco.
 */
const puppeteer = require('puppeteer');
const http = require('http');
const path = require('path');
const fs = require('fs');

const QA = __dirname;
const ROOT = path.join(QA, '..', '..', '..');
const PUBLIC = path.join(ROOT, 'public');

const results = [];
const rec = (group, name, pass, detail) => {
  results.push({ group, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? 'PASS ' : 'FAIL ') + '[' + group + '] ' + name + (detail ? '  ·  ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOGIN = { name: 'QA Admin', role: 'admin', functions: ['*'] };

// ── data de hoje em NY (a página busca sempre o dia de NY) ───────
const YMD = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const at = (h, m) => new Date(`${YMD}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`).toISOString();

/* PONTO: 4 pessoas cobrindo os 4 estados que o botão de power precisa tratar.
   Espelha o payload real de GET /api/v3/data/attendance (router.js:1786).
     Vitor    → dentro E logado no kiosk   → power deve DESLOGAR
     Simone   → em pausa, sem sessão       → power deve registrar SAÍDA
     Ana      → já saiu                    → power desativado
     Bruno S. → sem ponto hoje             → power desativado */
const ATTENDANCE = { data: { date: YMD, people: [
  { person_id: 4, name: 'Vitor Silva', clock_code: '8', state: 'in',
    checkin_at: at(8, 2), checkout_at: null, last_in_at: at(8, 2), break_sec: null,
    punches: [at(8, 2)], markers: [], breaks: [], no_clockin: false, logged_in: true, updated_at: at(8, 2) },
  { person_id: 5, name: 'Simone Amabile', clock_code: '10', state: 'break',
    checkin_at: at(8, 15), checkout_at: null, last_in_at: at(8, 15), break_sec: 900,
    punches: [at(8, 15), at(12, 0)], markers: [], breaks: [], no_clockin: false, logged_in: false, updated_at: at(12, 0) },
  { person_id: 6, name: 'Ana Kesya', clock_code: '39', state: 'out',
    checkin_at: at(8, 0), checkout_at: at(16, 30), last_in_at: null, break_sec: null,
    punches: [at(8, 0), at(16, 30)], markers: [], breaks: [], no_clockin: false, logged_in: false, updated_at: at(16, 30) },
  { person_id: 7, name: 'Bruno Santos', clock_code: '38', state: 'out',
    checkin_at: null, checkout_at: null, last_in_at: null, break_sec: null,
    punches: [], markers: [], breaks: [], no_clockin: false, logged_in: false, updated_at: null },
] } };

/** POSTs que a página fez, pra conferir que o power chamou o endpoint certo. */
const posted = [];

function apiFixture(pathname, search, method, body) {
  if (method === 'POST') posted.push({ pathname, body });

  if (pathname === '/api/v3/data/login') return { data: LOGIN };
  if (pathname === '/api/v3/data/health') return { data: { worker: { alive: true }, queue: 0, mode: 'qa' } };
  if (pathname === '/api/v3/data/attendance') return ATTENDANCE;

  // ações do botão de power
  if (/\/operator\/\d+\/logoff$/.test(pathname)) {
    return { data: { sessions_closed: [1], tasks_closed: [], clocked_out: true } };
  }
  if (/\/operator\/\d+\/checkout$/.test(pathname)) {
    return { data: { tasks_closed: [] } };
  }

  if (pathname === '/api/v3/data/timeline') {
    return { data: {
      events: [
        { id: 1, person_id: 4, person_name: 'Vitor Silva', activity_slug: 'production_line',
          started_at: at(8, 30), ended_at: at(11, 0), description: '', qty: 200 },
        { id: 2, person_id: 5, person_name: 'Simone Amabile', activity_slug: 'pnp',
          started_at: at(9, 0), ended_at: at(12, 0), description: '', qty: null },
        { id: 3, person_id: 4, person_name: 'Vitor Silva', activity_slug: 'cleaning_day',
          started_at: at(12, 30), ended_at: at(13, 15), description: 'limpeza da linha', qty: null },
      ],
      operators: [], gaps: [],
    } };
  }
  if (pathname === '/api/v3/data/production') {
    return { data: {
      total_bottles: 420,
      lotes: [{ product: 'HealthFare NAC', batch_number: 'BR-2026-0231', bottles: 420, total_seconds: 7200,
                bottles_per_min: 3.5, bottles_per_sec: 0.058 }],
      line: { union_seconds: 7200, span_seconds: 8100, person_seconds: 9000, bottles_per_min: 3.5, sec_per_bottle: 17.1, event_count: 3 },
      flow_total: { person_seconds: 12000, bottles_per_min: 2.1, sec_per_bottle: 28.6,
                    by_phase: [{ slug: 'production_line', name: 'Linha', seconds: 7200 },
                               { slug: 'review', name: 'Revisão', seconds: 2400 }] },
    } };
  }
  if (pathname === '/api/v3/data/pp') {
    return { data: { total_minutes: 143, orders: 34, seconds_per_order: 42,
      person_seconds: [{ person: 'Simone', seconds: 5400 }, { person: 'Ana', seconds: 3200 }],
      person_seconds_total: 8600, person_seconds_per_order: 253 } };
  }
  if (pathname === '/api/v3/data/fnsku') {
    return { data: { total_labels: 120, wall_seconds: 1800, labels_per_min: 4, sec_per_label: 15,
      person_seconds: [{ person: 'Ana', seconds: 1800 }], person_seconds_total: 1800, person_seconds_per_label: 15 } };
  }
  if (pathname === '/api/v3/data/veeqo-today') {
    return { data: { configured: true, total_orders: 30, total_units: 55,
      by_channel: [{ channel: 'ebay', orders: 12 }, { channel: 'tiktok', orders: 18 }],
      by_product: [{ sku: 'HF-NAC', product: 'HealthFare NAC 600mg', units: 35 },
                   { sku: 'HF-MAG', product: 'HealthFare Magnesium', units: 20 }] } };
  }
  if (pathname === '/api/v3/data/goals') {
    return { data: { goals: [
      { id: 1, product_id: 1, product: 'HealthFare NAC', batch: 'BR-2026-0231', target: 500, done: 420, unit: 'bottle', completed: false },
      { id: 2, product_id: 2, product: 'HealthFare Magnesium', batch: null, target: 200, done: 200, unit: 'bottle', completed: true },
    ] } };
  }
  if (pathname === '/api/v3/data/review-rate') {
    return { data: { n: 3, avg_capsules_per_sec: 4.2, avg_bottles_per_min: 2.1, avg_sec_per_bottle: 28,
      range_days: 30, products: [], runs: [],
      operators: [{ operator: 'Vitor', n: 2, avg_capsules_per_sec: 4.5, avg_bottles_per_min: 2.2, avg_sec_per_bottle: 27 }] } };
  }
  if (pathname === '/api/v3/data/deadlines') {
    return { data: { deadlines: [{ id: 1, label: 'Corte do correio', time_of_day: '13:00:00', active: true }] } };
  }
  if (pathname === '/api/v3/data/counts') return { data: { counts: [] } };
  if (pathname === '/api/v3/data/support') return { data: {} };
  if (pathname === '/api/v3/data/incidents') return { data: { incidents: [] } };
  if (pathname === '/api/v3/data/pending-totals') return { data: { pending: [] } };
  if (pathname === '/api/v3/data/batches') return { data: { active: [] } };
  if (pathname === '/api/v3/data/cameras') return { data: { cameras: [] } };
  if (pathname.startsWith('/api/v3/data/catalog/')) {
    const k = pathname.split('/').pop();
    if (k === 'persons') {
      return { data: { persons: [
        { id: 4, display_name: 'Vitor Silva', role: 'operator', active: true },
        { id: 5, display_name: 'Simone Amabile', role: 'operator', active: true },
        { id: 6, display_name: 'Ana Kesya', role: 'operator', active: true },
      ] } };
    }
    if (k === 'activity-types') {
      return { data: { activity_types: [
        { id: 1, slug: 'production_line', name: 'Linha de produção', flow: 'production' },
        { id: 2, slug: 'pnp', name: 'Pick & Pack', flow: 'pnp' },
        { id: 3, slug: 'cleaning_day', name: 'Limpeza do dia', flow: 'support' },
      ] } };
    }
    return { data: { products: [{ id: 1, canonical_name: 'HealthFare NAC' }] } };
  }
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
        let payload = null;
        try { payload = req.postData() ? JSON.parse(req.postData()) : null; } catch (e) { payload = req.postData(); }
        req.respond({
          status: 200, contentType: 'application/json',
          body: JSON.stringify(apiFixture(u.pathname, u.search, req.method(), payload)),
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
    // window.confirm/prompt travam o headless: respondem OK sozinhos.
    // O alert de retorno também, senão o clique no power nunca termina.
    window.confirm = () => true;
    window.prompt = () => '';
    window.alert = () => {};
  }, LOGIN);

  const shot = async (name) => {
    const f = path.join(QA, 'hoje-' + name + '.png');
    await page.screenshot({ path: f });
    const kb = Math.round(fs.statSync(f).size / 1024);
    rec('screenshot', name, kb < 4096, kb + ' KB → ' + path.basename(f));
  };

  async function go(hash, opts) {
    await page.goto('about:blank');
    if (opts && opts.clearLayout) {
      await page.evaluateOnNewDocument(() => { try { localStorage.removeItem('hf-hoje-layout-v2'); localStorage.removeItem('hf-widgets-v1'); } catch (e) {} });
    }
    await page.goto(BASE + '#' + hash, { waitUntil: 'networkidle0' });
    await sleep(700);
    consoleErrors.length = 0;
    await sleep(600);
  }

  // ══ 0. carrega a Hoje do zero ═════════════════════════════════
  await page.goto(BASE + '#hoje', { waitUntil: 'networkidle0' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await go('hoje');
  await page.waitForSelector('[data-widget-grid]', { timeout: 10000 }).catch(() => {});
  await sleep(600);
  const fit = await page.evaluate(() => {
    const g = document.querySelector('[data-widget-grid]');
    const gr = g.getBoundingClientRect();
    const items = [...g.querySelectorAll('[data-widget]')].map((x) => {
      const r = x.getBoundingClientRect();
      return { id: x.dataset.widget, right: Math.round(r.right), w: Math.round(r.width) };
    });
    return { gridRight: Math.round(gr.right), gridW: Math.round(gr.width), items };
  });
  rec('grade', 'nenhum widget passa da borda direita da area',
      fit.items.every((i) => i.right <= fit.gridRight + 1),
      'grade termina em ' + fit.gridRight + ' | ' + fit.items.map((i) => i.id + ':' + i.right).join(' '));
  await shot('01-inicial');
  rec('hoje', 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  // ══ 1. TOPBAR: pills fora, ponto dentro ═══════════════════════
  const topbarTxt = await page.$eval('.topbar', (e) => e.textContent.replace(/\s+/g, ' '));
  rec('topbar', 'pill "ao vivo · live" removida', !/ao vivo/i.test(topbarTxt), topbarTxt.slice(0, 120));
  rec('topbar', 'pill "edição ativa · write" removida', !/edição ativa/i.test(topbarTxt), topbarTxt.slice(0, 120));

  const strip = await page.$('.topbar [data-ponto-strip]');
  rec('topbar', 'faixa do Ponto está no topbar', !!strip);

  const chips = await page.$$eval('.topbar [data-ponto-person]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  rec('ponto', 'um chip por pessoa do /attendance (4)', chips.length === 4, JSON.stringify(chips));
  // textContent cola os spans sem espaço: "Vitor" + "entrou 08:02"
  rec('ponto', 'chip traz primeiro nome e a hora de entrada',
      /^Vitorentrou \d{2}:\d{2}$/.test(chips[0] || ''), chips[0]);
  rec('ponto', 'quem não bateu aparece como "sem ponto hoje"',
      /^Brunosem ponto hoje$/.test(chips[3] || ''), chips[3]);

  const powers = await page.$$eval('.topbar [data-ponto-power]', (els) => els.map((e) => ({
    id: e.getAttribute('data-ponto-power'),
    action: e.getAttribute('data-ponto-action'),
    title: e.getAttribute('title'),
    disabled: e.disabled,
    round: getComputedStyle(e).borderRadius,
    svg: !!e.querySelector('svg'),
  })));
  rec('ponto', 'N botões de power (um por pessoa)', powers.length === 4, 'botões=' + powers.length);
  rec('ponto', 'botão é redondo e tem ícone svg de power',
      powers.every((p) => p.svg) && powers.every((p) => /50%|9999px|999px/.test(p.round)),
      JSON.stringify(powers.map((p) => p.round)));
  rec('ponto', 'título diz que desloga do kiosk e registra a saída',
      /^Deslogar Vitor Silva do kiosk \(encerra a sessão e registra a saída\)$/.test(powers[0].title),
      powers[0].title);
  rec('ponto', 'quem tem sessão aberta → ação logoff; sem sessão e dia aberto → checkout',
      powers[0].action === 'logoff' && powers[1].action === 'checkout',
      JSON.stringify(powers.map((p) => p.id + ':' + p.action)));
  rec('ponto', 'quem já saiu / não bateu fica com o power desativado',
      powers[2].disabled === true && powers[3].disabled === true,
      JSON.stringify(powers.map((p) => p.id + ':' + p.disabled)));

  // clique no power do Vitor (logado) → POST /operator/4/logoff
  posted.length = 0;
  await page.click('.topbar [data-ponto-power="4"]');
  await sleep(900);
  const gotLogoff = posted.find((p) => /\/operator\/4\/logoff$/.test(p.pathname));
  rec('ponto', 'clicar no power de quem está logado chama POST /operator/4/logoff',
      !!gotLogoff, JSON.stringify(posted.map((p) => p.pathname)));

  // clique no power da Simone (sem sessão, dia aberto) → POST /operator/5/checkout
  posted.length = 0;
  await page.click('.topbar [data-ponto-power="5"]');
  await sleep(900);
  const gotCheckout = posted.find((p) => /\/operator\/5\/checkout$/.test(p.pathname));
  rec('ponto', 'clicar no power de quem não tem sessão chama POST /operator/5/checkout',
      !!gotCheckout, JSON.stringify(posted.map((p) => p.pathname)));

  // a faixa NÃO pode aparecer em outra página
  await go('producao');
  const stripElsewhere = await page.$('[data-ponto-strip]');
  rec('ponto', 'faixa do Ponto não aparece fora da Hoje', !stripElsewhere);
  rec('producao', 'outra rota segue sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  await go('hoje');
  await page.waitForSelector('[data-widget-grid]', { timeout: 10000 }).catch(() => {});

  // ══ 2. GRADE: 7 widgets, drag, resize, toggle, restaurar ══════
  const widgets = await page.$$eval('[data-widget-grid] [data-widget]', (els) => els.map((e) => e.getAttribute('data-widget')));
  const WANT = ['producao', 'revisao', 'metas', 'pp', 'pedidos', 'fnsku', 'cameras'];
  rec('grade', 'a grade renderiza os 7 widgets',
      widgets.length === 7 && WANT.every((w) => widgets.includes(w)), widgets.join(','));

  const handles = await page.$$eval('[data-widget-grid] [data-widget-handle]', (e) => e.length);
  const resizers = await page.$$eval('[data-widget-grid] [data-widget-resize]', (e) => e.length);
  rec('grade', 'cada widget tem alça de arraste e canto de resize',
      handles === 7 && resizers === 7, 'alças=' + handles + ' cantos=' + resizers);
  await shot('02-grade');

  const posOf = (id) => page.$eval(`[data-widget="${id}"]`, (e) => ({
    x: +e.getAttribute('data-x'), y: +e.getAttribute('data-y'),
    w: +e.getAttribute('data-w'), h: +e.getAttribute('data-h'),
  }));

  /* ── DRAG: arrasta "Produção hoje" pra direita com pointer events.
     Move ~2 colunas: o widget tem 3 de largura, então x sai de 0. */
  const before = await posOf('producao');
  const hb = await page.$eval('[data-widget="producao"] [data-widget-handle]', (e) => {
    const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const colPx = await page.$eval('[data-widget-grid]', (e) => (e.clientWidth - 14 * 11) / 12);
  await page.mouse.move(hb.x, hb.y);
  await page.mouse.down();
  await page.mouse.move(hb.x + colPx * 2 + 28, hb.y, { steps: 12 });
  await sleep(250);
  const ghost = await page.$('[data-widget-ghost]');
  rec('grade', 'aparece o placeholder ao vivo enquanto arrasta', !!ghost);
  await page.mouse.up();
  await sleep(500);
  const afterDrag = await posOf('producao');
  rec('grade', 'arrastar muda a posição do widget',
      afterDrag.x !== before.x, `x ${before.x} → ${afterDrag.x}`);
  await shot('03-arrastado');

  // persiste no localStorage e sobrevive ao reload
  const stored = await page.evaluate(() => localStorage.getItem('hf-hoje-layout-v2'));
  rec('grade', 'layout gravado em hf-hoje-layout-v2', !!stored && /"grid"/.test(stored), String(stored).slice(0, 80));
  await go('hoje');
  await page.waitForSelector('[data-widget="producao"]', { timeout: 8000 }).catch(() => {});
  const afterReload = await posOf('producao');
  rec('grade', 'a posição arrastada sobrevive ao reload',
      afterReload.x === afterDrag.x && afterReload.y === afterDrag.y,
      JSON.stringify({ afterDrag, afterReload }));

  /* ── RESIZE: puxa o canto do "Metas em curso" ── */
  const sizeBefore = await posOf('metas');
  const rb = await page.$eval('[data-widget="metas"] [data-widget-resize]', (e) => {
    const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(rb.x, rb.y);
  await page.mouse.down();
  await page.mouse.move(rb.x + colPx + 20, rb.y + 70 + 14, { steps: 12 });
  await page.mouse.up();
  await sleep(500);
  const sizeAfter = await posOf('metas');
  rec('grade', 'puxar o canto muda largura e altura',
      sizeAfter.w > sizeBefore.w && sizeAfter.h > sizeBefore.h,
      JSON.stringify({ de: sizeBefore, para: sizeAfter }));
  await shot('04-redimensionado');

  await go('hoje');
  await page.waitForSelector('[data-widget="metas"]', { timeout: 8000 }).catch(() => {});
  const sizeReload = await posOf('metas');
  rec('grade', 'o tamanho novo sobrevive ao reload',
      sizeReload.w === sizeAfter.w && sizeReload.h === sizeAfter.h,
      JSON.stringify({ sizeAfter, sizeReload }));

  /* ── TOGGLE das Câmeras no popover ── */
  const openWidgets = async () => {
    const opened = await page.$('[data-widgets-popover]');
    if (opened) return;
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Widgets');
      if (b) b.click();
    });
    await sleep(350);
  };
  await openWidgets();
  const popover = await page.$('[data-widgets-popover]');
  rec('widgets', 'popover de Widgets abre', !!popover);
  const hint = await page.$eval('[data-widgets-popover]', (e) => e.textContent.replace(/\s+/g, ' '));
  rec('widgets', 'popover traz a dica de arrastar e redimensionar',
      /Arraste pelo título\. Puxe o canto pra mudar o tamanho\./.test(hint), hint.slice(-90));
  rec('widgets', 'Câmeras tem toggle no popover', /Câmeras ao vivo/.test(hint));
  await shot('05-popover');

  await page.click('[data-widget-toggle="cameras"]');
  await sleep(500);
  const camGone = await page.$('[data-widget="cameras"]');
  rec('widgets', 'desligar Câmeras tira o widget da grade', !camGone);
  await go('hoje');
  await page.waitForSelector('[data-widget-grid]', { timeout: 8000 }).catch(() => {});
  const camStillGone = await page.$('[data-widget="cameras"]');
  rec('widgets', 'Câmeras desligada continua desligada depois do reload', !camStillGone);

  /* ── RESTAURAR PADRÃO ── */
  await openWidgets();
  await page.click('[data-widgets-reset]');
  await sleep(600);
  const restored = await page.$$eval('[data-widget-grid] [data-widget]', (els) => els.map((e) => ({
    id: e.getAttribute('data-widget'), x: +e.getAttribute('data-x'), y: +e.getAttribute('data-y'),
    w: +e.getAttribute('data-w'), h: +e.getAttribute('data-h'),
  })));
  const prod = restored.find((r) => r.id === 'producao');
  const cams = restored.find((r) => r.id === 'cameras');
  rec('widgets', 'Restaurar padrão traz os 7 widgets de volta', restored.length === 7, restored.map((r) => r.id).join(','));
  rec('widgets', 'padrão põe Produção em x=0,y=0 (3x4) e Câmeras em largura cheia',
      !!prod && prod.x === 0 && prod.y === 0 && prod.w === 3 && prod.h === 4 && !!cams && cams.w === 12,
      JSON.stringify({ prod, cams }));
  await shot('06-restaurado');

  /* ── blocos empilhados continuam embaixo ── */
  const stackTxt = await page.$eval('[data-page-op="hoje"]', (e) => e.textContent);
  rec('widgets', 'Filtros, Linha do Tempo e Resumo seguem na página',
      /Filtros/.test(stackTxt) && /Resumo do dia/.test(stackTxt), '');

  /* ── tablet: coluna única, sem arrastar ── */
  await page.setViewport({ width: 820, height: 1000 });
  await sleep(700);
  const narrow = await page.$eval('[data-widget-grid]', (e) => e.getAttribute('data-narrow'));
  rec('grade', 'abaixo de 900px empilha em coluna única e desliga o drag', narrow === '1', 'narrow=' + narrow);
  await page.setViewport({ width: 1600, height: 1100 });
  await sleep(700);

  // ══ 3. SEM GRADIENTE ══════════════════════════════════════════
  await go('hoje');
  await page.waitForSelector('[data-widget-grid]', { timeout: 8000 }).catch(() => {});

  const gradText = await page.evaluate(() => {
    const bad = [];
    for (const e of document.querySelectorAll('*')) {
      const cs = getComputedStyle(e);
      if (cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text') {
        bad.push({ tag: e.tagName, cls: String(e.className).slice(0, 40), why: 'background-clip:text' });
        continue;
      }
      // texto pintado por gradiente: fill transparente com background de gradiente
      const transparentFill = cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)' || cs.webkitTextFillColor === 'transparent';
      if (transparentFill && /gradient/.test(cs.backgroundImage) && e.textContent.trim()) {
        bad.push({ tag: e.tagName, cls: String(e.className).slice(0, 40), why: 'gradiente em texto' });
      }
    }
    return bad;
  });
  rec('gradiente', 'nenhum elemento usa background-clip:text nem gradiente em texto',
      gradText.length === 0, JSON.stringify(gradText.slice(0, 4)));

  const resumo = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.resumo-row')];
    if (!rows.length) return null;
    return rows.map((r) => {
      const l = r.querySelector('.resumo-label');
      const v = r.querySelector('.resumo-value');
      const cl = getComputedStyle(l), cv = getComputedStyle(v);
      return {
        t: l.textContent,
        labelColor: cl.color, labelOpacity: cl.opacity, labelWeight: cl.fontWeight,
        valueColor: cv.color, valueOpacity: cv.opacity, valueWeight: cv.fontWeight,
        rowOpacity: getComputedStyle(r).opacity,
        rowFilter: getComputedStyle(r).filter,
        rowBg: getComputedStyle(r).backgroundImage,
      };
    });
  });
  rec('gradiente', 'o Resumo do dia tem linhas', !!resumo && resumo.length >= 6, resumo ? resumo.length + ' linhas' : 'nenhuma');
  if (resumo && resumo.length) {
    const labels = new Set(resumo.map((r) => r.labelColor));
    const values = new Set(resumo.map((r) => r.valueColor));
    rec('gradiente', 'todos os rótulos do Resumo têm a MESMA cor',
        labels.size === 1, [...labels].join(' | '));
    rec('gradiente', 'todos os valores do Resumo têm a MESMA cor',
        values.size === 1, [...values].join(' | '));
    rec('gradiente', 'nenhuma linha do Resumo tem opacidade ou filtro próprio',
        resumo.every((r) => r.rowOpacity === '1' && r.rowFilter === 'none'
          && r.labelOpacity === '1' && r.valueOpacity === '1'),
        JSON.stringify(resumo.map((r) => r.rowOpacity + '/' + r.rowFilter).slice(0, 3)));
    rec('gradiente', 'nenhuma linha do Resumo tem fundo em gradiente',
        resumo.every((r) => !/gradient/.test(r.rowBg)), resumo[0].rowBg);
    rec('gradiente', 'rótulo e valor têm o mesmo peso (tinta sólida, sem degrade de antialias)',
        new Set(resumo.map((r) => r.labelWeight)).size === 1
        && new Set(resumo.map((r) => r.valueWeight)).size === 1,
        resumo[0].labelWeight + '/' + resumo[0].valueWeight);
  }

  rec('hoje', 'zero erro de console no fim', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();

  const fails = results.filter((r) => !r.pass);
  console.log('\n' + '─'.repeat(60));
  console.log(results.length - fails.length + ' PASS  ·  ' + fails.length + ' FAIL');
  fs.writeFileSync(path.join(QA, 'qa-dashboard-hoje-report.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (fails.length) { fails.forEach((f) => console.log('  FAIL [' + f.group + '] ' + f.name + '  ' + f.detail)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
