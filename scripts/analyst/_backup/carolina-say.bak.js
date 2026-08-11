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

async function main() {
  if (!TEXT) throw new Error('carolina-text.txt vazio');
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
  await evalJs('window.__carEl.focus(),true');
  await send('Input.insertText', { text: TEXT });
  await sleep(600);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(2200);
  const s2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(DIR + 'say-after.png', Buffer.from(s2.data, 'base64'));
  console.log('CAROL ENVIOU (' + MODE + ') ✓');
  ws.close();
}
main().then(() => process.exit(0), (e) => { console.error('ERRO:', e.message); process.exit(1); });
