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

// requisicoes POST observadas (as assercoes leem daqui)
const posted = [];

function apiFixture(pathname, method, body) {
  if (method === 'POST') posted.push({ pathname, body });

  // ── fila de impressão do celular ─────────────────────────────
  if (pathname.startsWith('/api/v3/print-queue')) {
    const m = pathname.match(/\/api\/v3\/print-queue\/(\d+)\/(take|done|error|cancel)$/);
    if (m) {
      const id = Number(m[1]); const op = m[2];
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
  if (p === 'auth/login') return { ok: true, token: 'qa-session', person: PERSON, auto_logoff_seconds: 999999 };
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
      // API interceptada
      if (p.startsWith('/api/')) {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(apiFixture(p, req.method, body)));
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
