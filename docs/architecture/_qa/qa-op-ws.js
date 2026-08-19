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
    { id: 2, kind: 'entrada', qty: 48, product: 'Rutin', nickname: 'Rutin 500', status: 'approved', created_at: '2026-08-18T12:40:00Z' },
    { id: 3, kind: 'count', qty: 51, product: 'Rutin', nickname: 'Rutin 500', status: 'rejected', created_at: '2026-08-18T12:10:00Z' },
    { id: 4, kind: 'damaged', qty: 1, product: 'Benfotiamine', nickname: 'Benfotiamine 300', status: 'applied', created_at: '2026-08-18T11:55:00Z' },
    { id: 5, kind: 'restock', qty: 16, product: 'Benfotiamine', nickname: 'Benfotiamine 300', status: 'applied', created_at: '2026-08-18T11:30:00Z' },
  ],
};
// /api/v3/architect/person/:id/today devolve {events:[...]} — as tasks abertas
// sao os events sem ended_at (ver loadData em app.js).
const TODAY = {
  ok: true, goal: 8,
  events: [
    { id: 501, slug: 'order_printing', started_at: new Date(Date.now() - 20 * 60000).toISOString(), ended_at: null, is_paused: false },
    { id: 500, slug: 'labeling', started_at: new Date(Date.now() - 120 * 60000).toISOString(), ended_at: new Date(Date.now() - 60 * 60000).toISOString() },
  ],
};

// requisicoes POST observadas (as assercoes leem daqui)
const posted = [];

function apiFixture(pathname, method, body) {
  if (method === 'POST') posted.push({ pathname, body });
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
  rec('home', 'banner da Central aparece com task de P&P', /Central de/.test(bannerTxt), '');

  // abre a Central
  const openBtn = await page.$('[data-act="openWorkspace"]');
  rec('home', 'botao Abrir existe', !!openBtn);
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

  // fecha e volta pra home (regra de abrir/fechar preservada)
  const close = await page.$('[data-act="closeWorkspace"]');
  if (close) await close.click();
  await sleep(800);
  await shot('08-voltou-home');
  const hTxt = await page.evaluate(() => document.body.innerText);
  rec('central', 'Voltar fecha a Central e volta pra home', /Iniciar Tarefa/.test(hTxt), '');

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
