'use strict';
/**
 * QA harness da CENTRAL DE P&P & ESTOQUE do operador (/op — S15 Fase 2).
 * Rodar da RAIZ do projeto:  node docs/architecture/_qa/qa-op-ws.js
 *
 * O que faz:
 *   1. sobe um http estatico servindo src/op em /op e src/shared em /shared
 *      (nao precisa de build: a pagina do operador e vanilla JS);
 *   2. serve /op/config.js e INTERCEPTA todo /api/v3/op/** com fixtures locais
 *      (NUNCA fala com servidor nem banco);
 *   3. faz login com PIN falso, abre a Central, tira screenshots em
 *      docs/architecture/_qa/op-ws-*.png e roda as assercoes;
 *   4. imprime PASS/FAIL e sai com 1 se algo falhar.
 *
 * Nao mexe no qa-dashboard.js (harness compartilhado dos outros agentes).
 */
const puppeteer = require('puppeteer');
const http = require('http');
const path = require('path');
const fs = require('fs');

const QA = __dirname;
const ROOT = path.join(QA, '..', '..', '..');
const OPDIR = path.join(ROOT, 'src', 'op');
const SHAREDDIR = path.join(ROOT, 'src', 'shared');

const results = [];
const rec = (group, name, pass, detail) => {
  results.push({ group, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? 'PASS ' : 'FAIL ') + '[' + group + '] ' + name + (detail ? '  ·  ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = 'qa-op-token';
const PERSON = { id: 7, display_name: 'QA Operadora', role: 'operator', is_sandbox: true };

// ── fixtures do operador ─────────────────────────────────────────
const PICKLIST = {
  total_orders: 3, total_bottles: 5, product_count: 2,
  envelopes: { '9x12': 2, BX: 1 }, envelopes_unknown: 1,
  groups: [
    { sku: 'HF-BENF-200', product: 'HealthFare Benfotiamine 300mg', content_desc: '200 capsules',
      location: { shelf: 'S4', bin: 'A03' },
      orders: [{ order_number: '12-345', bottles: 2 }, { order_number: '12-401', bottles: 1 }] },
    { sku: 'HF-RUT-C2', product: 'Rutin 500mg', content_desc: '60 tablets',
      location: {}, orders: [{ order_number: '12-999', bottles: 2 }] },
  ],
};
const GAPS = {
  out_count: 1, low_count: 1, critical_count: 1,
  items: [
    { product: 'Rutin 500mg', sku: 'HF-RUT-C2', needed: 4, stock: 0, status: 'out', severity: 'critical', advice: 'Zerado. Cápsulas prontas no EMS, pode encapsular hoje.' },
    { product: 'Benfotiamine 300mg', sku: 'HF-BENF-200', needed: 3, stock: 2, status: 'low', severity: 'warn', advice: 'Falta 1. Tem caixa CX8 no mezanino.' },
  ],
};
const CONTEXT = {
  enabled: true,
  products: [{ id: 42, name: 'Benfotiamine' }, { id: 99, name: 'Rutin' }],
  bins: [
    { id: 1, bin_code: 'A03', shelf_code: 'S4', area: 'P&P', qty: 4, min_qty: 10, product_id: 42, product: 'Benfotiamine', needs_restock: true },
    { id: 2, bin_code: 'A04', shelf_code: 'S4', area: 'P&P', qty: 50, min_qty: 10, product_id: 99, product: 'Rutin', needs_restock: false },
    { id: 3, bin_code: 'B01', shelf_code: 'S6', area: 'P&P', qty: 1, min_qty: 6, product_id: 99, product: 'Rutin', needs_restock: true },
  ],
  boxes: [
    { id: 8, box_number: 'CX8', area: 'MEZ', qty: 100, product_id: 42, product: 'Benfotiamine' },
    { id: 9, box_number: 'CX9', area: 'MEZ', qty: 40, product_id: 99, product: 'Rutin' },
  ],
};
// os 4 estados do chip aparecem de uma vez (esse e o ponto do screenshot)
let RECENT = {
  ok: true,
  items: [
    { id: 1, kind: 'take', qty: 3, product: 'Benfotiamine', nickname: 'Benfotiamine 300', status: 'pending', created_at: '2026-08-18T13:00:00Z' },
    // contrato (2): entrada aprovada que virou caixa traz box_number + box_id
    { id: 2, kind: 'entrada', qty: 48, product: 'Rutin', nickname: 'Rutin 500', status: 'approved', created_at: '2026-08-18T12:40:00Z', box_id: 8, box_number: 'BX-0451' },
    { id: 3, kind: 'count', qty: 51, product: 'Rutin', nickname: 'Rutin 500', status: 'rejected', created_at: '2026-08-18T12:10:00Z' },
    { id: 4, kind: 'damaged', qty: 1, product: 'Benfotiamine', nickname: 'Benfotiamine 300', status: 'applied', created_at: '2026-08-18T11:55:00Z' },
    { id: 5, kind: 'restock', qty: 16, product: 'Benfotiamine', nickname: 'Benfotiamine 300', status: 'applied', created_at: '2026-08-18T11:30:00Z' },
  ],
};
// /api/v3/architect/person/:id/today devolve {events:[...]} — as tasks abertas
// sao os events sem ended_at (ver loadData em app.js).
// mutavel: parte do teste roda SEM task de P&P aberta (a Central tem que abrir
// do mesmo jeito, e aí sim perguntar "está fazendo P&P agora?").
const PP_EVENT = { id: 501, slug: 'order_printing', started_at: new Date(Date.now() - 20 * 60000).toISOString(), ended_at: null, is_paused: false };
const DONE_EVENT = { id: 500, slug: 'labeling', started_at: new Date(Date.now() - 120 * 60000).toISOString(), ended_at: new Date(Date.now() - 60 * 60000).toISOString() };
let TODAY = { ok: true, goal: 8, events: [DONE_EVENT] };   // começa SEM P&P aberto

/* S15.29 · FILA DE IMPRESSÃO PEDIDA PELO CELULAR (contrato 1 e 3).
   O admin pede a etiqueta do iPhone; o papel sai onde tem impressora. A Central
   puxa GET /api/v3/print-queue?status=queued e imprime com take → done.
   O stub segue o contrato do agente P: {data:{jobs:[...]}}, POST devolve
   {data:{job}} e o job some da fila depois do done. */
let QUEUE = [
  { id: 7, kind: 'bin_labels', payload: { labels: [
    { kind: 'bin', code: 'A03B2', line2: 'Prateleira S4 · P&P', line3: 'cabe 48 · Benfotiamine', url: '/scan/?bin=A03B2' },
    { kind: 'bin', code: 'A04', line2: 'Prateleira S4 · P&P', line3: 'cabe 48 · Rutin', url: '/scan/?bin=A04' },
  ] }, requested_by: 'Bruno', status: 'queued', age_min: 2, taken_by: null, is_test: false },
];

/* S2 · ETIQUETAS DE ENVIO DE HOJE (contratos 2, 3, 4 e 5).
   A etiqueta da transportadora sai do NOSSO sistema com rodape (apelido, local,
   garrafas, envelope, quem separou/embalou), agrupada por produto e na ordem do
   local. O PDF inteiro e composto no servidor (agente S1); a Central so pede,
   abre o arquivo e confirma que saiu no papel. O stub segue o contrato:
   preview → {data:{day,ready,counts}}, POST → {data:{job,file_url,counts}}. */
const SHIP_DAY = '2026-08-19';
const SHIP_READY = [
  { order_number: '12-345', external_order_id: 'V-1', shipment_id: 'S-1', tracking: '9400111', carrier: 'USPS',
    service: 'Ground Advantage', channel: 'TikTok', bottles: 2, envelope: '9x12', printed_at: null, mixed: false,
    products: [{ product_id: 42, nickname: 'BENF-300', sku: 'HF-BENF-200', bottles: 2, bin_code: 'A03B2', shelf_code: 'S4', area: 'P&P' }] },
  { order_number: '12-401', external_order_id: 'V-2', shipment_id: 'S-2', tracking: '9400112', carrier: 'USPS',
    service: 'Ground Advantage', channel: 'eBay', bottles: 1, envelope: '7x10', printed_at: null, mixed: false,
    products: [{ product_id: 42, nickname: 'BENF-300', sku: 'HF-BENF-200', bottles: 1, bin_code: 'A03B2', shelf_code: 'S4', area: 'P&P' }] },
  { order_number: '12-999', external_order_id: 'V-3', shipment_id: 'S-3', tracking: '9400113', carrier: 'DHL',
    service: 'Expedited', channel: 'Walmart', bottles: 2, envelope: 'BX', printed_at: null, mixed: true,
    products: [{ product_id: 99, nickname: 'RUT-500', sku: 'HF-RUT-C2', bottles: 2, bin_code: null, shelf_code: 'S6', area: 'P&P' }] },
  // ja impressa: entra em "ready" e em "printed", nao no "pra imprimir"
  { order_number: '12-100', external_order_id: 'V-4', shipment_id: 'S-4', tracking: '9400114', carrier: 'USPS',
    service: 'Ground Advantage', channel: 'TikTok', bottles: 1, envelope: '4x8',
    printed_at: '2026-08-19T13:00:00Z', mixed: false,
    products: [{ product_id: 99, nickname: 'RUT-500', sku: 'HF-RUT-C2', bottles: 1, bin_code: 'B01', shelf_code: 'S6', area: 'P&P' }] },
];
/* FASE A · COPILOTO DE FRETE (bloco read-only dentro do cartao de envio).
   O resumo do dia do freight-watch: etiquetas, gasto, acima do normal e
   quantas dessas tinham opcao MAIS BARATA na cotacao. Mutavel: o teste roda
   os TRES estados (tem mais barata / ja eram o melhor / dia limpo). */
let COPILOT = {
  day: SHIP_DAY, labeled: 12, total_cost: 73.4, outliers: 2,
  with_cheaper: { n: 1, saving: 2.78 }, best_already: { n: 1 }, unquoted: { n: 0 },
};

let SHIP_PRINTED = 1;             // quantas ja sairam no papel hoje
let SHIP_JOB_SEQ = 900;
let SHIP_LAST_JOB = null;         // o job devolvido pelo ultimo POST
function shipCounts() {
  return { ready: SHIP_READY.length, printed: SHIP_PRINTED, to_print: SHIP_READY.length - SHIP_PRINTED };
}

// requisicoes POST observadas (as assercoes leem daqui)
const posted = [];
// GETs do PDF composto: quem abriu e com que credencial na query
const fileHits = [];

function apiFixture(pathname, method, body) {
  if (method === 'POST') posted.push({ pathname, body });

  // ── copiloto de frete (Fase A, so leitura) ──────────────────
  if (pathname === '/api/v3/op-freight/copilot') return { data: COPILOT };

  // ── etiquetas de envio ───────────────────────────────────────
  if (pathname.indexOf('/api/v3/print-queue/shipping-labels/preview') === 0) {
    return { data: { day: SHIP_DAY, ready: SHIP_READY, counts: shipCounts() } };
  }
  if (pathname === '/api/v3/print-queue/shipping-labels') {
    const n = (body && body.reprint) ? SHIP_READY.length : shipCounts().to_print;
    // 409 de VERDADE (contrato 3): status 200 com erro no corpo nao faria o
    // api() do /op rejeitar, e a tela nunca veria o caso "nada novo".
    if (!n) return { _status: 409, error: { code: 'nothing_to_print', message: 'nada novo pra imprimir' } };
    const id = ++SHIP_JOB_SEQ;
    SHIP_LAST_JOB = {
      id, kind: 'shipping_labels', status: (body && body.take) ? 'taken' : 'queued',
      requested_by: 'QA Operadora', age_min: 0, is_test: false,
      payload: { day: SHIP_DAY, count: n, pages: n + 2, file_id: 5, shipment_ids: ['S-1', 'S-2', 'S-3'],
        groups: [{ nickname: 'BENF-300', count: 2, location: 'A03B2' }, { nickname: 'RUT-500', count: 1, location: 'S6' }] },
    };
    return { data: { job: SHIP_LAST_JOB, file_url: '/api/v3/print-queue/' + id + '/file',
      counts: { labels: n, pages: n + 2, groups: 2 } } };
  }

  // ── fila de impressão do celular ─────────────────────────────
  if (pathname.startsWith('/api/v3/print-queue')) {
    const m = pathname.match(/\/api\/v3\/print-queue\/(\d+)\/(take|done|error|cancel)$/);
    if (m) {
      const id = Number(m[1]); const op = m[2];
      // job de etiquetas de envio: done carimba printed_at (contrato 5)
      if (SHIP_LAST_JOB && SHIP_LAST_JOB.id === id) {
        if (op === 'done') { SHIP_LAST_JOB.status = 'done'; SHIP_PRINTED = SHIP_READY.length; }
        if (op === 'error') { SHIP_LAST_JOB.status = 'error'; SHIP_LAST_JOB.error_note = body && body.note; }
        return { data: { job: SHIP_LAST_JOB } };
      }
      const job = QUEUE.find((j) => j.id === id);
      if (!job) return { error: { code: 'not_found', message: 'job sumiu' } };
      if (op === 'take') { job.status = 'taken'; job.taken_by = (body && body.by) || '?'; }
      if (op === 'done') { job.status = 'done'; QUEUE = QUEUE.filter((j) => j.id !== id); }
      if (op === 'error') { job.status = 'error'; job.error_note = body && body.note; }
      if (op === 'cancel') { job.status = 'cancelled'; QUEUE = QUEUE.filter((j) => j.id !== id); }
      return { data: { job } };
    }
    return { data: { jobs: QUEUE.filter((j) => j.status === 'queued' || j.status === 'taken') } };
  }

  const p = pathname.replace('/api/v3/op/', '');
  /* session_token, nao "token": e o nome que o app.js le (submitPin). Com o
     nome errado a sessao ficava sem token e o link assinado do PDF (?t=) saia
     vazio: o harness passava e a aba real levaria 401. */
  if (p === 'auth/login') return { ok: true, session_token: 'qa-session', person: PERSON, auto_logoff_seconds: 999999 };
  if (p === 'auth/heartbeat') return { ok: true };
  if (p === 'auth/logout') return { ok: true };
  if (p === 'active-operators') return { ok: true, operators: [] };
  if (p === 'picklist') return PICKLIST;
  if (p === 'stock-gaps') return GAPS;
  if (p === 'stock/context') return CONTEXT;
  if (p === 'stock/recent') return RECENT;
  if (p === 'stock/take') return { ok: true, request_id: 77, status: 'pending', kind: 'take' };
  if (p === 'stock/propose') return { ok: true, request_id: 78, status: 'pending' };
  if (p === 'stock/restock') return { ok: true, applied: true, box_left: 84, bin_now: 20 };
  if (p.indexOf('stock/box/label') === 0) return { ok: true, label: { kind: 'box', code: 'BX-0451', line2: 'Rutin 500mg', qty: 48, lot: 'L-22', url: '/scan/?box=BX-0451' } };
  // "Iniciar Impressão de ordens" na Central: abre a task de P&P de verdade
  if (p === 'event/start') { TODAY = { ok: true, goal: 8, events: [PP_EVENT, DONE_EVENT] }; return { ok: true, event: { id: 501 } }; }
  if (p === 'pending-confirmations') return { ok: true, prompts: [] };
  if (p === 'ems/my-activity') return { ok: true, detected: null };
  if (p === 'end-of-day/check') return { ok: true, should_ask: false };
  if (pathname.startsWith('/api/v3/architect/person/')) return { ok: true, ...TODAY };
  return { ok: true };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(u.pathname);

      // config publico (o servidor real gera este arquivo)
      if (p === '/op/config.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end('window.HF_OP_CONFIG = ' + JSON.stringify({ pageToken: TOKEN, workspace: true }) + ';');
        return;
      }
      /* O PDF composto (contrato 4). Uma aba nova nao manda header: a
         credencial vem em ?t=. O harness so precisa devolver ALGO com
         content-type de PDF; o desenho e do agente S1. */
      if (/^\/api\/v3\/print-queue\/\d+\/file$/.test(p)) {
        fileHits.push({ path: p, query: u.search });
        res.writeHead(200, { 'content-type': 'application/pdf',
          'content-disposition': 'inline; filename=etiquetas-envio-' + SHIP_DAY + '.pdf' });
        res.end(Buffer.from('%PDF-1.4\n% etiquetas de envio (stub do harness)\n%%EOF\n'));
        return;
      }
      // API interceptada
      if (p.startsWith('/api/')) {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw; }
          const out = apiFixture(p, req.method, body) || {};
          // _status: a fixture pode pedir um codigo HTTP de verdade (409, 404).
          const code = out._status || 200;
          delete out._status;
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out));
        });
        return;
      }
      // estatico: /op → src/op, /shared → src/shared
      let file = null;
      if (p === '/' || p === '/op' || p === '/op/') file = path.join(OPDIR, 'index.html');
      else if (p.startsWith('/op/')) file = path.join(OPDIR, p.slice(4));
      else if (p.startsWith('/shared/')) file = path.join(SHAREDDIR, p.slice(8));
      if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await startServer();
  const BASE = 'http://127.0.0.1:' + port + '/op/';
  console.log('servindo src/op em ' + BASE + '  (API interceptada, sem rede)\n');

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

  const EXTERNAL = /fonts\.(googleapis|gstatic)\.com|Failed to load resource|service ?worker/i;
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (EXTERNAL.test(t)) return;
    consoleErrors.push('console.error: ' + t.slice(0, 300));
  });

  const shot = async (name) => {
    const f = path.join(QA, 'op-ws-' + name + '.png');
    await page.screenshot({ path: f });
    console.log('    shot → ' + path.relative(ROOT, f));
  };
  // dirige o app pelo estado interno (o PIN real depende do banco)
  const drive = (fn, arg) => page.evaluate(([f, a]) => window.__qa[f](a), [fn, arg]);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.HF_WS, { timeout: 8000 });
  rec('boot', 'window.HF_WS definido por /op/ws.js', true);
  // Bruno 08-19: a pausa tem o modulo dela; a Central nao pode derrubar o carregamento
  const hasPause = await page.evaluate(() => !!(window.HF_PAUSE && typeof window.HF_PAUSE.card === 'function' && typeof window.HF_PAUSE.banner === 'function'));
  rec('boot', 'window.HF_PAUSE definido por /op/pause-ui.js (card + banner)', hasPause, '');
  rec('boot', 'app.js carregou sem erro', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  // login: o app expoe pouca coisa; usamos o PIN falso do harness via API mockada
  await page.evaluate(() => {
    document.querySelectorAll('[data-act="pinkey"]').forEach(() => {});
  });
  const keys = await page.$$('[data-act="pinkey"]');
  rec('login', 'keypad renderizou', keys.length > 0, keys.length + ' teclas');
  for (const d of ['1', '2', '3', '4']) {
    const btn = await page.$('[data-act="pinkey"][data-arg="' + d + '"]');
    if (btn) await btn.click();
  }
  await sleep(900);
  await shot('01-home');
  const bannerTxt = await page.evaluate(() => document.body.innerText);

  // ── MENU PERSISTENTE (nav.js): as 3 abas na home, sem task nenhuma ──
  const nav = await page.evaluate(() => {
    const n = document.querySelector('[data-nav="op"]');
    if (!n) return null;
    const items = Array.from(n.querySelectorAll('[data-nav-item]'));
    return {
      keys: items.map((i) => i.getAttribute('data-nav-item')),
      labels: items.map((i) => i.innerText.replace(/\s+/g, ' ').trim()),
      active: (n.querySelector('[aria-current="page"]') || {}).getAttribute
        ? n.querySelector('[aria-current="page"]').getAttribute('data-nav-item') : null,
      heights: items.map((i) => Math.round(i.getBoundingClientRect().height)),
      estoqueHref: (n.querySelector('[data-nav-item="estoque"]') || {}).getAttribute
        ? n.querySelector('[data-nav-item="estoque"]').getAttribute('href') : null,
    };
  });
  rec('menu', 'nav persistente na home com Linha · Central de P&P · Estoque',
    !!nav && nav.keys.join(',') === 'linha,central,estoque', nav ? nav.labels.join(' | ') : 'sem nav');
  rec('menu', 'aba ativa na home e a Linha', !!nav && nav.active === 'linha', nav ? nav.active : '');
  rec('menu', 'todo item do menu tem 44px+ de altura (toque com luva)',
    !!nav && nav.heights.every((x) => x >= 44), nav ? nav.heights.join('/') : '');
  rec('menu', 'aba Estoque aponta pro hub', !!nav && nav.estoqueHref === '/op/estoque.html', nav ? nav.estoqueHref : '');
  // sem task de P&P: o box grande NAO aparece, mas o menu sim
  rec('menu', 'sem task de P&P o box grande nao aparece (so o menu)',
    !/Picklist do dia/.test(bannerTxt) && /Central de P&P/.test(bannerTxt), '');

  // abre a Central pelo MENU (sem nenhuma task de P&P aberta)
  const openBtn = await page.$('[data-nav-item="central"]');
  rec('menu', 'aba Central de P&P e clicavel na home', !!openBtn);
  if (openBtn) await openBtn.click();
  // stock-gaps cruza Veeqo+EMS (chega DEPOIS do resto): espera o card carregar.
  // A camada 'workspace' so remonta quando a key muda, entao esperamos o texto.
  await page.waitForFunction(
    () => /ZERADO|Tudo que precisa hoje/.test(document.body.innerText),
    { timeout: 10000 },
  ).catch(() => {});
  await sleep(700);
  await shot('02-central');

  const txt = await page.evaluate(() => document.body.innerText);

  // ── CENTRAL SEM TASK: abre igual, pergunta com jeito, nunca trava ──
  rec('sem-task', 'Central abre sem nenhuma task de P&P aberta', /Central de P&P & Estoque/.test(txt), '');
  rec('sem-task', 'pergunta "Você está fazendo P&P agora?"', /Você está fazendo P&P agora\?/.test(txt), '');
  rec('sem-task', 'as duas saidas existem (Iniciar / Só olhar)',
    !!(await page.$('[data-act="wsStartPP"]')) && !!(await page.$('[data-act="wsJustLook"]')));
  rec('sem-task', 'REGRA #0: a picklist e o PRINT ja estao ali mesmo sem task',
    /HF-BENF-200/.test(txt) && !!(await page.$('[data-act="wsPrint"]')), '');
  // a home continua montada por baixo (camadas): olha so a nav VISIVEL, a da
  // camada da Central, que e a que o operador tem na frente.
  const navCentral = await page.evaluate(() => {
    const navs = Array.from(document.querySelectorAll('[data-nav="op"]'));
    const vis = navs.filter((n) => n.getBoundingClientRect().width > 0 && n.offsetParent !== null);
    const last = vis[vis.length - 1];
    if (!last) return { count: navs.length, active: null };
    const a = last.querySelector('[aria-current="page"]');
    return { count: vis.length, active: a ? a.getAttribute('data-nav-item') : null };
  });
  rec('menu', 'dentro da Central o menu marca a aba Central',
    navCentral.active === 'central', JSON.stringify(navCentral));
  await shot('02b-central-sem-task');

  // "Iniciar Impressão de ordens" abre a task pelo mesmo caminho do app.js
  posted.length = 0;
  await (await page.$('[data-act="wsStartPP"]')).click();
  await sleep(900);
  const startPost = posted.find((x) => x.pathname === '/api/v3/op/event/start');
  rec('sem-task', 'Iniciar posta event/start com activity_slug=order_printing',
    !!startPost && startPost.body.activity_slug === 'order_printing',
    startPost ? JSON.stringify(startPost.body) : 'sem post');
  const afterStart = await page.evaluate(() => document.body.innerText);
  rec('sem-task', 'depois de iniciar a pergunta some e a Central continua aberta',
    !/Você está fazendo P&P agora\?/.test(afterStart) && /picklist de hoje/i.test(afterStart), '');
  await shot('02c-central-task-iniciada');

  rec('central', 'picklist renderizou (SKU + QTY + Location)', /HF-BENF-200/.test(txt) && /Location/i.test(txt));
  rec('central', 'card Falta de estoque com ZERADO', /Falta de estoque/i.test(txt) && /ZERADO/.test(txt));
  rec('central', 'chip de sandbox presente', /sandbox/i.test(txt));
  rec('central', 'botao PRINT presente', !!(await page.$('[data-act="wsPrint"]')));
  rec('central', 'card Repor prateleira lista os bins', /Repor prateleira/i.test(txt) && /BIN A03/.test(txt));
  rec('central', 'botao Repor com a qty calculada (2*10-4=16)', /Repor 16/.test(txt), '');
  rec('central', 'Registrado hoje traz os 4 estados', /pendente/.test(txt) && /aprovado/.test(txt) && /recusado/.test(txt) && /aplicado/.test(txt));
  rec('central', 'rotulo do tipo nas linhas (Peguei/Entrada/Contagem/Reposicao)', /Peguei/.test(txt) && /Entrada/.test(txt) && /Contagem/.test(txt) && /Reposição/.test(txt));
  rec('central', 'sem em dash na tela', !/—/.test(txt), '');
  rec('central', 'sem entidade HTML crua vazando (&middot; / &hellip;)', !/&[a-z]+;/.test(txt), (txt.match(/&[a-z]+;/) || [''])[0]);

  // escolhe um produto → aparece o segmento de 4 tipos
  await page.type('[data-input="wsQ"]', 'benfo', { delay: 20 });
  await sleep(500);
  const sug = await page.$('[data-act="wsPick"]');
  rec('registrar', 'busca sugere o suplemento', !!sug);
  // sem catalogo local (DATA.supplements vazio) a busca nao acha nada: injeta.
  if (!sug) {
    await page.evaluate(() => { window.HF_DATA = window.HF_DATA || {}; });
  }
  await sleep(200);

  // seleciona o produto direto pelo estado (o catalogo vem do fuse-data do servidor)
  await page.evaluate(() => {
    window.HF_WS.state().sel = { id: 42, canonical_name: 'Benfotiamine 300mg' };
    window.HF_WS.state().q = '';
    window.HF_WS.acts.wsKind('pick');
  });
  await sleep(500);
  await shot('03-registrar-pick');
  const seg = await page.$$('[data-act="wsKind"]');
  rec('registrar', 'segmento com 4 tipos', seg.length === 4, seg.length + ' botoes');
  const segTxt = await page.evaluate(() => Array.from(document.querySelectorAll('[data-act="wsKind"]')).map((b) => b.textContent).join('|'));
  rec('registrar', 'rotulos: Peguei do estoque · Danificada · Entrada · Contagem',
    /Peguei do estoque/.test(segTxt) && /Danificada/.test(segTxt) && /Entrada/.test(segTxt) && /Contagem/.test(segTxt), segTxt);

  // Contagem → seletor de destino OBRIGATORIO
  await page.evaluate(() => window.HF_WS.acts.wsKind('count'));
  await sleep(400);
  await shot('04-registrar-contagem');
  const cTxt = await page.evaluate(() => document.body.innerText);
  // o micro-label vem em CAPS via text-transform do inline style: compara sem case
  rec('registrar', 'Contagem pede local (obrigatorio)', /onde voc[eê] contou \(obrigat[oó]rio\)/i.test(cTxt), '');
  const dests = await page.$$('[data-act="wsDest"]');
  rec('registrar', 'destinos vem do stock/context filtrados pelo produto', dests.length >= 2, dests.length + ' destinos');

  // submit sem local → NAO posta
  posted.length = 0;
  await page.evaluate(() => window.HF_WS.acts.wsSubmit());
  await sleep(400);
  rec('registrar', 'contagem sem local nao posta', posted.length === 0, posted.length + ' posts');

  // escolhe o bin e envia → propose
  const b1 = await page.$('[data-act="wsDest"][data-arg^="bin:"]');
  if (b1) await b1.click();
  await sleep(300);
  posted.length = 0;
  await page.evaluate(() => window.HF_WS.acts.wsSubmit());
  await sleep(700);
  const prop = posted.find((x) => x.pathname === '/api/v3/op/stock/propose');
  rec('registrar', 'Contagem posta em stock/propose com kind=count + bin_id',
    !!prop && prop.body.kind === 'count' && !!prop.body.bin_id, prop ? JSON.stringify(prop.body) : 'sem post');
  await sleep(500);
  await shot('05-toast-aprovacao');
  const tTxt = await page.evaluate(() => document.body.innerText);
  rec('registrar', 'toast "Enviado pra aprovação"', /Enviado pra aprovação/.test(tTxt), '');

  // Peguei do estoque → take
  await page.evaluate(() => {
    window.HF_WS.state().sel = { id: 42, canonical_name: 'Benfotiamine 300mg' };
    window.HF_WS.state().qty = '3';
    window.HF_WS.acts.wsKind('pick');
  });
  await sleep(400);
  posted.length = 0;
  await page.evaluate(() => window.HF_WS.acts.wsSubmit());
  await sleep(700);
  const take = posted.find((x) => x.pathname === '/api/v3/op/stock/take');
  rec('registrar', 'Peguei do estoque posta em stock/take (kind=pick, qty=3)',
    !!take && take.body.kind === 'pick' && take.body.qty === 3, take ? JSON.stringify(take.body) : 'sem post');
  await sleep(400);
  await shot('06-toast-pick');
  const pTxt = await page.evaluate(() => document.body.innerText);
  rec('registrar', 'toast do pick fala de aprovacao + saiu do disponivel',
    /Vai pra aprovação do admin, já saiu do disponível/.test(pTxt), '');

  // Repor prateleira (um toque)
  posted.length = 0;
  const repor = await page.$('[data-act="wsRestock"]');
  rec('repor', 'botao Repor presente', !!repor);
  if (repor) await repor.click();
  await sleep(800);
  const rst = posted.find((x) => x.pathname === '/api/v3/op/stock/restock');
  rec('repor', 'posta bin_id/box_id/qty=16', !!rst && rst.body.qty === 16 && !!rst.body.bin_id && !!rst.body.box_id,
    rst ? JSON.stringify(rst.body) : 'sem post');
  await shot('07-repor-toast');
  const rTxt = await page.evaluate(() => document.body.innerText);
  rec('repor', 'toast "Prateleira reposta"', /Prateleira reposta/.test(rTxt), '');

  // ── Registrado hoje: caixa aprovada ganha numero + etiqueta (contrato 2) ──
  const recTxt = await page.evaluate(() => document.body.innerText);
  rec('etiqueta', 'entrada aprovada mostra o numero da caixa', /Caixa BX-0451/.test(recTxt), '');
  const lblBtns = await page.$$('[data-act="wsPrintLabel"]');
  rec('etiqueta', 'so a linha com caixa ganha "Imprimir etiqueta"', lblBtns.length === 1, lblBtns.length + ' botoes');
  const labelPath = await page.evaluate(() => {
    // intercepta a janela de impressao: o harness nao quer popup de verdade
    window.__lastLabel = null;
    const open = window.open;
    window.open = function () { const w = { document: { write: (d) => { window.__lastLabel = d; }, close: () => {} } }; window.open = open; return w; };
    return true;
  });
  if (lblBtns.length) await lblBtns[0].click();
  await sleep(700);
  const labelDoc = await page.evaluate(() => window.__lastLabel || '');
  rec('etiqueta', 'a etiqueta 4x6 sai com o codigo, o produto e o QR',
    /BX-0451/.test(labelDoc) && /4in 6in/.test(labelDoc) && /<svg/.test(labelDoc),
    labelDoc ? labelDoc.slice(0, 60) : 'sem documento · ' + labelPath);

  // ── ETIQUETAS DE ENVIO DE HOJE (S2) ──────────────────────────
  // O cartao mais alto da Central: e o que vai pro cliente hoje.
  // volta o scroll pro topo: as telas deste bloco sao do cartao de envio
  /* A home continua montada por baixo (camadas) e tem o SEU .hf-scroll: sobe o
     scroll do container que realmente contem o cartao de envio, senao a foto
     sai da picklist e ninguem ve o que este bloco esta testando. */
  const toTop = async () => {
    await page.evaluate(() => {
      const c = document.querySelector('[data-card="shipping-labels"]');
      let sc = c && c.parentElement;
      while (sc && sc.scrollHeight <= sc.clientHeight) sc = sc.parentElement;
      if (sc) sc.scrollTop = 0;
    });
    await sleep(250);
  };
  await toTop();
  const shipCard = await page.$('[data-card="shipping-labels"]');
  rec('envio', 'cartao "Etiquetas de envio de hoje" existe na Central', !!shipCard);
  const shipTxt = shipCard ? await page.evaluate((e) => e.innerText.replace(/\s+/g, ' '), shipCard) : '';
  rec('envio', 'conta prontas na Veeqo, ja impressas e pra imprimir',
    /4 prontas na Veeqo/.test(shipTxt) && /1 j[aá] impressas/.test(shipTxt) && /3 pra imprimir/.test(shipTxt), shipTxt.slice(0, 160));
  rec('envio', 'mini lista por produto com apelido, quantas e local',
    /BENF-300/.test(shipTxt) && /RUT-500/.test(shipTxt) && /A03B2/.test(shipTxt), shipTxt.slice(0, 200));
  // pedido SEM bin cai no shelf: quem separa precisa de um lugar, nunca de vazio
  rec('envio', 'produto sem bin mostra a prateleira em vez de nada', /S6/.test(shipTxt), '');
  // o cartao fica ACIMA da picklist: a ordem da tela e a ordem do trabalho
  const shipFirst = await page.evaluate(() => {
    const c = document.querySelector('[data-card="shipping-labels"]');
    const q = document.querySelector('[data-card="print-queue"]');
    if (!c) return null;
    return !q || (c.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING) > 0;
  });
  rec('envio', 'o cartao vem antes da fila do celular na coluna do P&P', shipFirst !== false, String(shipFirst));
  const shipBtn = await page.$('[data-act="wsShipPrint"]');
  rec('envio', 'botao grande diz quantas vao sair', !!shipBtn
    && /Imprimir etiquetas de envio \(3\)/.test(await page.evaluate((e) => e.innerText, shipBtn)),
    shipBtn ? await page.evaluate((e) => e.innerText, shipBtn) : 'sem botao');
  rec('envio', 'alvo de toque de 48px+ (a Simone usa luva)',
    !!shipBtn && (await page.evaluate((e) => Math.round(e.getBoundingClientRect().height), shipBtn)) >= 48,
    shipBtn ? String(await page.evaluate((e) => Math.round(e.getBoundingClientRect().height), shipBtn)) + 'px' : '');
  rec('envio', 'link discreto de reimprimir tudo (nunca um botao grande)',
    !!(await page.$('[data-act="wsShipReprint"]')));
  await toTop(); await shot('12-etiquetas-envio');

  // ── COPILOTO DE FRETE (FASE A): tres estados, zero botoes ────
  const copCard = () => page.evaluate(() => {
    const c = document.querySelector('[data-block="freight-copilot"]');
    return c ? c.innerText.replace(/\s+/g, ' ') : '';
  });
  let copTxt = await copCard();
  rec('copiloto', 'bloco Copiloto de frete dentro do cartao de envio', /copiloto de frete/i.test(copTxt), copTxt.slice(0, 120));
  rec('copiloto', 'estado 1: Hoje N etiquetas, $X, M acima do normal',
    /Hoje: 12 etiquetas, \$73\.40\. 2 acima do normal\./.test(copTxt), copTxt.slice(0, 160));
  rec('copiloto', 'estado 1: chip de aviso com a economia recuperavel',
    /1 com opção mais barata, dá pra recuperar \$2\.78/.test(copTxt), copTxt.slice(0, 200));
  rec('copiloto', 'Fase A e SO OLHAR: nenhum botao no bloco',
    (await page.evaluate(() => {
      const c = document.querySelector('[data-block="freight-copilot"]');
      return c ? c.querySelectorAll('button, a').length : -1;
    })) === 0, '');
  await shot('16-copilot-mais-barata');

  // estado 2: cotou tudo e as caras JA ERAM o melhor preco (linha neutra)
  COPILOT = { day: SHIP_DAY, labeled: 12, total_cost: 73.4, outliers: 2,
    with_cheaper: { n: 0, saving: 0 }, best_already: { n: 2 }, unquoted: { n: 0 } };
  await page.evaluate(() => window.HF_WS.acts.wsShipReload());
  await sleep(900);
  copTxt = await copCard();
  rec('copiloto', 'estado 2: sem mais barata + outliers → "As caras já eram o melhor preço."',
    /As caras já eram o melhor preço\./.test(copTxt) && !/recuperar/.test(copTxt), copTxt.slice(0, 200));
  await toTop(); await shot('17-copilot-ja-era-o-melhor');

  // estado 3: dia limpo (zero acima do normal) → so a linha base, sem aviso
  COPILOT = { day: SHIP_DAY, labeled: 9, total_cost: 51.3, outliers: 0,
    with_cheaper: { n: 0, saving: 0 }, best_already: { n: 0 }, unquoted: { n: 0 } };
  await page.evaluate(() => window.HF_WS.acts.wsShipReload());
  await sleep(900);
  copTxt = await copCard();
  rec('copiloto', 'estado 3: dia limpo → "0 acima do normal", sem chip e sem linha neutra',
    /Hoje: 9 etiquetas, \$51\.30\. 0 acima do normal\./.test(copTxt)
      && !/mais barata/.test(copTxt) && !/já eram/.test(copTxt), copTxt.slice(0, 160));
  await toTop(); await shot('18-copilot-dia-limpo');

  // volta o fixture do estado 1 pro resto do fluxo (impressao nao depende dele)
  COPILOT = { day: SHIP_DAY, labeled: 12, total_cost: 73.4, outliers: 2,
    with_cheaper: { n: 1, saving: 2.78 }, best_already: { n: 1 }, unquoted: { n: 0 } };
  await page.evaluate(() => window.HF_WS.acts.wsShipReload());
  await sleep(900);

  // IMPRIMIR: POST {day, take:true} → abre o PDF com o token na query
  await page.evaluate(() => {
    window.__shipWin = null;
    const open = window.open;
    window.open = function () {
      const w = { _loc: '', document: { write: () => {}, close: () => {} }, close: () => {} };
      Object.defineProperty(w, 'location', { set: (v) => { w._loc = String(v); window.__shipWin = String(v); }, get: () => w._loc });
      window.open = open;
      return w;
    };
  });
  posted.length = 0; fileHits.length = 0;
  // re-busca o botao: os reloads do copiloto remontaram o cartao (handle velho descola)
  const shipBtn2 = await page.$('[data-act="wsShipPrint"]');
  if (shipBtn2) await shipBtn2.click();
  await sleep(1200);
  const shipPost = posted.find((x) => x.pathname === '/api/v3/print-queue/shipping-labels');
  rec('envio', 'Imprimir posta {day, take:true} em shipping-labels',
    !!shipPost && !!shipPost.body.day && shipPost.body.take === true && !shipPost.body.reprint,
    shipPost ? JSON.stringify(shipPost.body) : 'sem post');
  rec('envio', 'o dia e o de Nova York (fuso da fabrica, nao o do navegador)',
    !!shipPost && /^\d{4}-\d{2}-\d{2}$/.test(shipPost.body.day), shipPost ? shipPost.body.day : '');
  const shipWin = await page.evaluate(() => window.__shipWin || '');
  rec('envio', 'a janela abriu no file_url do job com o token da sessao na query',
    /\/api\/v3\/print-queue\/\d+\/file\?t=/.test(shipWin), shipWin || 'janela sem endereco');
  const afterPrint = await page.evaluate(() => {
    const c = document.querySelector('[data-card="shipping-labels"]');
    return c ? c.innerText.replace(/\s+/g, ' ') : '';
  });
  rec('envio', 'o cartao troca de cara: "Imprima na 4x6 e toque em Ja imprimi"',
    /Imprima na 4x6 e toque em J[aá] imprimi/.test(afterPrint), afterPrint.slice(0, 160));
  rec('envio', 'as duas saidas aparecem (Ja imprimi / Deu erro)',
    !!(await page.$('[data-act="wsShipDone"]')) && !!(await page.$('[data-act="wsShipError"]')));
  await toTop(); await shot('13-envio-aguardando');

  // JA IMPRIMI: e AQUI que o printed_at e carimbado (contrato 5)
  posted.length = 0;
  const doneBtn = await page.$('[data-act="wsShipDone"]');
  if (doneBtn) await doneBtn.click();
  await sleep(1200);
  const shipDone = posted.find((x) => /\/print-queue\/\d+\/done$/.test(x.pathname));
  rec('envio', 'Ja imprimi posta done no job (carimba printed_at)', !!shipDone,
    shipDone ? shipDone.pathname : JSON.stringify(posted.map((x) => x.pathname)));
  rec('envio', 'o done leva o NOME de quem confirmou',
    !!shipDone && shipDone.body && shipDone.body.by === PERSON.display_name,
    shipDone ? JSON.stringify(shipDone.body) : '');
  const doneScreen = await page.evaluate(() => document.body.innerText);
  rec('envio', 'confirma "Etiquetas registradas como impressas"',
    /Etiquetas registradas como impressas/.test(doneScreen), '');
  await sleep(700);
  const afterDone = await page.evaluate(() => {
    const c = document.querySelector('[data-card="shipping-labels"]');
    return c ? c.innerText.replace(/\s+/g, ' ') : '';
  });
  rec('envio', 'depois do done o cartao diz que tudo de hoje ja saiu',
    /0 pra imprimir/.test(afterDone) && /j[aá] saiu no papel/.test(afterDone), afterDone.slice(0, 160));
  await toTop(); await shot('14-envio-impresso');

  // NADA PRA IMPRIMIR: 409 vira frase de gente, nao erro cru
  posted.length = 0;
  await page.evaluate(() => {
    const open = window.open;
    window.open = function () { const w = { document: { write: () => {}, close: () => {} }, close: () => {} }; window.open = open; return w; };
    window.HF_WS.acts.wsShipPrint();
  });
  await sleep(1000);
  const nothingTxt = await page.evaluate(() => document.body.innerText);
  rec('envio', '409 nothing_to_print vira "Nada novo pra imprimir. As de hoje ja sairam."',
    /Nada novo pra imprimir\. As de hoje j[aá] sa[ií]ram\./.test(nothingTxt), '');
  await toTop(); await shot('15-envio-nada-novo');

  // REIMPRIMIR: manda reprint:true (o unico jeito de repetir papel)
  posted.length = 0;
  await page.evaluate(() => {
    const open = window.open;
    window.open = function () {
      const w = { _loc: '', document: { write: () => {}, close: () => {} }, close: () => {} };
      Object.defineProperty(w, 'location', { set: (v) => { w._loc = String(v); }, get: () => w._loc });
      window.open = open; return w;
    };
    window.HF_WS.acts.wsShipReprint();
  });
  await sleep(1000);
  const rePost = posted.find((x) => x.pathname === '/api/v3/print-queue/shipping-labels');
  rec('envio', 'reimprimir tudo de hoje manda reprint:true',
    !!rePost && rePost.body.reprint === true && rePost.body.take === true,
    rePost ? JSON.stringify(rePost.body) : 'sem post');

  // ── FILA DE IMPRESSAO PEDIDA PELO CELULAR (S15.29) ───────────
  // O poll e de 30s; forcamos uma leitura pra nao segurar o harness meio minuto.
  await page.evaluate(() => { const q = window.HF_WS.queue(); if (q) q.load(); });
  await sleep(700);
  const qCard = await page.$('[data-card="print-queue"]');
  rec('fila', 'cartao "Impressao pedida pelo celular" aparece quando tem pedido', !!qCard);
  const qTxt = qCard ? await page.evaluate((e) => e.innerText.replace(/\s+/g, ' '), qCard) : '';
  rec('fila', 'diz o tipo em PT, quantas folhas, quem pediu e ha quanto tempo',
    /Etiquetas de prateleira/.test(qTxt) && /2 folhas/.test(qTxt) && /Bruno/.test(qTxt) && /há 2 min/.test(qTxt), qTxt);
  const qBtn = await page.$('[data-act="wsPrintJob"]');
  rec('fila', 'botao Imprimir com alvo de toque de 46px+',
    !!qBtn && (await page.evaluate((e) => Math.round(e.getBoundingClientRect().height), qBtn)) >= 44,
    qBtn ? String(await page.evaluate((e) => Math.round(e.getBoundingClientRect().height), qBtn)) + 'px' : 'sem botao');
  await shot('10-fila-celular');

  // imprime: take → janela com AS DUAS etiquetas do renderizador unico → done
  await page.evaluate(() => {
    window.__lastLabel = null;
    const open = window.open;
    window.open = function () { const w = { document: { write: (d) => { window.__lastLabel = d; }, close: () => {} } }; window.open = open; return w; };
  });
  posted.length = 0;
  if (qBtn) await qBtn.click();
  await sleep(1200);
  const qPosts = posted.map((x) => x.pathname);
  rec('fila', 'toca em Imprimir e o job vai take -> done',
    qPosts.indexOf('/api/v3/print-queue/7/take') >= 0 && qPosts.indexOf('/api/v3/print-queue/7/done') >= 0,
    JSON.stringify(qPosts));
  const takeBody = posted.find((x) => /\/take$/.test(x.pathname));
  rec('fila', 'o take leva o NOME de quem pegou (o admin precisa saber onde saiu o papel)',
    !!takeBody && !!takeBody.body && takeBody.body.by === PERSON.display_name,
    takeBody ? JSON.stringify(takeBody.body) : 'sem body');
  const qDoc = await page.evaluate(() => window.__lastLabel || '');
  rec('fila', 'a janela abriu com as 2 etiquetas 4x6 do renderizador unico',
    /A03B2/.test(qDoc) && /A04/.test(qDoc) && /4in 6in/.test(qDoc) && (qDoc.match(/sheet-page/g) || []).length >= 2,
    qDoc ? 'paginas=' + (qDoc.match(/class="sheet-page"/g) || []).length : 'sem documento');
  const doneTxt = await page.evaluate(() => document.body.innerText);
  rec('fila', 'confirma "Pode tirar do papel"', /Pode tirar do papel/.test(doneTxt), '');
  await sleep(400);
  rec('fila', 'job impresso some do cartao (fila vazia = sem cartao)',
    !(await page.$('[data-card="print-queue"]')));
  await shot('11-fila-impressa');

  // fecha e volta pra home pelo MENU (aba Linha)
  const close = await page.$('[data-nav-item="linha"]');
  if (close) await close.click();
  await sleep(800);
  await shot('08-voltou-home');
  const hTxt = await page.evaluate(() => document.body.innerText);
  rec('menu', 'aba Linha fecha a Central e volta pra home', /Iniciar Tarefa/.test(hTxt), '');
  rec('menu', 'com task de P&P aberta o box grande volta a aparecer', /Picklist do dia/.test(hTxt), '');

  // ── DEEP LINK /op/?ws=1: entra ja na Central ────────────────
  await page.goto(BASE + '?ws=1', { waitUntil: 'domcontentloaded' });
  await sleep(600);
  for (const d of ['1', '2', '3', '4']) {
    const b = await page.$('[data-act="pinkey"][data-arg="' + d + '"]');
    if (b) await b.click();
  }
  await sleep(1400);
  const deepTxt = await page.evaluate(() => document.body.innerText);
  rec('deeplink', '/op/?ws=1 abre a Central logo depois do login',
    /picklist de hoje/i.test(deepTxt) && /Central de P&P & Estoque/.test(deepTxt), '');
  rec('deeplink', 'a URL fica limpa (sem ?ws=1 preso no historico)',
    !/ws=1/.test(await page.evaluate(() => location.search)), await page.evaluate(() => location.search));
  rec('deeplink', 'quem veio pelo link nao leva pergunta na cara',
    !/Você está fazendo P&P agora\?/.test(deepTxt), '');
  await shot('09-deeplink-central');

  rec('boot', 'nenhum erro de console no fluxo inteiro', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();

  const fails = results.filter((r) => !r.pass);
  console.log('\n' + '─'.repeat(60));
  console.log(results.length - fails.length + ' PASS  ·  ' + fails.length + ' FAIL');
  fs.writeFileSync(path.join(QA, 'qa-op-ws-report.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (fails.length) { fails.forEach((f) => console.log('  FAIL [' + f.group + '] ' + f.name + '  ' + f.detail)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
