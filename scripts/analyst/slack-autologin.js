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
  const matches = pages.filter((x) => match.test(x.url || ''));
  if (/accounts\\\.google/.test(match.source || '')) {
    return matches.find((x) => /accounts\.google\.com\//.test(x.url || '')) || matches[0] || pages[0];
  }
  // O Chrome pode acumular abas antigas de workspace-signin. A aba do app e a
  // mais útil para reaproveitar sessão; só então usa uma tela de login.
  return matches.find((x) => /app\.slack\.com\//.test(x.url || '')) || matches[0] || pages[0];
}

async function attach(t) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    try {
      await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('ws timeout')), 15000); ws.onopen = () => { clearTimeout(to); res(); }; ws.onerror = () => { clearTimeout(to); rej(new Error('ws erro')); }; });
      let idc = 0; const pend = new Map();
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
      const raw = (mth, p = {}) => new Promise((r, rej) => { const id = ++idc; const to = setTimeout(() => rej(new Error('cdp timeout ' + mth)), 45000); pend.set(id, (v) => { clearTimeout(to); r(v); }); ws.send(JSON.stringify({ id, method: mth, params: p })); });
      const ev = async (x) => { const r = await raw('Runtime.evaluate', { expression: x, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
      await raw('Runtime.enable'); await raw('Page.enable');
      return { raw, ev, close: () => ws.close() };
    } catch (err) {
      last = err;
      try { ws.close(); } catch (_) {}
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw last;
}

async function logado(c) {
  try { return !!(await c.ev("!!document.querySelector('[data-qa=message_input]')")); } catch (_) { return false; }
}

async function clicar(c, texto) {
  const box = await c.ev(`(function(){
    var els=[].slice.call(document.querySelectorAll('button,a,[role=button]'));
    var exact=els.find(function(e){ return (e.textContent||'').trim()===${JSON.stringify(texto)}; });
    var el=exact||els.find(function(e){ return (e.textContent||'').trim().indexOf(${JSON.stringify(texto)})>=0; });
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
  const campo = `[].slice.call(document.querySelectorAll(${JSON.stringify(seletor)})).find(function(x){var r=x.getBoundingClientRect();return r.width>0&&r.height>0})`;
  const box = await c.ev(`(function(){var i=${campo};if(!i)return null;var r=i.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
  if (!box) return false;
  const { x, y } = JSON.parse(box);
  await c.raw('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.raw('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(600);
  await c.raw('Input.insertText', { text: texto });   // React ignora .value injetado
  let value = await c.ev(`(function(){var i=${campo};return i?i.value:null})()`);
  if (value === texto) return true;
  // Alguns formulários React ignoram Input.insertText na primeira tentativa.
  // Usa o setter nativo e emite os eventos que a camada React observa.
  value = await c.ev(`(function(){var i=${campo};if(!i)return null;var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,${JSON.stringify(texto)});i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return i.value})()`);
  return value === texto;
}

// A tela "Sign in to your workspace" (workspace-signin) aparece tanto no comeco
// quanto DEPOIS do Google: digita o workspace e clica Continue. Devolve true se
// tratou (chamador espera a pagina trocar).
async function tratarWorkspaceSignin(c, cfg) {
  const ehSignin = await c.ev("/slack\\.com$/.test(location.host) && /workspace-signin/.test(location.pathname) && !!(function(){var i=document.querySelector('input[type=text]');return i&&i.getBoundingClientRect().width>0})()");
  if (!ehSignin) return false;
  if (await digitar(c, 'input[type=text]', cfg.workspace)) {
    log('tela de workspace: digitei ' + cfg.workspace);
    await sleep(800);
    if (!await clicar(c, 'Continue')) await enter(c);
    await sleep(12000);
    return true;
  }
  return false;
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
  const workspaceUrl = String(cfg.workspace_url || '').trim();
  await c.raw('Page.navigate', { url: /^https:\/\/[^\s]+\.slack\.com\//.test(workspaceUrl) ? workspaceUrl : 'https://slack.com/workspace-signin' });
  await sleep(9000);
  if (!workspaceUrl && await digitar(c, 'input[type=text]', cfg.workspace)) {
    log('workspace digitado: ' + cfg.workspace);
    // O formulário atual do Slack nem sempre submete com Enter injetado pelo
    // CDP. Preferir o clique real no botão e manter Enter como contingência.
    await sleep(1000);
    if (!await clicar(c, 'Continue')) await enter(c);
    await sleep(12000);
  }
  c.close(); c = await attach(await tab(/slack\.com|accounts\.google/));
  if (await logado(c)) { log('LOGADO (sessao do google reaproveitada)'); c.close(); process.exit(0); }

  if (await clicar(c, 'Google')) { log('clicou em Google'); await sleep(12000); }
  c.close(); c = await attach(await tab(/accounts\.google|slack\.com/));
  if (await tratarWorkspaceSignin(c, cfg)) { c.close(); c = await attach(await tab(/accounts\.google|slack\.com/)); }
  if (await clicar(c, cfg.google_email)) { log('escolheu a conta ' + cfg.google_email); await sleep(12000); }
  c.close(); c = await attach(await tab(/accounts\.google|slack\.com/));

  // 09-09: depois do reboot o Google nao lembrava a conta e abria a pagina
  // "Sign in" pedindo o EMAIL (input[type=email]) — nao existia clique de
  // conta pra dar, e o script desistia. Agora digita o email e segue.
  const temEmail = await c.ev("!!(function(){var i=document.querySelector('input[type=email]');return i&&i.getBoundingClientRect().width>0})()");
  if (temEmail) {
    log('pedindo email, preenchendo ' + cfg.google_email);
    await digitar(c, 'input[type=email]', cfg.google_email);
    await sleep(800);
    if (!await clicar(c, 'Next')) if (!await clicar(c, 'Próxima')) await enter(c);
    await sleep(12000);
    c.close(); c = await attach(await tab(/accounts\.google|slack\.com/));
  }

  // se pedir senha
  const temSenha = await c.ev("!!document.querySelector('input[type=password]')");
  if (temSenha) {
    log('pedindo senha, preenchendo');
    await digitar(c, 'input[type=password]', cfg.google_password);
    await sleep(800);
    if (!await clicar(c, 'Next')) await enter(c);
    await sleep(15000);
    c.close(); c = await attach(await tab(/slack\.com|accounts\.google/));
  }

  for (let i = 0; i < 10; i++) {
    if (await logado(c)) { log('LOGIN OK'); c.close(); process.exit(0); }
    if (await tratarWorkspaceSignin(c, cfg)) { c.close(); c = await attach(await tab(/accounts\.google|slack\.com/)); continue; }
    if (await clicar(c, 'Google')) { log('clicou em Google (de novo)'); await sleep(12000); c.close(); c = await attach(await tab(/accounts\.google|slack\.com/)); continue; }
    if (await clicar(c, cfg.google_email)) { log('escolheu a conta (de novo)'); await sleep(12000); c.close(); c = await attach(await tab(/accounts\.google|slack\.com/)); continue; }
    await sleep(5000);
    c.close(); c = await attach(await tab(/slack\.com/));
  }
  // diagnostico: o que a pagina esta pedindo (2FA? captcha? senha errada?)
  try {
    const dica = await c.ev("(function(){var t=(document.body&&document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300);return location.href.slice(0,120)+' :: '+t})()");
    log('parado em: ' + dica);
    // CAPTCHA / verificacao do Google: robo nao passa. Marca pra humano e o
    // watchdog para de tentar (tentativa repetida e o que ESCALA pro captcha).
    if (/characters you see|text you hear|captcha|verify it.s you|unusual activity|2-step|verification code/i.test(dica)) {
      fs.writeFileSync(path.join(DIR, 'login-needs-human.txt'), new Date().toISOString() + ' ' + dica.slice(0, 400));
      log('PRECISA DE HUMANO (captcha/verificacao do Google). Gravei _watch/login-needs-human.txt e parei de tentar.');
      c.close(); process.exit(3);
    }
  } catch (_) {}
  log('NAO CONSEGUI LOGAR (pode ser 2FA ou captcha; avisar o Bruno)');
  try { const s = await c.raw('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DIR, 'autologin-fail.png'), Buffer.from(s.result.data, 'base64')); } catch (_) {}
  c.close(); process.exit(1);
})().catch((e) => { console.error('[autologin] ERRO: ' + e.message); process.exit(1); });
