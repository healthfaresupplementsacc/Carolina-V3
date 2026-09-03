'use strict';
/* SLACK SOCKET MODE LISTENER — push em tempo real (substitui a raspagem de DOM).
 * Slack EMPURRA cada mensagem por WebSocket no instante em que é postada (<1s),
 * como um webhook, mas sem precisar de URL pública. Requer um app Slack SEPARADO
 * ("Claude Listener") com Socket Mode — NUNCA ativar Socket Mode no app HealthFare
 * Tracker de produção: isso desligaria a entrega HTTP pro Railway e quebraria o bot.
 *
 * Tokens em _watch/tokens.json: { "app_token": "xapp-...", "bot_token": "xoxb-..." }
 *   app_token (obrigatório) = App-Level Token com escopo connections:write
 *   bot_token (opcional)    = resolve nomes de usuário bonitos via users.info
 * Sem tokens: dorme e rechecka a cada 5 min (não crasha, não hot-loopa).
 *
 * Saída: appenda em _watch/inbox.jsonl (mesmo formato do watchdog) → o Monitor do
 * Claude (tail -F) acorda na hora. Grava _watch/listener-alive.txt a cada 30s pro
 * watchdog saber que pode pular a captura por DOM (fica só de keep-alive do Chrome).
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '_watch');
try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}
const TOKENS = path.join(DIR, 'tokens.json');
const INBOX = path.join(DIR, 'inbox.jsonl');
const SEEN = path.join(DIR, 'seen-socket.json');
const ALIVE = path.join(DIR, 'listener-alive.txt');

const PRIMARY = 'C0BUKK6EH98';               // supplements-dashboard: TUDO é pra mim
const WATCHED = new Set([PRIMARY, 'C0B36DR5MP1']); // admin-orin: só se me marcar/pergunta
const BRUNO = 'U03URLL1D4L';
const CLAUDE_ID = 'D045L79UMME';
const CAROL = 'U044WG04UMQ';                 // eu postando como Carol — ignorar
const QRE = /\?|\bqual\b|\bquant|\bcomo\b|\bpor que|\bmeta|\bgoal|\bme (diz|fala|mostra|manda)\b|\bpreciso\b|@claude|@carol/i;
const SKIP_SUBTYPES = new Set(['channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'message_deleted', 'message_changed', 'bot_add', 'pinned_item']);

let seen = new Set();
try { seen = new Set(JSON.parse(fs.readFileSync(SEEN, 'utf8'))); } catch (_) {}
const saveSeen = () => { try { fs.writeFileSync(SEEN, JSON.stringify([...seen].slice(-4000))); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[listener]', ...a);

function loadTokens() {
  try { const t = JSON.parse(fs.readFileSync(TOKENS, 'utf8')); return t && t.app_token ? t : null; } catch (_) { return null; }
}

// nomes bonitos (cache); sem bot_token devolve o próprio ID
const names = new Map([[BRUNO, 'Bruno Camp'], [CAROL, 'Carol']]);
async function userName(bot, id) {
  if (!id) return '?';
  if (names.has(id)) return names.get(id);
  if (!bot) return id;
  try {
    const r = await fetch('https://slack.com/api/users.info?user=' + id, { headers: { Authorization: 'Bearer ' + bot } });
    const j = await r.json();
    const n = j.ok ? (j.user.profile.display_name || j.user.real_name || id) : id;
    names.set(id, n); return n;
  } catch (_) { return id; }
}

function wanted(ev) {
  const chan = ev.channel || '';
  const text = ev.text || '';
  const user = ev.user || '';
  if (ev.subtype && SKIP_SUBTYPES.has(ev.subtype)) return false;
  if (user === CAROL) return false;                       // eu mesma (Carol)
  // menção crua em evento = <@Uxxxx>; cubro Claude/Carol por ID e por nome
  const tagsMe = text.includes(CLAUDE_ID) || text.includes(CAROL) || /@claude|@carol/i.test(text);
  if (ev.bot_id && !tagsMe) return false;                 // bots só se me marcarem
  if (chan.startsWith('D')) return true;                  // DM com o claude_listener: tudo é pra mim
  if (chan === PRIMARY) return true;                      // canal principal: tudo
  if (tagsMe) return true;                                // qualquer canal vigiado: tag
  if (!WATCHED.has(chan)) return false;
  return user === BRUNO || QRE.test(text) || text.includes(BRUNO);
}

// escreve _watch/covered.json = canais que o listener consegue LER (é membro).
// O watchdog usa isso pra saber o que ainda precisa raspar por DOM (ex.: DM da
// Carol, que este bot nunca vê; admin-orin enquanto não for convidado).
async function probeCoverage(bot) {
  const covered = [];
  if (bot) {
    for (const ch of WATCHED) {
      try {
        const r = await fetch('https://slack.com/api/conversations.history?channel=' + ch + '&limit=1', { headers: { Authorization: 'Bearer ' + bot } });
        const j = await r.json();
        if (j.ok) covered.push(ch);
      } catch (_) {}
    }
  }
  try { fs.writeFileSync(path.join(DIR, 'covered.json'), JSON.stringify(covered)); } catch (_) {}
  log('cobertura push:', covered.length ? covered.join(',') : '(nenhuma — precisa de /invite)');
}

async function capture(bot, ev) {
  const key = (ev.channel || '?') + ':' + (ev.ts || ev.event_ts || '');
  if (seen.has(key)) return;
  seen.add(key); saveSeen();
  const sender = await userName(bot, ev.user);
  const rec = { at: new Date().toISOString(), channel: ev.channel, sender, text: (ev.text || '').slice(0, 2000), ts: ev.ts, via: 'socket' };
  fs.appendFileSync(INBOX, JSON.stringify(rec) + '\n');
  log('CAPTUROU:', sender, '::', rec.text.slice(0, 80));
}

async function openSocketUrl(app) {
  const r = await fetch('https://slack.com/api/apps.connections.open', { method: 'POST', headers: { Authorization: 'Bearer ' + app } });
  const j = await r.json();
  if (!j.ok) throw new Error('apps.connections.open falhou: ' + j.error);
  return j.url;
}

async function runSocket(tokens) {
  await probeCoverage(tokens.bot_token);
  const url = await openSocketUrl(tokens.app_token);
  const ws = new WebSocket(url);
  let alive = true;
  const hb = setInterval(() => { try { fs.writeFileSync(ALIVE, new Date().toISOString()); } catch (_) {} }, 30000);
  try { fs.writeFileSync(ALIVE, new Date().toISOString()); } catch (_) {}

  await new Promise((resolve) => {
    ws.onopen = () => log('socket conectado');
    ws.onerror = (e) => { log('socket erro:', (e && e.message) || 'ws error'); };
    ws.onclose = (e) => { alive = false; log('socket fechou (code ' + e.code + ')'); resolve(); };
    ws.onmessage = async (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.type === 'hello') { log('hello — escutando em tempo real'); return; }
      if (m.envelope_id) { try { ws.send(JSON.stringify({ envelope_id: m.envelope_id })); } catch (_) {} } // ack < 3s
      if (m.type === 'disconnect') { log('slack pediu reconexão (' + (m.reason || '?') + ')'); try { ws.close(); } catch (_) {} return; }
      if (m.type === 'events_api' && m.payload && m.payload.event) {
        const ev = m.payload.event;
        if ((ev.type === 'message' || ev.type === 'app_mention') && wanted(ev)) {
          try { await capture(tokens.bot_token, ev); } catch (err) { log('capture erro:', err.message); }
        }
      }
    };
  });
  clearInterval(hb);
  return alive;
}

(async () => {
  log('ligado. principal=' + PRIMARY + ' vigiados=' + [...WATCHED].join(','));
  let backoff = 3000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tokens = loadTokens();
    if (!tokens) {
      log('sem _watch/tokens.json (app_token xapp-...) — aguardando; rechecando em 5min');
      try { fs.unlinkSync(ALIVE); } catch (_) {}
      await sleep(5 * 60 * 1000);
      continue;
    }
    try {
      await runSocket(tokens);
      backoff = 3000; // conexão ok que caiu normal → reconecta rápido
    } catch (e) {
      log('erro de conexão:', e.message, '— retry em', Math.round(backoff / 1000) + 's');
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 5 * 60 * 1000);
      continue;
    }
    await sleep(1500);
  }
})();
