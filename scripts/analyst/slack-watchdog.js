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
const CAROL_DM = 'D045L79UMME';              // DM Bruno↔Carol — só a sessão da Carol vê (listener NUNCA cobre)
// orders-and-inventory entra na vigia: operadoras respondem contagens pra Carol lá
const CHANNELS = (process.env.WATCH_CHANNELS || PRIMARY + ',C0B36DR5MP1,C09UNBXFRKK,' + CAROL_DM).split(',').map((s) => s.trim()).filter(Boolean);
const QRE = /\?|\bqual\b|\bquant|\bcomo\b|\bpor que|\bmeta|\bgoal|\bme (diz|fala|mostra|manda)\b|\bpreciso\b|@claude|@carol|@bruno|\b\d{3,4}\b|conte[im]|recontei|confirm|frasco|batch|carol/i;

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
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('ws connect timeout 15s')), 15000);
    ws.onopen = () => { clearTimeout(to); res(); };
    ws.onerror = () => { clearTimeout(to); rej(new Error('ws')); };
  });
  let idc = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  // toda chamada CDP tem timeout de 20s: aba pendurada não pode travar o loop inteiro
  const send = (mth, p = {}) => new Promise((r, rej) => {
    const id = ++idc;
    const to = setTimeout(() => { pend.delete(id); rej(new Error('cdp timeout ' + mth)); }, 20000);
    pend.set(id, (v) => { clearTimeout(to); r(v); });
    try { ws.send(JSON.stringify({ id, method: mth, params: p })); } catch (e) { clearTimeout(to); pend.delete(id); rej(e); }
  });
  await send('Runtime.enable');
  return { send, close: () => ws.close(), ev: (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => r && r.result ? r.result.value : undefined) };
}

// lê as últimas msgs do canal atual via a store interna do Slack (boot data / redux)
// Estratégia simples e robusta: navega pro canal e raspa o DOM das mensagens visíveis.
async function readChannel(c, chan) {
  await c.send('Page.navigate', { url: 'https://app.slack.com/client/' + TEAM + '/' + chan });
  // espera a URL BATER com o canal (SPA troca devagar; sem isso raspa o canal
  // anterior e atribui as msgs ao canal errado) + o pane existir
  let here = false;
  for (let i = 0; i < 12; i++) {
    const st = await c.ev('({p:location.pathname,ok:!!document.querySelector("[data-qa=message_pane],[data-qa=virtual-list]")})');
    if (st && st.ok && String(st.p || '').includes(chan)) { here = true; break; }
    await sleep(1500);
  }
  if (!here) return []; // não confirmou o canal: pula (melhor perder 1 tick que atribuir errado)
  await sleep(1500);
  // Slack virtualiza a lista: força rolagem pro fim pra renderizar as msgs mais novas
  await c.ev(`(function(){var l=document.querySelector('.c-virtual_list__scroll_container,[data-qa=slack_kit_scrollbar] .c-scrollbar__hider,[data-qa=message_pane] .c-scrollbar__hider');if(l){l.scrollTop=l.scrollHeight;}return !!l;})()`);
  await sleep(1200);
  const rows = await c.ev(`(function(){
    var out=[]; var last=''; var nodes=document.querySelectorAll('[data-qa="virtual-list-item"],.c-virtual_list__item');
    nodes.forEach(function(n){
      var ts=n.getAttribute('id')||n.getAttribute('data-item-key')||'';
      var senderEl=n.querySelector('[data-qa=message_sender_name],.c-message__sender_button');
      var textEl=n.querySelector('[data-qa=message-text],.p-rich_text_section,.c-message__body');
      // msgs agrupadas não repetem o remetente no DOM: herda do anterior (senão
      // alerta de bot chega sem sender e fura o filtro de "ignora bots")
      var sender=senderEl?senderEl.textContent.trim():last;
      last=sender;
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
  fs.writeFileSync(HB, new Date().toISOString()); // batida no INÍCIO (tick longo não parece morte)
  // MUTEX com carolina-say: se a Carol está digitando/enviando NESTA MESMA aba,
  // não navega (senão a mensagem dela vira rascunho perdido).
  try {
    const st = fs.statSync(path.join(DIR, 'say.lock'));
    if (Date.now() - st.mtimeMs < 120000) { fs.writeFileSync(HB, new Date().toISOString()); return; }
  } catch (_) {}
  // com o listener vivo, só raspa o que o push NÃO cobre (ex.: DM da Carol; canais
  // onde o claude_listener ainda não foi convidado — lista em covered.json)
  let toScrape = CHANNELS;
  if (listenerAlive()) {
    let covered = [];
    try { covered = JSON.parse(fs.readFileSync(path.join(DIR, 'covered.json'), 'utf8')); } catch (_) {}
    toScrape = CHANNELS.filter((ch) => !covered.includes(ch));
    if (!toScrape.length) { fs.writeFileSync(HB, new Date().toISOString()); return; } // tudo coberto; só keep-alive
  }
  let c;
  try { c = await cdp(); } catch (e) { console.log('[watchdog] cdp falhou:', e.message); return; }
  const SCRAPE_LOCK = path.join(DIR, 'scrape.lock');
  try { fs.writeFileSync(SCRAPE_LOCK, String(Date.now())); } catch (_) {}
  try {
    for (const chan of toScrape) {
      let rows = [];
      try { rows = await readChannel(c, chan); } catch (_) { continue; }
      const isPrimary = chan === PRIMARY || chan.startsWith('D'); // DM da Carol = tudo é pra mim
      for (const m of rows) {
        const key = chan + ':' + m.ts + ':' + m.text.slice(0, 24);
        if (!m.ts || seen.has(key)) continue;
        // ignora o que o próprio Claude/Carol/bots da casa postaram (qualquer "HealthFare *")
        if (/^(carol|carolina|healthfare )/i.test(m.sender)) { seen.add(key); continue; }
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
  } finally {
    try { c.close(); } catch (_) {}
    try { fs.unlinkSync(SCRAPE_LOCK); } catch (_) {}
  }
}

// ── outbox agendada: mensagens pra enviar em horário marcado (sobrevive reboot) ──
// _watch/outbox.json = [{at: epoch_ms, ch: 'canal', file: 'nome-do-txt', tries, sent, ok}]
function processOutbox() {
  const OB = path.join(DIR, 'outbox.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(OB, 'utf8')); } catch (_) { return; }
  let changed = false;
  for (const it of list) {
    if (it.sent || Date.now() < it.at || (it.tries || 0) >= 3) continue;
    it.tries = (it.tries || 0) + 1; changed = true;
    console.log('[watchdog] outbox: enviando', it.file, '(tentativa ' + it.tries + ')');
    try {
      const r = require('child_process').spawnSync('node',
        [path.join(__dirname, 'carolina-say.js'), 'channel', '--ch', it.ch, '--file', path.join(DIR, it.file)],
        { timeout: 180000 });
      if (r.status === 0) { it.sent = new Date().toISOString(); it.ok = true; console.log('[watchdog] outbox: ENVIADO', it.file); }
      else { console.log('[watchdog] outbox: falhou (exit ' + r.status + '), retry no próximo tick'); }
    } catch (e) { console.log('[watchdog] outbox erro:', e.message); }
    if ((it.tries || 0) >= 3 && !it.sent) { it.ok = false; it.sent = new Date().toISOString(); it.error = 'desisti apos 3 tentativas'; }
  }
  if (changed) { try { fs.writeFileSync(OB, JSON.stringify(list, null, 1)); } catch (_) {} }
}

// ── auto-ack "sinal de vida": msg não pega pelo Claude em 60s → Carol avisa que viu ──
const ACK_PHRASES = [
  'pera que to no meio de uma coisa aqui, ja te respondo',
  'vi aqui, to terminando um negocio e ja volto',
  'to aqui, so ocupada com outra coisa, ja te atendo',
  'recebi, me da uns minutinhos que eu ja olho',
];
function processAutoAck() {
  // se o agente haiku (camada rápida) está vivo, ele cuida dos acks — não duplica
  try { const st = fs.statSync(path.join(DIR, 'haiku-alive.txt')); if (Date.now() - st.mtimeMs < 60000) return; } catch (_) {}
  let lines = []; try { lines = fs.readFileSync(INBOX, 'utf8').split('\n').filter(Boolean); } catch (_) { return; }
  let cursor = 0; try { cursor = parseInt(fs.readFileSync(path.join(DIR, 'cursor.txt'), 'utf8'), 10) || 0; } catch (_) {}
  if (lines.length <= cursor) return; // Claude ja drenou: vivo e respondendo
  let st = { ackedUpTo: 0, lastAt: 0, idx: 0 };
  try { st = JSON.parse(fs.readFileSync(path.join(DIR, 'autoack.json'), 'utf8')); } catch (_) {}
  if (lines.length <= st.ackedUpTo) return;               // ja dei sinal pra esse lote
  if (Date.now() - st.lastAt < 5 * 60 * 1000) return;     // no maximo 1 sinal a cada 5min
  let newest; try { newest = JSON.parse(lines[lines.length - 1]); } catch (_) { return; }
  const age = Date.now() - new Date(newest.at).getTime();
  if (age < 60 * 1000 || age > 15 * 60 * 1000) return;    // nova demais (Claude pega) ou velha demais (ack tardio e pior)
  if (!/^[CD]/.test(newest.channel || '')) return;
  // sinal de vida SÓ pra gente de verdade: nunca pra alerta de bot/sistema (4am no
  // canal vazio fica bizarro) e nunca no admin-orin (lá é só relatório)
  if (!newest.sender || /^(carol|carolina|healthfare )/i.test(newest.sender)) return;
  if (newest.channel === 'C0B36DR5MP1') return;
  const phrase = ACK_PHRASES[(st.idx || 0) % ACK_PHRASES.length];
  const r = require('child_process').spawnSync('node', [path.join(__dirname, 'carolina-say.js'), 'channel', '--ch', newest.channel, '--text', phrase], { timeout: 180000 });
  if (r.status === 0) {
    st.ackedUpTo = lines.length; st.lastAt = Date.now(); st.idx = (st.idx || 0) + 1;
    try { fs.writeFileSync(path.join(DIR, 'autoack.json'), JSON.stringify(st)); } catch (_) {}
    console.log('[watchdog] auto-ack (sinal de vida) enviado em', newest.channel);
  }
}

// ── anti-travamento: tick pendurado (CDP sem resposta) NÃO pode matar a outbox.
// Se o loop não progredir em 4min, o processo se mata e o run-watchdog.cmd revive
// em 5s. Foi exatamente isso que falhou em 09-03: tick travou 8:33am e a msg das
// 9:36am não saiu.
let lastLoop = Date.now();
setInterval(() => {
  if (Date.now() - lastLoop > 4 * 60 * 1000) {
    console.log('[watchdog] loop travado ha 4min, morrendo pra renascer');
    process.exit(1);
  }
}, 30000);

(async () => {
  console.log('[watchdog] ligado. canais:', CHANNELS.join(','), 'poll', POLL_MS + 'ms. inbox:', INBOX);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    lastLoop = Date.now();
    try { processOutbox(); } catch (e) { console.log('[watchdog] outbox erro:', e.message); }
    try { processAutoAck(); } catch (e) { console.log('[watchdog] autoack erro:', e.message); }
    try { await tick(); } catch (e) { console.log('[watchdog] tick erro:', e.message); }
    await sleep(POLL_MS);
  }
})();
