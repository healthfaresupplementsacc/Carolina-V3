'use strict';
/* Carol posta no #admin-orin via CDP (Chrome 9222). Texto do arquivo em argv[2].
   Autônomo: se o Chrome 9222 não estiver de pé, sobe via o launcher da Carolina. */
const fs = require('fs');
const { execSync } = require('child_process');
const TEAM = 'T020AHKP5D5', CH = 'C0B36DR5MP1';
const TXT_FILE = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureChrome() {
  try { await (await fetch('http://localhost:9222/json/version')).json(); return; } catch {}
  try {
    execSync('powershell -ExecutionPolicy Bypass -File "C:\\Claude Projects\\Supplements Production Line\\healthfare-tracker\\scripts\\analyst\\carolina-chrome.ps1"', { stdio: 'ignore' });
  } catch {}
  for (let i = 0; i < 20; i++) { try { await (await fetch('http://localhost:9222/json/version')).json(); return; } catch { await sleep(1500); } }
  throw new Error('Chrome da Carolina não subiu na 9222');
}

async function main() {
  const TEXT = fs.readFileSync(TXT_FILE, 'utf8').trim();
  if (!TEXT) throw new Error('texto vazio');
  await ensureChrome();
  const list = await (await fetch('http://localhost:9222/json/list')).json();
  let t = list.find((x) => x.type === 'page' && /app\.slack\.com/.test(x.url || ''));
  if (!t) { t = await (await fetch('http://localhost:9222/json/new?url=' + encodeURIComponent('https://app.slack.com/client/' + TEAM + '/' + CH), { method: 'PUT' })).json(); await sleep(9000); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws falhou')); });
  let idc = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { res } = pend.get(m.id); pend.delete(m.id); res(m.result); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++idc; pend.set(id, { res }); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
  await send('Page.enable'); await send('Runtime.enable');
  try { await fetch('http://localhost:9222/json/activate/' + t.id); } catch {}
  await send('Page.navigate', { url: 'https://app.slack.com/client/' + TEAM + '/' + CH });
  const PICK = '(function(){var all=[].slice.call(document.querySelectorAll(\'[data-qa="message_input"] [contenteditable="true"]\'));var el=all.find(function(e){return !e.closest(\'[data-qa="threads_flexpane"]\')});if(!el)return false;el.focus();window.__c=el;return true;})()';
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    await sleep(2000); ok = await evalJs(PICK);
    if (!ok) { const closed = await evalJs('(function(){var b=document.querySelector(\'[data-qa="close_flexpane"],button[aria-label="Fechar"],button[aria-label="Close"]\');if(b){b.click();return 1}return 0})()'); if (!closed) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 }); } }
  }
  if (!ok) { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(TXT_FILE + '.fail.png', Buffer.from(s.data, 'base64')); throw new Error('composer não apareceu'); }
  await sleep(1000);
  await evalJs('window.__c.focus(),true');
  await send('Input.insertText', { text: TEXT });
  await sleep(700);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(2500);
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(TXT_FILE + '.sent.png', Buffer.from(s.data, 'base64'));
  console.log('CAROL ENVIOU ✓');
  ws.close();
}
main().then(() => process.exit(0), (e) => { console.error('ERRO:', e.message); process.exit(1); });
