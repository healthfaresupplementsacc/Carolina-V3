'use strict';
/* CAROL FALA NO SLACK via CDP (Chrome 9222). Genérico pro watch/agenda.
   Regra Carol (Bruno 07-29): tom HUMANO, SEM emoji e SEM travessão (—).
   Uso:
     node carolina-say.js <channel|thread> [thread_root_ts]        -> texto de carolina-text.txt (mesma pasta)
     node carolina-say.js <channel|thread> [thread_root_ts] --text "..."   -> texto inline
     node carolina-say.js <channel|thread> [thread_root_ts] --file <path>  -> texto de arquivo específico */
const fs = require('fs');
const path = require('path');
const DIR = __dirname + path.sep;
const TEAM = 'T020AHKP5D5';
// Canais: admin-orin (default) | orders/ops = orders-and-inventory (operadores)
const CH_ALIAS = { admin: 'C0B36DR5MP1', 'admin-orin': 'C0B36DR5MP1', orders: 'C09UNBXFRKK', ops: 'C09UNBXFRKK', operadores: 'C09UNBXFRKK', 'orders-and-inventory': 'C09UNBXFRKK' };
const argv = process.argv.slice(2);
const MODE = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : 'channel';
const ROOT = (argv[1] && !argv[1].startsWith('--')) ? argv[1] : null;
const chi = argv.indexOf('--ch');
const CH = chi >= 0 ? (CH_ALIAS[argv[chi + 1]] || argv[chi + 1]) : 'C0B36DR5MP1';
const ti = argv.indexOf('--text'); const fi = argv.indexOf('--file');
const TEXT = (ti >= 0 ? String(argv[ti + 1] || '')
  : fi >= 0 ? fs.readFileSync(argv[fi + 1], 'utf8')
    : fs.readFileSync(DIR + 'carolina-text.txt', 'utf8')).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// trava contra o watchdog (compartilham a MESMA aba do Chrome; sem isso o
// watchdog navega no meio do envio e a mensagem vira rascunho perdido)
const WATCH_DIR = DIR + '_watch' + path.sep;
const SAY_LOCK = WATCH_DIR + 'say.lock';
const SCRAPE_LOCK = WATCH_DIR + 'scrape.lock';
function lockFresh(f, ms) { try { return (Date.now() - fs.statSync(f).mtimeMs) < ms; } catch (_) { return false; } }
async function takeSayLock() {
  try { fs.mkdirSync(WATCH_DIR, { recursive: true }); } catch (_) {}
  for (let i = 0; i < 20 && lockFresh(SCRAPE_LOCK, 60000); i++) await sleep(2000); // espera o tick do watchdog acabar
  for (let i = 0; i < 45 && lockFresh(SAY_LOCK, 90000); i++) await sleep(2000);    // espera OUTRA Carol terminar (2 envios simultâneos brigam pela aba)
  fs.writeFileSync(SAY_LOCK, String(Date.now()));
}
function dropSayLock() { try { fs.unlinkSync(SAY_LOCK); } catch (_) {} }

async function main() {
  if (!TEXT) throw new Error('carolina-text.txt vazio');
  await takeSayLock();
  const list = await (await fetch('http://localhost:9222/json/list')).json();
  let t = list.find((x) => x.type === 'page' && /app\.slack\.com/.test(x.url || ''));
  if (!t) { t = await (await fetch('http://localhost:9222/json/new?url=' + encodeURIComponent('https://app.slack.com/client/' + TEAM + '/' + CH), { method: 'PUT' })).json(); await sleep(8000); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws falhou')); });
  let idc = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++idc; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
  await send('Page.enable'); await send('Runtime.enable');
  try { await fetch('http://localhost:9222/json/activate/' + t.id); } catch {}

  const url = MODE === 'thread' && ROOT
    ? 'https://app.slack.com/client/' + TEAM + '/' + CH + '/thread/' + CH + '-' + ROOT
    : 'https://app.slack.com/client/' + TEAM + '/' + CH;
  await send('Page.navigate', { url });
  // seletor: composer do thread (flexpane) OU do canal (fora do flexpane)
  const PICK = '(function(){var all=[].slice.call(document.querySelectorAll(\'[data-qa="message_input"] [contenteditable="true"]\'));'
    + 'var inTh=function(el){return !!el.closest(\'[data-qa="threads_flexpane"]\')};'
    + 'var want=' + JSON.stringify(MODE) + '==="thread";'
    + 'var el=all.find(function(e){return inTh(e)===want});'
    + 'if(!el)return false; el.focus(); window.__carEl=el; return true;})()';
  let ok = false;
  for (let i = 0; i < 25 && !ok; i++) {
    await sleep(2000);
    ok = await evalJs(PICK);
    if (!ok && MODE === 'channel') {
      // thread aberto em tela cheia rouba a view → fecha (botão ✕/← do flexpane, senão Escape)
      const closed = await evalJs('(function(){var b=document.querySelector(\'[data-qa="close_flexpane"],[data-qa="thread_view_back_button"],button[aria-label="Fechar"],button[aria-label="Close"]\');if(b){b.click();return true}return false})()');
      if (!closed) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }); }
    }
  }
  if (!ok) { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(DIR + 'say-fail.png', Buffer.from(s.data, 'base64')); throw new Error('composer (' + MODE + ') não apareceu — screenshot say-fail.png'); }
  await sleep(1000);
  // confere que a aba ainda está na conversa certa (o watchdog pode ter navegado)
  const here = await evalJs('location.pathname');
  if (!String(here || '').includes(CH)) throw new Error('aba saiu da conversa alvo (' + here + ') — tenta de novo');
  // TUDO via DOM (execCommand + clique no botão de enviar) — os eventos de teclado
  // do protocolo (Enter) pararam de submeter no Slack novo; o clique no botão é o
  // caminho real de envio e funciona mesmo com a janela em segundo plano.
  const MARK = TEXT.slice(0, 24);
  const put = await evalJs('(function(){var el=window.__carEl;el.focus();' +
    'document.execCommand("selectAll",false,null);' +
    'var ok=document.execCommand("insertText",false,' + JSON.stringify(TEXT) + ');' +
    'return {ok:ok,has:(el.textContent||"").indexOf(' + JSON.stringify(MARK) + ')>=0};})()');
  if (!put || !put.has) throw new Error('texto não entrou no composer (execCommand ' + JSON.stringify(put) + ')');
  await sleep(500);
  const clicked = await evalJs('(function(){var b=document.querySelector(\'[data-qa="texty_send_button"]:not([disabled]),button[aria-label*="Send"]:not([disabled]),button[aria-label*="Enviar"]:not([disabled])\');' +
    'if(!b)return false; b.click(); return true;})()');
  if (!clicked) throw new Error('botão de enviar não achado/habilitado');
  await sleep(1800);
  // VERIFICAÇÃO REAL: enviou = composer esvaziou E a msg aparece na conversa.
  let left = await evalJs('(window.__carEl && window.__carEl.textContent || "").trim().length');
  const landed = await evalJs('(function(){var ns=document.querySelectorAll(\'[data-qa="message-text"],.p-rich_text_section\');' +
    'for(var i=ns.length-1;i>=Math.max(0,ns.length-8);i--){if((ns[i].textContent||"").indexOf(' + JSON.stringify(MARK) + ')>=0)return true;}return false;})()');
  const s2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(DIR + 'say-after.png', Buffer.from(s2.data, 'base64'));
  if (left && !landed) throw new Error('NÃO CONFIRMADO: composer ainda tem texto e a msg não apareceu — ver say-after.png');
  console.log('CAROL ENVIOU (' + MODE + ') ✓ confirmado' + (landed ? ' (msg visível na conversa)' : ' (composer vazio)'));
  ws.close();
}
main().then(() => { dropSayLock(); process.exit(0); }, (e) => { dropSayLock(); console.error('ERRO:', e.message); process.exit(1); });
