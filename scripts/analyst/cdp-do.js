'use strict';
/* CDP-DO — controle manual, passo a passo, do Chrome da Carolyn (09-09).
 * Serve pra EU ver a tela e agir com screenshot entre cada passo, em vez do
 * autologin cego. Uso:
 *   node cdp-do.js tabs
 *   node cdp-do.js shot <tabPrefix> <arquivo.png>
 *   node cdp-do.js eval <tabPrefix> "<expressao js>"
 *   node cdp-do.js type <tabPrefix> "<seletor css>" "<texto>"
 *   node cdp-do.js click <tabPrefix> "<texto do botao>"
 *   node cdp-do.js clicksel <tabPrefix> "<seletor css>"
 *   node cdp-do.js key <tabPrefix> Enter
 *   node cdp-do.js nav <tabPrefix> <url>
 *   node cdp-do.js close <tabPrefix>
 */
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tabs() { return (await (await fetch('http://localhost:9222/json/list')).json()).filter((t) => t.type === 'page'); }
async function pick(prefix) {
  const t = (await tabs()).find((x) => x.id.startsWith(prefix));
  if (!t) throw new Error('aba nao achada: ' + prefix);
  return t;
}
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('ws timeout')), 15000); ws.onopen = () => { clearTimeout(to); res(); }; ws.onerror = () => { clearTimeout(to); rej(new Error('ws erro')); }; });
  let idc = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const raw = (mth, p = {}) => new Promise((r, rej) => { const id = ++idc; const to = setTimeout(() => rej(new Error('cdp timeout ' + mth)), 30000); pend.set(id, (v) => { clearTimeout(to); r(v); }); ws.send(JSON.stringify({ id, method: mth, params: p })); });
  const ev = async (x) => { const r = await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'exception'); return r.result && r.result.result ? r.result.result.value : undefined; };
  await raw('Runtime.enable'); await raw('Page.enable');
  return { raw, ev, close: () => ws.close() };
}
const centro = (sel) => `(function(){var i=[].slice.call(document.querySelectorAll(${JSON.stringify(sel)})).find(function(x){var r=x.getBoundingClientRect();return r.width>0&&r.height>0});if(!i)return null;var r=i.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`;
async function clickXY(c, x, y) {
  await c.raw('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.raw('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.raw('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

(async () => {
  const [cmd, prefix, a, b] = process.argv.slice(2);
  if (cmd === 'tabs') { for (const t of await tabs()) console.log(t.id, '|', (t.title || '').slice(0, 50), '|', (t.url || '').slice(0, 110)); return; }
  const t = await pick(prefix);
  if (cmd === 'close') { await fetch('http://localhost:9222/json/close/' + t.id); console.log('fechada', t.id); return; }
  const c = await attach(t);
  try {
    if (cmd === 'shot') {
      const s = await c.raw('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(a, Buffer.from(s.result.data, 'base64'));
      console.log('shot ->', a, '| url:', (await c.ev('location.href')).slice(0, 120));
    } else if (cmd === 'eval') {
      console.log(JSON.stringify(await c.ev(a)));
    } else if (cmd === 'nav') {
      await c.raw('Page.navigate', { url: a }); await sleep(6000); console.log('url agora:', await c.ev('location.href'));
    } else if (cmd === 'type') {
      const box = await c.ev(centro(a)); if (!box) throw new Error('campo nao visivel: ' + a);
      const { x, y } = JSON.parse(box); await clickXY(c, x, y); await sleep(500);
      await c.raw('Input.insertText', { text: b });
      await sleep(300);
      console.log('valor agora:', await c.ev(`(function(){var i=[].slice.call(document.querySelectorAll(${JSON.stringify(a)})).find(function(x){return x.getBoundingClientRect().width>0});return i?i.value:null})()`));
    } else if (cmd === 'clicksel') {
      const box = await c.ev(centro(a)); if (!box) throw new Error('elemento nao visivel: ' + a);
      const { x, y } = JSON.parse(box); await clickXY(c, x, y); await sleep(4000);
      console.log('clicado', a, '| url:', (await c.ev('location.href')).slice(0, 120));
    } else if (cmd === 'click') {
      const box = await c.ev(`(function(){var els=[].slice.call(document.querySelectorAll('button,a,[role=button],div[role=link],span'));var t=${JSON.stringify(a)};var el=els.find(function(e){return (e.textContent||'').trim()===t})||els.find(function(e){return (e.textContent||'').trim().indexOf(t)>=0&&e.children.length<4});if(!el)return null;var r=el.getBoundingClientRect();if(r.width===0)return null;return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
      if (!box) throw new Error('botao nao achado: ' + a);
      const { x, y } = JSON.parse(box); await clickXY(c, x, y); await sleep(5000);
      console.log('clicado', JSON.stringify(a), '| url:', (await c.ev('location.href')).slice(0, 120));
    } else if (cmd === 'key') {
      for (const type of ['keyDown', 'char', 'keyUp']) await c.raw('Input.dispatchKeyEvent', { type, key: a, code: a, windowsVirtualKeyCode: a === 'Enter' ? 13 : 0, text: a === 'Enter' ? '\r' : '' });
      await sleep(5000); console.log('tecla', a, '| url:', (await c.ev('location.href')).slice(0, 120));
    } else { console.log('comando?'); }
  } finally { c.close(); }
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
