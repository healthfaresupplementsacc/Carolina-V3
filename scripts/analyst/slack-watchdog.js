'use strict';
/* SLACK WATCHDOG 24/7 (Bruno 08-xx) — roda como Scheduled Task no PC sempre-ligado.
 * Faz DUAS coisas, pra sempre:
 *   1) mantém o Chrome do Claude (perfil hf-carolina-chrome, CDP 9222) VIVO — se
 *      cair, relança via carolina-chrome.ps1. Nunca mais "estava down quando precisei".
 *   2) lê o Slack via CDP a cada POLL_MS e ANOTA mensagens novas dirigidas ao Claude
 *      (do Bruno OU @claude/@carol OU pergunta) num arquivo INBOX que o Claude lê no
 *      /loop. Não responde sozinho — só captura pra nunca perder.
 *
 * Config por env (com defaults):
 *   WATCH_CHANNELS = IDs separados por vírgula (default: DM do Bruno + admin-orin)
 *   POLL_MS        = intervalo de leitura (default 10000)
 * Estado em scripts/analyst/_watch/ : inbox.jsonl (mensagens), seen.json (dedupe), heartbeat.txt
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DIR = path.join(__dirname, '_watch');
try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}
const INBOX = path.join(DIR, 'inbox.jsonl');
const SEEN = path.join(DIR, 'seen.json');
const HB = path.join(DIR, 'heartbeat.txt');
const LAUNCHER = path.join(__dirname, 'carolina-chrome.ps1');

const POLL_MS = parseInt(process.env.POLL_MS || '10000', 10);
const TEAM = process.env.SLACK_TEAM || 'T020AHKP5D5';
const BRUNO = 'U03URLL1D4L';                 // Bruno Camp
const CLAUDE_ID = process.env.CLAUDE_ID || 'D045L79UMME'; // "eu" (Claude) — mensagens que me marcam
// Canal principal = supplements-dashboard. Também vigio admin-orin (onde tags/menções aparecem).
// Regra do Bruno: qualquer msg que (a) esteja no supplements-dashboard, OU (b) marque o Claude, OU
// (c) marque o Bruno, OU (d) pareça pergunta → vai pro inbox.
const PRIMARY = 'C0BUKK6EH98';               // supplements-dashboard (PRINCIPAL)
const CHANNELS = (process.env.WATCH_CHANNELS || PRIMARY + ',C0B36DR5MP1').split(',').map((s) => s.trim()).filter(Boolean);
const QRE = /\?|\bqual\b|\bquant|\bcomo\b|\bpor que|\bmeta|\bgoal|\bme (diz|fala|mostra|manda)\b|\bpreciso\b|@claude|@carol|@bruno/i;

let seen = new Set();
try { seen = new Set(JSON.parse(fs.readFileSync(SEEN, 'utf8'))); } catch (_) {}
function saveSeen() { try { fs.writeFileSync(SEEN, JSON.stringify([...seen].slice(-4000))); } catch (_) {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mantém o Chrome vivo ──────────────────────────────────────────────
async function chromeUp() { try { const r = await fetch('http://localhost:9222/json/version'); return r.ok; } catch { return false; } }
function relaunchChrome() {
  return new Promise((res) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER], { windowsHide: true }, () => res());
  });
}
async function ensureChrome() {
  if (await chromeUp()) return true;
  console.log('[watchdog] Chrome caiu → relançando');
  await relaunchChrome();
  for (let i = 0; i < 20; i++) { if (await chromeUp()) return true; await sleep(1500); }
  return false;
}

// ── CDP mínimo pra ler o Slack ────────────────────────────────────────
async function cdp() {
  const list = await (await fetch('http://localhost:9222/json/list')).json();
  let t = list.find((x) => x.type === 'page' && /app\.slack\.com/.test(x.url || ''));
  if (!t) { t = await (await fetch('http://localhost:9222/json/new?url=' + encodeURIComponent('https://app.slack.com/client/' + TEAM), { method: 'PUT' })).json(); await sleep(9000); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
  let idc = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  const send = (mth, p = {}) => new Promise((r) => { const id = ++idc; pend.set(id, r); ws.send(JSON.stringify({ id, method: mth, params: p })); });
  await send('Runtime.enable');
  return { send, close: () => ws.close(), ev: (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => r && r.result ? r.result.value : undefined) };
}

// lê as últimas msgs do canal atual via a store interna do Slack (boot data / redux)
// Estratégia simples e robusta: navega pro canal e raspa o DOM das mensagens visíveis.
async function readChannel(c, chan) {
  await c.send('Page.navigate', { url: 'https://app.slack.com/client/' + TEAM + '/' + chan });
  for (let i = 0; i < 12; i++) { const ok = await c.ev('!!document.querySelector("[data-qa=message_pane],[data-qa=virtual-list]")'); if (ok) break; await sleep(1500); }
  await sleep(1500);
  // Slack virtualiza a lista: força rolagem pro fim pra renderizar as msgs mais novas
  await c.ev(`(function(){var l=document.querySelector('.c-virtual_list__scroll_container,[data-qa=slack_kit_scrollbar] .c-scrollbar__hider,[data-qa=message_pane] .c-scrollbar__hider');if(l){l.scrollTop=l.scrollHeight;}return !!l;})()`);
  await sleep(1200);
  const rows = await c.ev(`(function(){
    var out=[]; var nodes=document.querySelectorAll('[data-qa="virtual-list-item"],.c-virtual_list__item');
    nodes.forEach(function(n){
      var ts=n.getAttribute('id')||n.getAttribute('data-item-key')||'';
      var senderEl=n.querySelector('[data-qa=message_sender_name],.c-message__sender_button');
      var textEl=n.querySelector('[data-qa=message-text],.p-rich_text_section,.c-message__body');
      var sender=senderEl?senderEl.textContent.trim():'';
      var text=textEl?textEl.textContent.trim():'';
      if(text) out.push({ts:ts, sender:sender, text:text});
    });
    return out.slice(-20);
  })()`);
  return rows || [];
}

// se o Socket Mode listener está vivo (push em tempo real), o watchdog NÃO captura
// por DOM (evita duplicata) — fica só mantendo o Chrome vivo.
function listenerAlive() {
  try {
    const t = fs.readFileSync(path.join(DIR, 'listener-alive.txt'), 'utf8').trim();
    return (Date.now() - new Date(t).getTime()) < 90 * 1000;
  } catch (_) { return false; }
}

async function tick() {
  if (!(await ensureChrome())) { console.log('[watchdog] Chrome não subiu; tentando no próximo tick'); return; }
  if (listenerAlive()) { fs.writeFileSync(HB, new Date().toISOString()); return; } // socket cobre; só keep-alive
  let c;
  try { c = await cdp(); } catch (e) { console.log('[watchdog] cdp falhou:', e.message); return; }
  try {
    for (const chan of CHANNELS) {
      let rows = [];
      try { rows = await readChannel(c, chan); } catch (_) { continue; }
      const isPrimary = chan === PRIMARY;
      for (const m of rows) {
        const key = chan + ':' + m.ts + ':' + m.text.slice(0, 24);
        if (!m.ts || seen.has(key)) continue;
        // ignora o que o próprio Claude/Carol/bot postou (não me respondo)
        if (/^(carol|carolina|healthfare tracker|healthfare frete)/i.test(m.sender)) { seen.add(key); continue; }
        // ignora avisos de sistema do Slack (entrou/saiu do canal, etc.)
        if (/\b(joined|left|has joined|has left|set the channel|pinned a message|added an integration|renamed the channel)\b/i.test(m.text)) { seen.add(key); continue; }
        // no canal PRINCIPAL (supplements-dashboard) TUDO é pra mim.
        // nos outros canais: só se marca o Claude, marca o Bruno, vem do Bruno, ou parece pergunta.
        const tagsMe = m.text.includes(CLAUDE_ID) || /@claude|@carol/i.test(m.text);
        const fromBruno = /bruno/i.test(m.sender);
        const looksQ = QRE.test(m.text) || m.text.includes(BRUNO);
        if (!isPrimary && !tagsMe && !fromBruno && !looksQ) { seen.add(key); continue; }
        seen.add(key);
        const rec = { at: new Date().toISOString(), channel: chan, sender: m.sender, text: m.text };
        fs.appendFileSync(INBOX, JSON.stringify(rec) + '\n');
        console.log('[watchdog] NOVA pergunta:', m.sender, '::', m.text.slice(0, 80));
      }
    }
    saveSeen();
    fs.writeFileSync(HB, new Date().toISOString());
  } finally { try { c.close(); } catch (_) {} }
}

(async () => {
  console.log('[watchdog] ligado. canais:', CHANNELS.join(','), 'poll', POLL_MS + 'ms. inbox:', INBOX);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await tick(); } catch (e) { console.log('[watchdog] tick erro:', e.message); }
    await sleep(POLL_MS);
  }
})();
