'use strict';
/**
 * QA harness da PAUSA DO GRUPO no kiosk (/op) — Bruno 08-19, evento 3583.
 * Rodar da RAIZ do projeto:  node docs/architecture/_qa/qa-op-pausa.js
 *
 * O que prova, na TELA de verdade (não em mock de unidade):
 *   1. o card pendente "Você estava nisso desde o começo?" aparece no topo do /op
 *      quando a pessoa foi anexada a uma pausa sem estar no kiosk (caso 3583);
 *   2. os DOIS botões têm o texto e os horários que o Bruno pediu:
 *      "Desde o começo (HH:MM)" e "Comecei agora (HH:MM)";
 *   3. a tela DIZ o que foi assumido enquanto ninguém respondeu (REGRA #0);
 *   4. responder chama POST /api/v3/op/pause/answer com o since certo e o card some;
 *   5. entrar numa pausa em andamento abre o overlay com a MESMA pergunta antes de
 *      congelar qualquer coisa (nada de join cego);
 *   6. o banner "Você está em pausa" segue mostrando as tarefas congeladas.
 *
 * Sobe um http estático servindo src/op e INTERCEPTA todo /api/** com fixtures.
 * NUNCA fala com servidor, banco, Slack, EMS ou Veeqo.
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
const PERSON = { id: 7, display_name: 'Bruno Sarmento', role: 'operator', is_sandbox: true };

// ── fixtures: a forma REAL do evento 3583 ────────────────────────
// Vitor abriu o break 11:18:36 e o Bruno Sarmento foi anexado 11:57:53, sem
// estar no kiosk. A revisão dele (#3575) ficou rodando por cima da pausa.
let PENDING = {
  event_id: 3583,
  pause_event_id: 3578,
  starter_name: 'Vitor',
  note: 'Organizando estoque que chegaram pallets',
  pause_started_at: '2026-08-19T15:18:36Z',
  pause_hhmm: '11:18',
  joined_at: '2026-08-19T15:57:53Z',
  joined_hhmm: '11:57',
  assumed: 'agora',
};
const REVIEW = { id: 3575, slug: 'review', started_at: '2026-08-19T13:50:06Z', ended_at: null, is_paused: true, description: null };
const BREAK = { id: 3583, slug: 'break', started_at: '2026-08-19T15:18:36Z', ended_at: null, is_paused: false, description: 'Organizando estoque que chegaram pallets' };
let TODAY = { ok: true, goal: 8, events: [REVIEW, BREAK] };

const posted = [];

function apiFixture(pathname, method, body) {
  if (method === 'POST') posted.push({ pathname, body });

  const p = pathname.replace('/api/v3/op/', '');
  if (p === 'auth/login') return { ok: true, session_token: 'qa-session', person: PERSON, auto_logoff_seconds: 999999 };
  if (p === 'auth/heartbeat' || p === 'auth/logout') return { ok: true };
  if (p === 'active-operators') return { ok: true, operators: [] };
  if (p === 'ems/my-activity') return { ok: true, detected: null };
  if (p === 'pending-confirmations') return { ok: true, question: null };
  if (p === 'end-of-day/check') return { ok: true, should_ask: false };

  // ── PAUSA (o que este harness testa) ───────────────────────────
  if (p === 'pause/pending') return { ok: true, question: PENDING };
  if (p === 'pause/answer') {
    const since = body && body.since;
    PENDING = null;                                   // respondida → some do topo
    return { ok: true, since, credited_seconds: since === 'inicio' ? 5071 : 0 };
  }
  if (p === 'pause/join') return { ok: true, since: body && body.since, assumed: false, frozen: 2, credited_seconds: (body && body.since) === 'inicio' ? 1800 : 0 };
  // entrar numa pausa alheia: devolve a PERGUNTA, não congela
  if (/^event\/\d+\/join$/.test(p)) {
    const since = body && body.since;
    if (since !== 'inicio' && since !== 'agora') {
      return { ok: true, pause_join_question: true, pause_event_id: 3578, pause_started_at: '2026-08-19T15:18:36Z', starter_person_id: 4 };
    }
    return { ok: true, since, frozen: 2 };
  }

  if (pathname.startsWith('/api/v3/architect/person/')) return { ok: true, ...TODAY };
  if (pathname.startsWith('/api/v3/print-queue')) return { data: { jobs: [] } };
  if (p === 'picklist') return { total_orders: 0, groups: [] };
  if (p === 'stock-gaps') return { items: [] };
  return { ok: true };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(u.pathname);
      if (p === '/op/config.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end('window.HF_OP_CONFIG = ' + JSON.stringify({ pageToken: TOKEN, workspace: true }) + ';');
        return;
      }
      if (p.startsWith('/api/')) {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw; }
          const out = apiFixture(p, req.method, body) || {};
          const code = out._status || 200;
          delete out._status;
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out));
        });
        return;
      }
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
    const f = path.join(QA, 'op-pausa-' + name + '.png');
    await page.screenshot({ path: f });
    console.log('    shot → ' + path.relative(ROOT, f));
  };

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.HF_PAUSE, { timeout: 8000 });
  rec('boot', 'window.HF_PAUSE definido por /op/pause-ui.js', true);

  for (const d of ['1', '2', '3', '4']) {
    const btn = await page.$('[data-act="pinkey"][data-arg="' + d + '"]');
    if (btn) await btn.click();
  }
  await sleep(1100);
  await shot('01-pergunta-pendente');
  rec('boot', 'app carregou sem erro de console', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  // ── 1. O CARD DA PERGUNTA ─────────────────────────────────────
  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  rec('pergunta', 'o título é o que o Bruno pediu',
    /Você estava nisso desde o começo\?/.test(txt), '');
  rec('pergunta', 'opção 1: "Desde o começo (11:18)" com o horário REAL da pausa',
    /Desde o começo \(11:18\)/.test(txt), '');
  rec('pergunta', 'opção 2: "Comecei agora (11:57)" com o horário da entrada',
    /Comecei agora \(11:57\)/.test(txt), '');
  rec('pergunta', 'diz de quem era a pausa e a nota dela',
    /Vitor/.test(txt) && /Organizando estoque/.test(txt), '');
  rec('pergunta', 'REGRA #0: a tela DIZ o que foi assumido enquanto ninguém respondeu',
    /Por enquanto contei a partir das 11:57/.test(txt), '');
  rec('pergunta', 'tranquiliza o operador (nada se perde)', /nada se perde/.test(txt), '');
  rec('estilo', 'sem em dash no texto da pergunta', txt.indexOf('—') === -1, '');

  // botões grandes o bastante pro toque com luva
  const btnBox = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('[data-act="pauseAnswer"]'));
    return b.map((x) => ({ arg: x.getAttribute('data-arg'), h: Math.round(x.getBoundingClientRect().height) }));
  });
  rec('pergunta', 'os dois botões existem com o event_id e a escolha',
    btnBox.length === 2 && btnBox[0].arg === '3583:inicio' && btnBox[1].arg === '3583:agora',
    JSON.stringify(btnBox));
  rec('pergunta', 'botões com 44px+ de altura (toque com luva)',
    btnBox.every((x) => x.h >= 44), btnBox.map((x) => x.h).join('/'));

  // ── 2. O BANNER DE PAUSA CONVIVE COM A PERGUNTA ───────────────
  rec('banner', 'banner "Você está em pausa" aparece junto', /Você está em pausa/.test(txt), '');
  rec('banner', 'mostra as tarefas congeladas e que o relógio parou',
    /1 tarefa\(s\) congelada\(s\)/.test(txt) && /o relógio parou/.test(txt), '');

  // ── 3. RESPONDER "DESDE O COMEÇO" ─────────────────────────────
  const before = posted.length;
  await page.click('[data-act="pauseAnswer"][data-arg="3583:inicio"]');
  await sleep(900);
  await shot('02-respondeu-desde-o-comeco');
  const ans = posted.slice(before).find((x) => x.pathname === '/api/v3/op/pause/answer');
  rec('resposta', 'toca "Desde o começo" → POST /pause/answer com since=inicio',
    !!ans && ans.body && ans.body.since === 'inicio' && ans.body.event_id === 3583,
    ans ? JSON.stringify(ans.body) : 'sem POST');
  const txt2 = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  rec('resposta', 'o card some depois de respondida',
    !/Você estava nisso desde o começo\?/.test(txt2), '');
  rec('resposta', 'avisa o ajuste em minutos (5071s = 85 min)', /85 min/.test(txt2), '');

  // ── 4. ENTRAR NUMA PAUSA EM ANDAMENTO → MESMA PERGUNTA ────────
  const opened = await page.evaluate(() => {
    return window.HF_PAUSE.askJoin({
      pause_join_question: true, pause_event_id: 3578,
      pause_started_at: '2026-08-19T15:18:36Z',
    }, '11:18');
  });
  await sleep(400);
  await shot('03-overlay-entrar-na-pausa');
  const txt3 = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  rec('entrar', 'entrar numa pausa alheia abre o overlay em vez de congelar às cegas', opened === true, '');
  rec('entrar', 'o overlay faz a MESMA pergunta',
    /Você estava nisso desde o começo\?/.test(txt3), '');
  rec('entrar', 'o overlay traz os dois horários',
    /Desde o começo \(11:18\)/.test(txt3) && /Comecei agora \(/.test(txt3), '');

  const before2 = posted.length;
  await page.click('[data-act="pauseJoinPick"][data-arg="3578:inicio"]');
  await sleep(800);
  await shot('04-entrou-desde-o-comeco');
  const join = posted.slice(before2).find((x) => x.pathname === '/api/v3/op/pause/join');
  rec('entrar', 'escolher no overlay → POST /pause/join com since=inicio',
    !!join && join.body && join.body.since === 'inicio' && join.body.pause_event_id === 3578,
    join ? JSON.stringify(join.body) : 'sem POST');

  rec('boot', 'nenhum erro de console no fim do roteiro', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();

  const fails = results.filter((r) => !r.pass);
  fs.writeFileSync(path.join(QA, 'qa-op-pausa-report.json'),
    JSON.stringify({ at: new Date().toISOString(), total: results.length, failed: fails.length, results }, null, 2));
  console.log('\n' + (results.length - fails.length) + '/' + results.length + ' PASS');
  if (fails.length) {
    console.log('\nFALHAS:');
    fails.forEach((f) => console.log('  [' + f.group + '] ' + f.name + (f.detail ? '  ·  ' + f.detail : '')));
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
