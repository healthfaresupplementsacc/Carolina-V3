'use strict';
/* AUTO-LOGIN DO SLACK DA CAROLYN (Bruno 09-08: "o sistema nao pode nunca mais
 * esquecer ou nao conseguir logar no seu slack, seu slack tem que estar sempre
 * acessivel").
 *
 * Refaz o que o Bruno fez na mao quando a sessao expirou:
 *   1. abre slack.com/workspace-signin
 *   2. DIGITA o workspace (Input.insertText; injetar .value o React ignora)
 *   3. Enter
 *   4. clica em "Google" e escolhe a conta da Carolyn
 *   5. se pedir senha, digita a senha salva
 *
 * Credenciais: _watch/slack-creds.json (gitignored, NUNCA commitar).
 * Uso: node slack-autologin.js          -> so loga se precisar
 *      node slack-autologin.js --check  -> so diz se esta logado (nao mexe)
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '_watch');
const CREDS = path.join(DIR, 'slack-creds.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[autologin]', ...a);

function creds() {
  try { return JSON.parse(fs.readFileSync(CREDS, 'utf8')); }
  catch (_) { throw new Error('sem _watch/slack-creds.json'); }
}

async function tab(match) {
  const list = await (await fetch('http://localhost:9222/json/list')).json();
  const pages = list.filter((x) => x.type === 'page');
  return pages.find((x) => match.test(x.url || '')) || pages[0];
}

async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('ws timeout')), 15000); ws.onopen = () => { clearTimeout(to); res(); }; ws.onerror = () => { clearTimeout(to); rej(new Error('ws erro')); }; });
  let idc = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const raw = (mth, p = {}) => new Promise((r, rej) => { const id = ++idc; const to = setTimeout(() => rej(new Error('cdp timeout ' + mth)), 45000); pend.set(id, (v) => { clearTimeout(to); r(v); }); ws.send(JSON.stringify({ id, method: mth, params: p })); });
  const ev = async (x) => { const r = await raw('Runtime.evaluate', { expression: x, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
  await raw('Runtime.enable'); await raw('Page.enable');
  return { raw, ev, close: () => ws.close() };
}

async function logado(c) {
  try { return !!(await c.ev("!!document.querySelector('[data-qa=message_input]')")); } catch (_) { return false; }
}

async function clicar(c, texto) {
  const box = await c.ev(`(function(){
    var els=[].slice.call(document.querySelectorAll('button,a,div,li'));
    var el=els.find(function(e){ return (e.textContent||'').trim().indexOf(${JSON.stringify(texto)})>=0 && e.children.length<6; });
    if(!el) return null;
    var r=el.getBoundingClientRect();
    if(r.width===0) return null;
    return JSON.stringify({x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)});
  })()`);
  if (!box) return false;
  const { x, y } = JSON.parse(box);
  await c.raw('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.raw('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return true;
}

async function digitar(c, seletor, texto) {
  const box = await c.ev(`(function(){var i=document.querySelector(${JSON.stringify(seletor)});if(!i)return null;var r=i.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
  if (!box) return false;
  const { x, y } = JSON.parse(box);
  await c.raw('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.raw('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(600);
  await c.raw('Input.insertText', { text: texto });   // React ignora .value injetado
  return true;
}

async function enter(c) {
  for (const type of ['keyDown', 'char', 'keyUp']) {
    await c.raw('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
  }
}

(async () => {
  const cfg = creds();
  const soChecar = process.argv.includes('--check');
  let c = await attach(await tab(/slack\.com/));
  if (await logado(c)) { log('ja logado'); c.close(); process.exit(0); }
  if (soChecar) { log('NAO LOGADO'); c.close(); process.exit(1); }

  log('sessao caiu, logando...');
  await c.raw('Page.navigate', { url: 'https://slack.com/workspace-signin' });
  await sleep(9000);
  if (await digitar(c, 'input[type=text]', cfg.workspace)) {
    log('workspace digitado: ' + cfg.workspace);
    await sleep(1000); await enter(c); await sleep(12000);
  }
  c.close(); c = await attach(await tab(/slack\.com|accounts\.google/));
  if (await logado(c)) { log('LOGADO (sessao do google reaproveitada)'); c.close(); process.exit(0); }

  if (await clicar(c, 'Google')) { log('clicou em Google'); await sleep(12000); }
  c.close(); c = await attach(await tab(/accounts\.google|slack\.com/));
  if (await clicar(c, cfg.google_email)) { log('escolheu a conta ' + cfg.google_email); await sleep(12000); }
  c.close(); c = await attach(await tab(/accounts\.google|slack\.com/));

  // se pedir senha
  const temSenha = await c.ev("!!document.querySelector('input[type=password]')");
  if (temSenha) {
    log('pedindo senha, preenchendo');
    await digitar(c, 'input[type=password]', cfg.google_password);
    await sleep(800); await enter(c); await sleep(15000);
    c.close(); c = await attach(await tab(/slack\.com|accounts\.google/));
  }

  for (let i = 0; i < 8; i++) {
    if (await logado(c)) { log('LOGIN OK'); c.close(); process.exit(0); }
    await sleep(5000);
    c.close(); c = await attach(await tab(/slack\.com/));
  }
  log('NAO CONSEGUI LOGAR (pode ser 2FA ou captcha; avisar o Bruno)');
  try { const s = await c.raw('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DIR, 'autologin-fail.png'), Buffer.from(s.result.data, 'base64')); } catch (_) {}
  c.close(); process.exit(1);
})().catch((e) => { console.error('[autologin] ERRO: ' + e.message); process.exit(1); });
