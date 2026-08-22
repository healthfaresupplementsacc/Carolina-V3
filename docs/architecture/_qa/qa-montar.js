'use strict';
/**
 * QA harness da página "Montar estoque" (#estoque-montar) — S15.43.
 *
 * Rodar da RAIZ do projeto:  node docs/architecture/_qa/qa-montar.js
 * (o build tem que existir: `node node_modules/vite/bin/vite.js build`
 *  dentro de dashboard-v4/)
 *
 * Mesmo método do qa-dashboard-phase3.js: servidor estático de public/,
 * TODA a API interceptada e respondida das fixtures (nunca fala com
 * servidor nem banco), sessionStorage com PIN + login '*'.
 *
 * Os contratos B..F do agente P são stubados EXATAMENTE na forma combinada:
 *   B GET  /warehouse/box-types            (spread_g, needs_recalibration)
 *   C POST /warehouse/box-types + /:id/calibrate (weights_g[] OU total+count)
 *   D POST /warehouse/count/compute        (qty/qty_min/qty_max/residual/
 *                                           confidence/recount_suggested;
 *                                           tara: explícita > caixa > tipo > bin)
 *   E POST /warehouse/load                 (porta única; idempotente por
 *                                           client_ref; devolve o produto
 *                                           atualizado + veeqo_match)
 *   F GET  /warehouse/load/progress        (o placar do cabeçalho)
 *
 * O que este harness prova:
 *   · cabeçalho de progresso com os números da fixture + aviso de re-pesagem
 *     (que NUNCA bloqueia: é chip dispensável, com link pro passo 2);
 *   · passo 1: tabela de pesos, filtro "sem peso", assistente Pesar com a
 *     conta ao vivo e o campo de gramas AUTOFOCADO (balança USB híbrida);
 *   · passo 2: criador de prateleiras em lote (reusado), catálogo de tipos
 *     de caixa, calibração nos DOIS modos (uma por uma / todas juntas) com
 *     preview ao vivo e veredito da variação;
 *   · passo 3: contagem lado a lado (mão OU peso, nunca força), faixa
 *     "dá 19 a 21", card âmbar de recontagem com as DUAS saídas, chip da
 *     Veeqo virando verde na resposta do load, atalhos production_direct e
 *     loose_fixed (nota obrigatória), client_ref uuid único por carga;
 *   · zero erro de console e zero travessão na tela.
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
const LOCATIONS = readFix('p3-locations.json');
const WEIGHTS = readFix('p3-weights.json');
const BOXTYPES = readFix('montar-box-types.json');
const PROGRESS = readFix('montar-progress.json');

/* caixas ganham o tipo (contrato A: stock_boxes.box_type_id). A BX-0030
   (id 24, SEM tara própria) é do tipo 2, o que varia 230 g: é ela que
   produz a faixa e o card de recontagem. */
const BOX_TYPE_OF = { 21: 1, 22: 1, 23: 2, 24: 2 };
LOCATIONS.data.boxes.forEach((b) => { b.box_type_id = BOX_TYPE_OF[b.id] || null; });

const LOGIN = { name: 'QA Admin', role: 'admin', functions: ['*'] };
const posted = [];

// ── estado dinâmico dos stubs ────────────────────────────────────
// tipos de caixa: cópia viva (create/calibrate mudam)
let TYPES = JSON.parse(JSON.stringify(BOXTYPES.data.types));
let TYPE_SEQ = 100;

// pesos por produto (contrato D usa; o POST weights/product também atualiza)
const UNITW = {};
WEIGHTS.data.products.forEach((w) => { if (w.unit_weight_g != null) UNITW[w.product_id] = Number(w.unit_weight_g); });

// totais por produto (contrato E: o load soma no balde do destino)
const TOT = {}; const VEEQO = {};
OVERVIEW.data.products.forEach((r) => {
  TOT[r.product_id] = { shelf: Number(r.shelf_qty) || 0, box: Number(r.box_qty) || 0, unplaced: Number(r.unplaced_qty) || 0 };
  VEEQO[r.product_id] = r.veeqo && r.veeqo.physical != null ? Number(r.veeqo.physical) : null;
});
const seenRefs = {};   // client_ref → resposta (idempotência do contrato E)

/** contrato D, a MESMA conta do combinado: tara explícita > tara da caixa >
 *  tara do tipo da caixa > tara da prateleira > 0; qty = max(0, ceil(net/
 *  unit − 0.15)); min/max com tara ± spread/2; recount quando a sobra passa
 *  de 0.35 OU a faixa abre 1+ garrafa OU não há peso da unidade. */
function computeStub(body) {
  const unit = UNITW[body.product_id] || null;
  let tare = 0; let spread = 0;
  const typeOf = (id) => TYPES.find((t) => t.id === Number(id));
  if (body.tare_g != null) { tare = Number(body.tare_g); }
  else if (body.box_id != null) {
    const bx = LOCATIONS.data.boxes.find((b) => b.id === Number(body.box_id));
    if (bx && bx.tare_g != null) { tare = Number(bx.tare_g); }
    else if (bx && bx.box_type_id != null) {
      const t = typeOf(bx.box_type_id);
      if (t && t.tare_g != null) { tare = Number(t.tare_g); spread = Number(t.spread_g) || 0; }
    }
  } else if (body.box_type_id != null) {
    const t = typeOf(body.box_type_id);
    if (t && t.tare_g != null) { tare = Number(t.tare_g); spread = Number(t.spread_g) || 0; }
  } else if (body.bin_id != null) {
    const b = LOCATIONS.data.bins.find((x) => x.id === Number(body.bin_id));
    if (b && b.tare_g != null) tare = Number(b.tare_g);
  }
  const gross = Number(body.gross_g) || 0;
  const net = Math.max(0, gross - tare);
  if (!unit) {
    return { data: { unit_weight_g: null, tare_g: tare, tare_spread_g: spread, net_g: net,
      qty: 0, qty_min: 0, qty_max: 0, residual_g: net, residual_fraction: 1,
      confidence: 'baixa', recount_suggested: true } };
  }
  const raw = net / unit;
  const qtyOf = (t) => Math.max(0, Math.ceil(Math.max(0, gross - t) / unit - 0.15));
  const qty = qtyOf(tare);
  const qty_max = qtyOf(tare - spread / 2);
  const qty_min = qtyOf(tare + spread / 2);
  const residual_g = net - qty * unit;
  const residual_fraction = Math.abs(raw - Math.round(raw));
  const recount = residual_fraction > 0.35 || (qty_max - qty_min) >= 1;
  const confidence = recount ? ((qty_max - qty_min) >= 2 ? 'baixa' : 'média')
    : (residual_fraction < 0.2 ? 'alta' : 'média');
  return { data: { unit_weight_g: unit, tare_g: tare, tare_spread_g: spread, net_g: net,
    qty, qty_min, qty_max, residual_g, residual_fraction,
    confidence, recount_suggested: recount } };
}

/** contrato E: soma no balde e devolve o produto atualizado. */
function loadStub(body) {
  const ref = String(body.client_ref || '');
  if (seenRefs[ref]) return seenRefs[ref];
  const t = TOT[body.product_id];
  if (!t) return { error: { code: 'not_found', message: 'produto não existe' } };
  const q = Number(body.qty) || 0;
  const kind = body.dest && body.dest.kind;
  if (kind === 'bin') t.shelf += q;
  else if (kind === 'box') t.box += q;
  else t.unplaced += q;
  const total = t.shelf + t.box + t.unplaced;
  const vq = VEEQO[body.product_id];
  const res = { data: { applied: true, product: {
    product_id: body.product_id, total, shelf_qty: t.shelf, box_qty: t.box,
    unplaced_qty: t.unplaced, veeqo_total: vq,
    veeqo_match: vq != null && total === vq,
  } } };
  seenRefs[ref] = res;
  return res;
}

function calibrateStub(id, body) {
  const t = TYPES.find((x) => x.id === Number(id));
  if (!t) return { error: { code: 'not_found', message: 'tipo não existe' } };
  let mean; let min; let max; let samples;
  if (Array.isArray(body.weights_g) && body.weights_g.length) {
    const ws = body.weights_g.map(Number);
    samples = ws.length;
    mean = ws.reduce((a, b) => a + b, 0) / ws.length;
    min = Math.min(...ws); max = Math.max(...ws);
  } else {
    samples = Number(body.count) || 0;
    mean = samples > 0 ? Number(body.total_g) / samples : 0;
    min = mean; max = mean;
  }
  t.tare_g = mean; t.tare_samples = samples; t.tare_min_g = min; t.tare_max_g = max;
  t.spread_g = max - min; t.last_calibrated_at = new Date().toISOString();
  t.needs_recalibration = false;
  return { data: { type: t, spread_g: t.spread_g } };
}

function apiFixture(pathname, search, method, body) {
  if (method === 'POST') posted.push({ pathname, body });

  if (pathname.startsWith('/api/v3/warehouse/')) {
    const p = pathname.slice('/api/v3/warehouse/'.length);
    if (p === 'overview') return OVERVIEW;
    if (p === 'locations') return LOCATIONS;
    if (p === 'weights') return WEIGHTS;
    if (p === 'box-types' && method === 'GET') return { data: { types: TYPES } };
    if (p === 'box-types' && method === 'POST') {
      const t = { id: ++TYPE_SEQ, name: body.name,
        length_cm: body.length_cm == null ? null : body.length_cm,
        width_cm: body.width_cm == null ? null : body.width_cm,
        height_cm: body.height_cm == null ? null : body.height_cm,
        tare_g: null, tare_samples: 0, tare_min_g: null, tare_max_g: null, spread_g: null,
        last_calibrated_at: null, needs_recalibration: true, active: true, boxes_count: 0 };
      TYPES.push(t);
      return { data: { type: t } };
    }
    const mCal = p.match(/^box-types\/(\d+)\/calibrate$/);
    if (mCal) return calibrateStub(mCal[1], body || {});
    if (p === 'count/compute') return computeStub(body || {});
    if (p === 'load') return loadStub(body || {});
    if (p === 'load/progress') return PROGRESS;
    if (p === 'locations/bins/bulk') {
      const list = (body && Array.isArray(body.bins)) ? body.bins : [];
      const skipped = list.slice(0, 2).map((b) => b.bin_code);
      return { data: { created: Math.max(0, list.length - skipped.length), skipped } };
    }
    if (p.startsWith('weights/product/')) {
      // o assistente Pesar do passo 1: guarda o peso pro compute usar também
      const id = Number(p.split('/')[2]);
      if (body && body.unit_weight_g != null) UNITW[id] = Number(body.unit_weight_g);
      else if (body && body.sample_gross_g && body.sample_count) {
        UNITW[id] = (Number(body.sample_gross_g) - (Number(body.sample_tare_g) || 0)) / Number(body.sample_count);
      }
      return { data: { ok: true } };
    }
    return { data: { ok: true } };
  }

  if (pathname === '/api/v3/data/login') return { data: LOGIN };
  if (pathname === '/api/v3/data/health') return { data: { worker: { alive: true }, queue: 0, mode: 'qa' } };
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const f = path.join(QA, 'montar-' + name + '.png');
    await page.screenshot({ path: f, fullPage: false });
    const kb = Math.round(fs.statSync(f).size / 1024);
    rec('screenshot', name, kb > 4 && kb < 3072, kb + ' KB → ' + path.basename(f));
  };
  const noErr = (group) => rec(group, 'sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  const txt = (sel) => page.$eval(sel, (e) => e.textContent).catch(() => '');

  // ══ 1. Página abre no passo 1 com o placar do mutirão ═════════
  await page.goto(BASE + '#estoque-montar', { waitUntil: 'networkidle0' });
  await sleep(900);
  consoleErrors.length = 0;
  await page.waitForSelector('[data-progress]', { timeout: 10000 }).catch(() => {});

  const prog = {};
  for (const k of ['produtos', 'pesos', 'bins', 'tipos', 'garrafas', 'batendo']) {
    prog[k] = await txt('[data-prog="' + k + '"]');
  }
  rec('header', 'placar com os números da fixture',
      prog.produtos === '8' && prog.pesos === '5' && prog.bins === '8' && prog.tipos === '3'
      && prog.garrafas === '763' && prog.batendo === '4', JSON.stringify(prog));
  const progTxt = await txt('[data-progress]');
  rec('header', 'placar fala a língua do hub (produtos · com peso · prateleiras · garrafas)',
      /produtos/.test(progTxt) && /com peso/.test(progTxt) && /prateleiras/.test(progTxt)
      && /tipos de caixa/.test(progTxt) && /batendo com a Veeqo/.test(progTxt));
  const recalib = await txt('[data-recalib-chip="1"]');
  rec('header', 'aviso "Precisamos re-pesar as caixas 20x20x20" (chip, nunca bloqueio)',
      /Precisamos re-pesar as caixas 20x20x20/.test(recalib), recalib.slice(0, 80));

  // ══ 2. Passo 1: tabela de pesos + filtro ══════════════════════
  await page.waitForSelector('[data-table="pesos"] tbody tr', { timeout: 8000 }).catch(() => {});
  const nRows = await page.$$eval('[data-table="pesos"] tbody [data-peso-row]', (e) => e.length);
  rec('passo1', 'tabela com os 8 produtos', nRows === 8, 'linhas=' + nRows);
  const nSem = await page.$$eval('[data-chip="sem-peso"]', (e) => e.length);
  rec('passo1', '3 produtos marcados "sem peso"', nSem === 3, 'chips=' + nSem);
  await page.click('[data-chip-peso="sem"]');
  await sleep(200);
  const nRowsSem = await page.$$eval('[data-table="pesos"] tbody [data-peso-row]', (e) => e.length);
  rec('passo1', 'filtro "sem peso" corta pra 3', nRowsSem === 3, 'linhas=' + nRowsSem);
  await shot('01');
  await page.click('[data-chip-peso="todos"]');
  await sleep(200);

  // ══ 3. Pesar: assistente com a conta ao vivo e autofoco híbrido ═
  await page.click('[data-act="pesar"][data-product="3"]');
  await page.waitForSelector('[data-modal="pesar"]', { timeout: 5000 }).catch(() => {});
  await sleep(300);
  const focusedGross = await page.evaluate(() => document.activeElement
    && document.activeElement.getAttribute('data-field') === 'gross');
  rec('pesar', 'campo do peso AUTOFOCADO (balança USB digita direto nele)', focusedGross === true);
  const hint = await txt('[data-modal="pesar"] [data-hint="balanca"]');
  rec('pesar', 'micro-dica da balança híbrida', /balança USB que digita sozinha/.test(hint), hint.slice(0, 80));
  await page.type('[data-modal="pesar"] [data-field="gross"]', '1150');
  await sleep(200);
  const unitPrev = await txt('[data-modal="pesar"] [data-preview="unit"]');
  rec('pesar', 'conta ao vivo: 1150 g por 10 garrafas = 115.00 g', unitPrev.trim() === '115.00 g', unitPrev);
  await shot('02');
  posted.length = 0;
  await page.click('[data-act="salvar-peso"]');
  await sleep(600);
  const wPost = posted.find((p) => p.pathname === '/api/v3/warehouse/weights/product/3');
  rec('pesar', 'salvar chama o endpoint de calibração que já existe',
      !!wPost && Number(wPost.body.sample_gross_g) === 1150 && Number(wPost.body.sample_count) === 10,
      wPost ? JSON.stringify(wPost.body) : 'sem post');
  noErr('passo1');

  // ══ 4. O aviso de re-pesagem LEVA pro passo 2 (e não bloqueia) ═
  await page.click('[data-recalib-chip="1"] [data-act="recalib-ir"]');
  await sleep(300);
  const inStep2 = await page.$('[data-step-body="2"]');
  rec('passo2', 'chip de re-pesagem leva pro passo 2', !!inStep2);
  rec('passo2', 'criador de várias prateleiras REUSADO está lá',
      !!(await page.$('[data-bulk="prateleiras"]')));
  const nTypes = await page.$$eval('[data-boxtypes] [data-boxtype]', (e) => e.length);
  rec('passo2', 'catálogo com os 3 tipos de caixa', nTypes === 3, 'cards=' + nTypes);
  const card1 = await txt('[data-boxtype="1"]');
  rec('passo2', 'tipo vencido tem o chip "precisa re-pesar"', /precisa re-pesar/.test(card1));
  const card2 = await txt('[data-boxtype="2"] [data-type-tare]');
  rec('passo2', 'tara com a variação real (1.040 g ± 115 g)', /± 115 g/.test(card2), card2.trim());
  await shot('03');

  // ══ 5. Calibrar tara, modo "pesei uma por uma" ════════════════
  await page.click('[data-act="calibrar-tipo"][data-type="1"]');
  await page.waitForSelector('[data-modal="calibrar-caixa"]', { timeout: 5000 }).catch(() => {});
  await page.type('[data-modal="calibrar-caixa"] [data-field="pesos"]', '780 785 779 790 778 781 786 779 784 780');
  await sleep(250);
  const calPrev = await txt('[data-modal="calibrar-caixa"] [data-cal-preview]');
  rec('calibrar', 'preview ao vivo: 10 caixas, média e variação',
      /10 caixas/.test(calPrev) && /782\.2/.test(calPrev) && /12 g/.test(calPrev), calPrev.trim());
  posted.length = 0;
  await page.click('[data-act="salvar-tara"]');
  await sleep(600);
  const calPost = posted.find((p) => /box-types\/1\/calibrate$/.test(p.pathname));
  rec('calibrar', 'POST calibrate com a lista de pesos (contrato C)',
      !!calPost && Array.isArray(calPost.body.weights_g) && calPost.body.weights_g.length === 10,
      calPost ? JSON.stringify(calPost.body).slice(0, 120) : 'sem post');
  const calRes = await txt('[data-cal-result]');
  rec('calibrar', 'resultado fala a frase inteira: tara 782 g, variação ±6 g entre 10 caixas',
      /tara 782 g/.test(calRes) && /±6 g/.test(calRes) && /entre 10 caixas/.test(calRes), calRes.slice(0, 120));
  const verdict1 = await txt('[data-cal-verdict]');
  rec('calibrar', 'veredito: variação pequena = dá pra confiar',
      /dá pra confiar no peso desse tipo/.test(verdict1), verdict1.trim());
  await shot('04');
  await page.click('[data-act="fechar-cal"]');
  await sleep(400);

  // ══ 6. Calibrar tara, modo "pesei todas juntas" ═══════════════
  await page.click('[data-act="calibrar-tipo"][data-type="3"]');
  await page.waitForSelector('[data-modal="calibrar-caixa"]', { timeout: 5000 }).catch(() => {});
  await page.click('[data-cal-mode="juntas"]');
  await sleep(150);
  await page.type('[data-modal="calibrar-caixa"] [data-field="total"]', '4500');
  const quantasVal = await page.$eval('[data-modal="calibrar-caixa"] [data-field="quantas"]', (e) => e.value);
  const prevJuntas = await txt('[data-modal="calibrar-caixa"] [data-cal-preview]');
  rec('calibrar', 'modo juntas: total + quantas (10 já sugerido) e média ao vivo',
      quantasVal === '10' && /450\.0 g por caixa/.test(prevJuntas), 'quantas=' + quantasVal + ' · ' + prevJuntas.trim());
  posted.length = 0;
  await page.click('[data-act="salvar-tara"]');
  await sleep(600);
  const calPost3 = posted.find((p) => /box-types\/3\/calibrate$/.test(p.pathname));
  rec('calibrar', 'POST calibrate com {total_g, count} (contrato C, forma 2)',
      !!calPost3 && Number(calPost3.body.total_g) === 4500 && Number(calPost3.body.count) === 10,
      calPost3 ? JSON.stringify(calPost3.body) : 'sem post');
  const calRes3 = await txt('[data-cal-result]');
  rec('calibrar', 'todas juntas: min=max=média, variação ±0',
      /tara 450 g/.test(calRes3) && /±0 g/.test(calRes3), calRes3.slice(0, 100));
  await page.click('[data-act="fechar-cal"]');
  await sleep(400);

  // ══ 7. Novo tipo + caixa com tipo ═════════════════════════════
  posted.length = 0;
  await page.type('[data-form="novo-tipo"] [data-field="type-name"]', '40x30x20');
  await page.click('[data-act="criar-tipo"]');
  await sleep(600);
  const tPost = posted.find((p) => p.pathname === '/api/v3/warehouse/box-types');
  rec('passo2', 'Novo tipo chama POST box-types com o nome',
      !!tPost && tPost.body.name === '40x30x20', tPost ? JSON.stringify(tPost.body) : 'sem post');
  posted.length = 0;
  await page.type('[data-form="nova-caixa"] [data-field="box-number"]', 'BX-0100');
  await page.select('[data-form="nova-caixa"] [data-field="box-type"]', '1');
  await page.click('[data-act="criar-caixa"]');
  await sleep(600);
  const bxPost = posted.find((p) => p.pathname === '/api/v3/warehouse/locations/box');
  rec('passo2', 'caixa nova nasce com o tipo (box_type_id)',
      !!bxPost && Number(bxPost.body.box_type_id) === 1 && bxPost.body.box_number === 'BX-0100',
      bxPost ? JSON.stringify(bxPost.body) : 'sem post');
  noErr('passo2');

  // ══ 8. Passo 3: escolher, contar na mão, chip da Veeqo vira ═══
  await page.click('[data-step="3"]');
  await sleep(400);
  rec('passo3', 'sem produto escolhido a tela ensina o próximo passo',
      !!(await page.$('[data-empty="sem-produto"]')));
  const missing = await page.$$eval('[data-missing-list] [data-pick]', (e) => e.map((x) => x.getAttribute('data-pick')));
  rec('passo3', '"Faltam acertar" lista os 2 fora da Veeqo, maior alvo primeiro',
      missing.length === 2 && missing[0] === '1' && missing[1] === '8', missing.join(','));
  await page.click('[data-missing-list] [data-pick="8"]');
  await sleep(300);
  const cardV = await txt('[data-card-veeqo]');
  const cardT = await txt('[data-card-total]');
  const chip0 = await txt('[data-veeqo-chip="delta"]');
  rec('passo3', 'card do produto: alvo 9, aqui 6, chip "faltam 3 · conferir/ajustar"',
      cardV.trim() === '9' && cardT.trim() === '6' && /faltam 3/.test(chip0) && /conferir\/ajustar/.test(chip0),
      'veeqo=' + cardV + ' total=' + cardT + ' chip=' + chip0.trim());

  await page.select('[data-field="dest-bin"]', '6');
  await page.type('[data-form="mao"] [data-field="qtd"]', '3');
  await sleep(150);
  posted.length = 0;
  await page.click('[data-act="carregar-mao"]');
  await sleep(700);
  const load1 = posted.find((p) => p.pathname === '/api/v3/warehouse/load');
  rec('passo3', 'contei na mão → POST load {source:count_manual, dest bin 6, qty 3}',
      !!load1 && load1.body.source === 'count_manual' && Number(load1.body.qty) === 3
      && load1.body.dest && load1.body.dest.kind === 'bin' && Number(load1.body.dest.id) === 6,
      load1 ? JSON.stringify(load1.body).slice(0, 160) : 'sem post');
  rec('passo3', 'client_ref é um uuid (idempotência da porta única)',
      !!load1 && UUID_RE.test(String(load1.body.client_ref)), load1 ? String(load1.body.client_ref) : '');
  const toast1 = await txt('[data-toast]');
  rec('passo3', 'toast diz o que aconteceu, com destino e situação da Veeqo',
      /3 garrafas na prateleira B01/.test(toast1) && /Total agora 9/.test(toast1) && /batendo com a Veeqo/.test(toast1),
      toast1.slice(0, 120));
  const chipOk = await page.$('[data-veeqo-chip="bate"]');
  rec('passo3', 'o chip vira "bate com a Veeqo ✓" NA RESPOSTA do load', !!chipOk);
  await shot('05');
  noErr('passo3');

  // ══ 9. Pesei: conta confiante ═════════════════════════════════
  await page.type('[data-field="busca"]', 'Benfo');
  await sleep(250);
  await page.click('[data-search-results] [data-pick="1"]');
  await sleep(300);
  await page.select('[data-field="dest-bin"]', '1');
  await page.click('[data-method="peso"]');
  await sleep(300);
  const focusedGrams = await page.evaluate(() => document.activeElement
    && document.activeElement.getAttribute('data-field') === 'gramas');
  rec('pesei', 'campo de gramas AUTOFOCADO (o mesmo campo serve visor e USB)', focusedGrams === true);
  await page.type('[data-field="gramas"]', '1704');
  await page.click('[data-act="calcular"]');
  await sleep(500);
  const range1 = await txt('[data-compute-range]');
  const conf1 = await txt('[data-compute-conf]');
  rec('pesei', 'bin A03 (tara 420, sem variação): dá 10 garrafas, confiança alta',
      /dá 10 garrafas/.test(range1) && /alta/.test(conf1), range1 + ' ' + conf1);
  rec('pesei', 'sem sobra estranha, NENHUM card de recontagem',
      !(await page.$('[data-recount-card]')));
  posted.length = 0;
  await page.click('[data-act="carregar-peso"]');
  await sleep(700);
  const load2 = posted.find((p) => p.pathname === '/api/v3/warehouse/load');
  rec('pesei', 'pesar carrega com source count_weigh e o peso no meta',
      !!load2 && load2.body.source === 'count_weigh' && Number(load2.body.qty) === 10
      && load2.body.meta && Number(load2.body.meta.gross_g) === 1704,
      load2 ? JSON.stringify(load2.body).slice(0, 180) : 'sem post');

  // ══ 10. Pesei: sobra grande → faixa + card âmbar com 2 saídas ═
  await page.type('[data-field="busca"]', 'Ashwa');
  await sleep(250);
  await page.click('[data-search-results] [data-pick="8"]');
  await sleep(300);
  await page.click('[data-dest="box"]');
  await sleep(150);
  await page.select('[data-field="dest-box"]', '24');
  await sleep(150);
  await page.type('[data-field="gramas"]', '3478');
  await page.click('[data-act="calcular"]');
  await sleep(500);
  const range2 = await txt('[data-compute-range]');
  rec('recontagem', 'caixa que varia 230 g abre a faixa: dá 19 a 21 garrafas',
      /dá 19 a 21 garrafas/.test(range2), range2);
  const rc = await txt('[data-recount-card]');
  rec('recontagem', 'card âmbar sugere contar na mão (nunca bloqueia)',
      /Melhor contar na mão/.test(rc), rc.slice(0, 100));
  const btnUse = await page.$('[data-act="usar-assim-mesmo"]');
  const btnHand = await page.$('[data-act="vou-contar-mao"]');
  rec('recontagem', 'as DUAS saídas na mão do operador: "usar 20 assim mesmo" e "vou contar na mão"',
      !!btnUse && !!btnHand && /usar 20 assim mesmo/.test(rc));
  await shot('06');
  await page.click('[data-act="vou-contar-mao"]');
  await sleep(300);
  rec('recontagem', '"vou contar na mão" troca pro formulário manual',
      !!(await page.$('[data-form="mao"]')));
  noErr('recontagem');

  // ══ 11. Atalhos: direto da produção + avulsas consertadas ═════
  await page.click('[data-shortcut="producao"]');
  await sleep(150);
  await page.click('[data-dest="bin"]');
  await sleep(150);
  await page.select('[data-field="dest-bin"]', '6');
  await page.type('[data-form="mao"] [data-field="qtd"]', '5');
  posted.length = 0;
  await page.click('[data-act="carregar-mao"]');
  await sleep(700);
  const load3 = posted.find((p) => p.pathname === '/api/v3/warehouse/load');
  rec('atalhos', 'chegou da produção → source production_direct',
      !!load3 && load3.body.source === 'production_direct' && Number(load3.body.qty) === 5,
      load3 ? JSON.stringify(load3.body).slice(0, 140) : 'sem post');

  await page.click('[data-shortcut="avulsas"]');
  await sleep(150);
  await page.type('[data-form="mao"] [data-field="qtd"]', '2');
  posted.length = 0;
  await page.click('[data-act="carregar-mao"]');
  await sleep(500);
  rec('atalhos', 'avulsas SEM nota não carrega: a nota é obrigatória',
      !posted.some((p) => p.pathname === '/api/v3/warehouse/load'),
      JSON.stringify(posted.map((p) => p.pathname)));
  const toastNota = await txt('[data-toast]');
  rec('atalhos', 'o erro explica: falta dizer de onde vieram',
      /de onde vieram/.test(toastNota), toastNota.slice(0, 90));
  await page.type('[data-field="nota"]', 'achadas no fundo do palete 2, etiqueta refeita');
  posted.length = 0;
  await page.click('[data-act="carregar-mao"]');
  await sleep(700);
  const load4 = posted.find((p) => p.pathname === '/api/v3/warehouse/load');
  rec('atalhos', 'avulsas com nota → source loose_fixed + meta.note',
      !!load4 && load4.body.source === 'loose_fixed' && load4.body.meta
      && /palete 2/.test(String(load4.body.meta.note)),
      load4 ? JSON.stringify(load4.body).slice(0, 180) : 'sem post');

  // ══ 12. Lista recente + refs únicos + sem travessão ═══════════
  const nRecent = await page.$$eval('[data-recent] [data-recent-item]', (e) => e.length);
  rec('recentes', 'os carregamentos da sessão ficam listados (4)', nRecent === 4, 'itens=' + nRecent);
  const chips = await page.$$eval('[data-recent] [data-source-chip]', (e) => e.map((x) => x.getAttribute('data-source-chip')));
  rec('recentes', 'cada um com o chip da origem certa',
      chips.includes('count_manual') && chips.includes('count_weigh')
      && chips.includes('production_direct') && chips.includes('loose_fixed'), chips.join(','));
  const refs = [load1, load2, load3, load4].filter(Boolean).map((p) => String(p.body.client_ref));
  rec('recentes', 'cada carga com um client_ref próprio (nada repetido)',
      refs.length === 4 && new Set(refs).size === 4, refs.length + ' refs');
  await shot('07');

  const emdash = await page.evaluate(() => (document.body.textContent.match(/—/g) || []).length);
  rec('estilo', 'zero travessão na tela inteira', emdash === 0, 'ocorrências=' + emdash);
  noErr('final');

  await browser.close();
  server.close();

  const fails = results.filter((r) => !r.pass);
  console.log('\n' + '─'.repeat(60));
  console.log(results.length - fails.length + ' PASS  ·  ' + fails.length + ' FAIL');
  fs.writeFileSync(path.join(QA, 'qa-montar-report.json'),
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (fails.length) { fails.forEach((f) => console.log('  FAIL [' + f.group + '] ' + f.name + '  ' + f.detail)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
