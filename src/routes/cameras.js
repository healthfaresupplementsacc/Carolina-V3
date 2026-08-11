'use strict';
/**
 * Câmeras (view-only) — Warehouse Floor + Packaging Line.
 *
 * Proxy PIN-gated para o gateway de câmeras (PC das câmeras, via Tailscale
 * Funnel). O browser do funcionário NUNCA vê a URL do gateway nem o CAM_TOKEN —
 * ambos ficam só em env vars do Railway.
 *
 * Auth (revisado pós-review adversarial — o PIN NUNCA vai em URL/log):
 *   POST /api/cam/session {pin}     -> {token} de sessão (HMAC, expira em 12h)
 *   GET  /api/cam/:name?t=<token>   -> MJPEG proxied (name: warehouse | packaging)
 *   GET  /cameras                   -> página standalone (pede o PIN 1x, guarda só o TOKEN)
 *
 * Proteções: rate-limit 60/min por IP real (exige trust proxy — setado no
 * index.js) + brute-force guard (10 PINs errados/h -> ban 24h persistido em
 * v3.blocked_ips + alerta no canal admin) + comparações timing-safe.
 *
 * Env (Railway):
 *   CAM_TUNNEL_URL  ex.: https://<maquina>.ts.net/embed   (muda quando o PC das câmeras migrar — só troca a env)
 *   CAM_TOKEN       segredo compartilhado com o gateway (fica no servidor; também assina os tokens de sessão)
 *   CAM_VIEW_PIN    PIN que o funcionário digita 1x na página
 *
 * PORTABILIDADE: se as envs faltarem ou o PC das câmeras estiver offline
 * (ex.: durante a migração pra outra máquina), responde 503 e o resto do V4
 * segue 100% intacto — nada aqui é dependência do dashboard.
 */

const express = require('express');
const crypto = require('crypto');
const { Readable } = require('stream');
const { makeRateLimit, makeBruteForceGuard } = require('../middleware/security');
const { isCamerasOn, scheduleInfo, nyClock } = require('../cameras-schedule');
const { onDemandActive } = require('../v3/workday');

const router = express.Router();

const CAMS = new Set(['warehouse', 'packaging', 'formulation']);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h ≈ um turno; expira -> pede o PIN de novo

// ── proteções ───────────────────────────────────────────────
// db lazy (pool do wire) pra persistir bans; slack pro alerta de brute-force.
// Tudo best-effort: se indisponível, o guard segue em memória (nunca derruba).
const lazyDb = {
  query: (...a) => {
    try {
      const wire = require('../v3/wire');
      const pool = wire.getPool && wire.getPool();
      return pool ? pool.query(...a) : Promise.resolve({ rows: [] });
    } catch (_) { return Promise.resolve({ rows: [] }); }
  },
};
let slack = null;
try { const s = require('../v3/slack/sender'); slack = { postAs: s.postAs }; } catch (_) { /* sem slack em teste */ }

// ── CÂMERAS LIGADAS AGORA? (Bruno 07-10/11) ──────────────────────────────
// Seg–Sex: janela fixa 7:00–20:30 (cameras-schedule). Sáb/Dom: DESLIGADAS por
// padrão; LIGAM sob demanda se alguém está trabalhando / o admin anunciou
// (onDemandActive). Cache de 60s pra não bater no DB a cada frame/health.
let _wkCache = { at: 0, on: false };
async function weekendCamsOn() {
  const now = Date.now();
  if (now - _wkCache.at < 60000) return _wkCache.on;
  let on = false;
  try { on = await onDemandActive(lazyDb); } catch (_) { on = false; }
  _wkCache = { at: now, on };
  return on;
}
async function camerasAllowedNow() {
  if (isCamerasOn()) return true;                            // dia de semana dentro da janela
  const { weekday, minutes } = nyClock();
  if (weekday !== 'Saturday' && weekday !== 'Sunday') return false; // dia de semana fora da janela = off
  if (minutes < 6 * 60 || minutes >= 22 * 60) return false;        // nunca de madrugada no fds
  return await weekendCamsOn();                             // fds: só se tem trabalho / admin avisou
}

const guard = makeBruteForceGuard({ db: lazyDb, slack, threshold: 10, windowMs: 60 * 60 * 1000, banMs: 24 * 60 * 60 * 1000 });
let hydrated = false;
async function ensureHydrated() { if (!hydrated) { hydrated = true; try { await guard.hydrate(); } catch (_) {} } }

// 60 req/min por IP real (trust proxy no index.js) + gate de IP banido.
router.use('/api/cam', makeRateLimit({ limit: 60, windowMs: 60 * 1000 }), (req, res, next) => guard.gate(req, res, next));

// ── crypto helpers ──────────────────────────────────────────
function timingEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
// token = "<expMs>.<hmac(cam:expMs, CAM_TOKEN)>" — stateless, sobrevive a restart.
function signToken(expMs) {
  const mac = crypto.createHmac('sha256', String(process.env.CAM_TOKEN || '')).update('cam:' + expMs).digest('hex');
  return expMs + '.' + mac;
}
function tokenOk(t) {
  if (!t || !process.env.CAM_TOKEN) return false;
  const i = String(t).indexOf('.');
  if (i <= 0) return false;
  const expMs = Number(String(t).slice(0, i));
  if (!Number.isFinite(expMs) || Date.now() > expMs) return false;
  return timingEq(t, signToken(expMs));
}

// ── sessão: troca o PIN (no BODY, nunca em URL) por um token ───────────────
router.post('/api/cam/session', express.json(), async (req, res) => {
  await ensureHydrated();
  const pin = process.env.CAM_VIEW_PIN;
  if (!pin || !process.env.CAM_TUNNEL_URL || !process.env.CAM_TOKEN) {
    return res.status(503).json({ error: 'cameras_offline' }); // feature não configurada — V4 segue intacto
  }
  const attempt = req.body && req.body.pin;
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!attempt || !timingEq(attempt, pin)) {
    guard.recordFailure(ip); // 10 erros/h -> ban 24h + alerta admin (igual /op e /admin)
    return res.status(403).json({ error: 'bad_pin' });
  }
  guard.recordSuccess(ip);
  const exp = Date.now() + SESSION_TTL_MS;
  res.json({ token: signToken(exp), expires_at: exp });
});

// ── ZONAS FIXAS (Bruno 08-01): máquinas/áreas que NÃO se movem, marcadas 1× pelo
// Bruno na página /cameras/tag → o Claude sabe pra sempre onde olhar. Coordenadas
// em fração 0..1. PIN-gated pelo mesmo token das câmeras. ────────────────────
router.get('/api/cam/zones', async (req, res) => {
  if (!tokenOk(req.query.t)) return res.status(403).json({ error: 'bad_token' });
  try {
    const r = await lazyDb.query(
      `SELECT id, cam, name, kind, x0, y0, x1, y1, points, notes FROM v3.camera_zones
       WHERE active = TRUE ${req.query.cam ? 'AND cam = $1' : ''} ORDER BY cam, id`,
      req.query.cam ? [String(req.query.cam)] : []);
    res.json({ zones: r.rows || [] });
  } catch (e) { res.status(500).json({ error: 'db', detail: e.message }); }
});
router.post('/api/cam/zones', express.json(), async (req, res) => {
  if (!tokenOk(req.body && req.body.t)) return res.status(403).json({ error: 'bad_token' });
  const b = req.body || {};
  if (!CAMS.has(String(b.cam))) return res.status(400).json({ error: 'bad_cam' });
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name_required' });
  const f = (v) => Math.max(0, Math.min(1, Number(v)));
  // POLÍGONO (Bruno 08-01): pontos {x,y} em fração; >=3. bbox derivada dos pontos.
  const pts = Array.isArray(b.points) ? b.points.map((p) => ({ x: f(p.x), y: f(p.y) })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
  if (pts.length < 3) return res.status(400).json({ error: 'need_3_points' });
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
  if (!(x1 > x0 && y1 > y0)) return res.status(400).json({ error: 'bad_shape' });
  try {
    const r = await lazyDb.query(
      `INSERT INTO v3.camera_zones (cam, name, kind, x0, y0, x1, y1, points, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
      [String(b.cam), name.slice(0, 80), String(b.kind || 'machine').slice(0, 20), x0, y0, x1, y1, JSON.stringify(pts), b.notes ? String(b.notes).slice(0, 300) : null]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: 'db', detail: e.message }); }
});
router.delete('/api/cam/zones/:id', express.json(), async (req, res) => {
  const tok = (req.body && req.body.t) || req.query.t;
  if (!tokenOk(tok)) return res.status(403).json({ error: 'bad_token' });
  try {
    await lazyDb.query('UPDATE v3.camera_zones SET active = FALSE, updated_at = NOW() WHERE id = $1', [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'db', detail: e.message }); }
});

// ── health: o PC das câmeras está alcançável AGORA? (a página usa pra
// reconectar sozinha quando o gateway volta — ele flapa na prática) ─────────
router.get('/api/cam/health', async (req, res) => {
  if (!tokenOk(req.query.t)) return res.status(403).json({ error: 'bad_token' });
  // FORA DO HORÁRIO (Bruno 07-10): câmeras de supervisão seguem o horário de
  // trabalho (7:00–20:30 seg–sáb; domingo o dia todo desligadas). Fora disso o
  // gateway responde "fora do ar" → a página mostra o "reconectando" normal, sem
  // ficar sondando as câmeras desligadas. Ver src/cameras-schedule.js.
  if (!(await camerasAllowedNow())) return res.json({ reachable: false, reason: 'scheduled_off', scheduled_off: true, schedule: scheduleInfo() });
  const base = process.env.CAM_TUNNEL_URL;
  if (!base || !process.env.CAM_TOKEN) return res.json({ reachable: false, reason: 'not_configured' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    // qualquer resposta HTTP (mesmo 403 na raiz) = túnel/gateway de pé
    const r = await fetch(base.replace(/\/$/, ''), { signal: ctrl.signal, headers: { 'X-Cam-Token': process.env.CAM_TOKEN } });
    clearTimeout(timer);
    return res.json({ reachable: true, status: r.status });
  } catch {
    clearTimeout(timer);
    return res.json({ reachable: false, reason: 'unreachable' });
  }
});

// ── stream proxied + MULTIPLEX (sugestão do gateway 07-01): 1 fetch upstream
// por câmera COMPARTILHADO entre N navegadores. Antes cada viewer abria um
// stream próprio → multiplicava o upload do PC das câmeras (que é o gargalo:
// ~22-28 Mbps no escritório). Agora o custo é fixo (1 stream/câmera) não
// importa quantos assistem. Viewer que entra no meio: o decoder MJPEG do
// browser ressincroniza no próximo boundary (comportamento padrão de proxies
// MJPEG). Viewer lento (>4MB de buffer) é derrubado pra não vazar memória. ──
const brokers = new Map(); // name -> Promise<broker|null> | broker
// RECONEXÃO TRANSPARENTE (Bruno 07-08 — "offline constante"): quando o upstream
// cai (blip do funnel / restart do gateway / hiccup de rede), NÃO derruba os
// <img> na hora. Reabre o upstream em backoff por até esta janela mantendo as
// conexões dos navegadores VIVAS — o parser MJPEG do browser ressincroniza no
// próximo boundary, então uma queda curta fica INVISÍVEL pro operador. Só
// depois da janela (queda longa de verdade) é que os clientes veem "offline".
const RECONNECT_WINDOW_MS = 30000;

async function connectUpstream(name, b) {
  const base = process.env.CAM_TUNNEL_URL;
  const token = process.env.CAM_TOKEN;
  if (!base || !token) return false;
  b.ctrl = new AbortController();
  const connectTimer = setTimeout(() => { try { b.ctrl.abort(); } catch (_) {} }, 8000);
  let up;
  try {
    up = await fetch(`${base.replace(/\/$/, '')}/stream/${name}`, { headers: { 'X-Cam-Token': token }, signal: b.ctrl.signal });
  } catch { clearTimeout(connectTimer); return false; }
  clearTimeout(connectTimer);
  if (!up.ok || !up.body) return false;
  b.contentType = b.contentType || up.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=frame';
  b.alive = true; b.downSince = 0; b.attempts = 0;
  const node = Readable.fromWeb(up.body);
  b.node = node;
  const armStale = () => {
    if (b.staleTimer) clearTimeout(b.staleTimer);
    // sem NENHUM frame por 10s = upstream meio-morto (conexão aberta, gateway
    // parou de mandar) → aborta e força reconexão (senão os <img> congelam pra
    // sempre num frame velho sem ninguém perceber). Bruno 07-08.
    b.staleTimer = setTimeout(() => { try { b.ctrl.abort(); } catch (_) {} }, 10000);
  };
  node.on('data', (chunk) => {
    b.lastData = Date.now();
    armStale();
    for (const c of b.clients) {
      try {
        if (c.writableLength > 4 * 1024 * 1024) { c.destroy(); b.clients.delete(c); continue; }
        c.write(chunk);
      } catch (_) { b.clients.delete(c); }
    }
  });
  const onDrop = () => { if (b.node === node) onUpstreamDrop(name, b); };
  node.on('error', onDrop);
  node.on('end', onDrop);
  armStale();
  return true;
}

function onUpstreamDrop(name, b) {
  if (b.closed) return;
  b.alive = false;
  if (b.staleTimer) { clearTimeout(b.staleTimer); b.staleTimer = null; } // não deixa o timer do node velho abortar o novo
  if (b.clients.size === 0) return closeBroker(name, b);          // ninguém vendo → encerra
  if (!b.downSince) b.downSince = Date.now();
  if (Date.now() - b.downSince > RECONNECT_WINDOW_MS) return closeBroker(name, b); // queda longa → offline
  scheduleReconnect(name, b);
}

function scheduleReconnect(name, b) {
  if (b.closed || b.reconnTimer) return;
  const delay = Math.min(1000 * (2 ** (b.attempts || 0)), 5000);  // 1s,2s,4s,5s…
  b.attempts = (b.attempts || 0) + 1;
  b.reconnTimer = setTimeout(async () => {
    b.reconnTimer = null;
    if (b.closed || b.clients.size === 0) return closeBroker(name, b);
    const ok = await connectUpstream(name, b);
    if (!ok) onUpstreamDrop(name, b);                             // falhou → reprograma (respeita a janela)
  }, delay);
}

function closeBroker(name, b) {
  if (b.closed) return;
  b.closed = true; b.alive = false;
  if (b.reconnTimer) { clearTimeout(b.reconnTimer); b.reconnTimer = null; }
  if (b.lingerTimer) { clearTimeout(b.lingerTimer); b.lingerTimer = null; }
  if (b.staleTimer) { clearTimeout(b.staleTimer); b.staleTimer = null; }
  try { b.ctrl && b.ctrl.abort(); } catch (_) {}
  try { b.node && b.node.destroy(); } catch (_) {}
  for (const c of b.clients) { try { c.end(); } catch (_) {} }
  b.clients.clear();
  if (brokers.get(name) === b) brokers.delete(name);
}

async function openBroker(name) {
  const b = { clients: new Set(), ctrl: null, node: null, contentType: null, alive: false, closed: false,
    lingerTimer: null, reconnTimer: null, downSince: 0, attempts: 0, lastData: 0 };
  const ok = await connectUpstream(name, b);
  return ok ? b : null;
}

function getBroker(name) {
  const cur = brokers.get(name);
  if (cur) return cur;                       // Promise ou broker vivo (dedup do 1º viewer)
  const p = openBroker(name).then((b) => {
    if (b) brokers.set(name, b); else brokers.delete(name);   // troca a Promise pelo broker resolvido
    return b;
  }).catch(() => { brokers.delete(name); return null; });
  brokers.set(name, p);
  return p;
}

// ── H.264 fMP4 (Full HD) — ADDENDUM do gateway 07-01: {BASE}/mp4/<cam> entrega
// 1920×1080 H.264 a ~6.2Mbps (vs MJPEG 720p ~10Mbps). Player <video> no front.
// SEM broker aqui: fMP4 não aceita viewer entrando no meio (perde o moov/init);
// o go2rtc do gateway já multiplexa o transcode por câmera, então N viewers =
// N conexões leves ao gateway, 1 transcode só lá.
router.get('/api/cam/:name/mp4', async (req, res) => {
  const { name } = req.params;
  if (!CAMS.has(name)) return res.status(404).json({ error: 'unknown_camera' });
  if (!tokenOk(req.query.t)) return res.status(403).json({ error: 'bad_token' });
  if (!(await camerasAllowedNow())) return res.status(503).json({ error: 'scheduled_off' }); // fora do horário/fds sem trabalho → reconectando
  const base = process.env.CAM_TUNNEL_URL;
  const token = process.env.CAM_TOKEN;
  if (!base || !token) return res.status(503).json({ error: 'cameras_offline' });

  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  const connectTimer = setTimeout(() => ctrl.abort(), 8000);
  let up;
  try {
    up = await fetch(`${base.replace(/\/$/, '')}/mp4/${name}`, {
      headers: { 'X-Cam-Token': token },
      signal: ctrl.signal,
    });
  } catch { clearTimeout(connectTimer); return res.status(503).json({ error: 'cameras_offline' }); }
  clearTimeout(connectTimer);
  if (!up.ok || !up.body) return res.status(503).json({ error: 'cameras_offline' });

  res.status(200);
  res.set('Content-Type', up.headers.get('content-type') || 'video/mp4');
  res.set('Cache-Control', 'no-store');
  const body = Readable.fromWeb(up.body);
  body.on('error', () => { try { res.end(); } catch (_) {} });
  res.on('close', () => { try { ctrl.abort(); body.destroy(); } catch (_) {} });
  body.pipe(res);
});

router.get('/api/cam/:name', async (req, res) => {
  const { name } = req.params;
  if (!CAMS.has(name)) return res.status(404).json({ error: 'unknown_camera' });
  if (!tokenOk(req.query.t)) return res.status(403).json({ error: 'bad_token' });
  if (!(await camerasAllowedNow())) return res.status(503).json({ error: 'scheduled_off' }); // fora do horário/fds sem trabalho → reconectando
  if (!process.env.CAM_TUNNEL_URL || !process.env.CAM_TOKEN) {
    return res.status(503).json({ error: 'cameras_offline' }); // migração/PC desligado — V4 segue intacto
  }
  const b = await getBroker(name);
  // b pode estar RECONECTANDO (alive=false transitório) — anexa mesmo assim; os
  // frames voltam quando o upstream reabre dentro da janela. Só 503 se não há broker.
  if (!b || b.closed || !b.contentType) return res.status(503).json({ error: 'cameras_offline' });

  res.status(200);
  res.set('Content-Type', b.contentType);
  res.set('Cache-Control', 'no-store');
  b.clients.add(res);
  if (b.lingerTimer) { clearTimeout(b.lingerTimer); b.lingerTimer = null; }
  req.on('close', () => {
    b.clients.delete(res);
    // último viewer saiu → segura 5s (reload rápido reusa) e derruba o upstream
    if (b.clients.size === 0 && !b.closed) {
      b.lingerTimer = setTimeout(() => { if (b.clients.size === 0) closeBroker(name, b); }, 5000);
    }
  });
});


// ---- página standalone (não toca o dashboard-v4) --------------------------
// ── Janela avulsa de 1 câmera (só-vídeo, reconexão + fallback MJPEG). Token no
// HASH (#t=...) — não vai pro servidor/log. NOTA (Bruno 07-07): o Chrome permite
// só 1 PIP no navegador INTEIRO (não 1 por janela, como se supôs antes) → "as 2
// câmeras no topo" só via "PIP tudo" (as 2 num único float) no dashboard.
router.get('/cameras/pip', (req, res) => {
  const cam = String(req.query.cam || '');
  if (!CAMS.has(cam)) return res.status(404).send('cam?');
  const label = { warehouse: '🏭 Warehouse Floor', packaging: '📦 Packaging Line', formulation: '🧪 Formulation Cam 1' }[cam] || cam;
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${label}</title>
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden;font:13px system-ui;color:#fff}
  #wrap{position:relative;height:100%}
  #stage{position:absolute;inset:0}
  video,#vm{width:100%;height:100%;object-fit:contain;display:block;background:#000}
  .chip{position:fixed;top:6px;left:8px;z-index:2;background:rgba(0,0,0,.55);padding:3px 8px;border-radius:6px;font-weight:700;font-size:12px}
</style></head><body>
<div id="wrap"><span class="chip">${label}</span>
<div id="stage"><video id="v" muted autoplay playsinline></video><img id="vm" alt="" style="display:none"></div></div>
<script>
(function(){
  var cam=${JSON.stringify(cam)}, label=${JSON.stringify(label)};
  var tok=(location.hash.match(/t=([^&]+)/)||[])[1]||'';
  if(!tok){ document.getElementById('wrap').innerHTML='<div style="display:grid;place-items:center;height:100%;text-align:center;padding:12px">Sessão das câmeras não encontrada — abra pelo dashboard.</div>'; return; }
  var v=document.getElementById('v'), im=document.getElementById('vm'), stage=document.getElementById('stage'), retry=null, mode='mp4', blackTimer=null, fails=0;
  function mp4src(){ return '/api/cam/'+cam+'/mp4?t='+decodeURIComponent(tok)+'&r='+Date.now(); }
  function mjpgsrc(){ return '/api/cam/'+cam+'?t='+decodeURIComponent(tok)+'&r='+Date.now(); }
  // fMP4 fica PRETO numa conexão nova até o 1º keyframe (a warehouse tem GOP
  // longo → era o "pop-out/PIP só da warehouse preto", Bruno 07-07). Se em 6s o
  // mp4 não render, cai pra MJPEG (frame isolado, aparece na hora).
  function toMjpeg(){ mode='mjpeg'; clearTimeout(blackTimer); try{v.pause();}catch(e){} v.removeAttribute('src'); try{v.load();}catch(e){} v.style.display='none'; im.style.display='block'; im.onerror=function(){ clearTimeout(retry); retry=setTimeout(function(){ im.src=mjpgsrc(); },2500); }; im.src=mjpgsrc(); }
  function startMp4(){ mode='mp4'; im.style.display='none'; v.style.display='block'; v.src=mp4src(); v.play&&v.play().catch(function(){}); clearTimeout(blackTimer); blackTimer=setTimeout(function(){ if(mode==='mp4'&&v.readyState<3) toMjpeg(); },6000); }
  v.onplaying=function(){ clearTimeout(blackTimer); };
  v.onerror=function(){ fails++; if(fails>=2){ toMjpeg(); } else { clearTimeout(retry); retry=setTimeout(startMp4,2500); } };
  v.onended=v.onerror;
  startMp4();
  // (Janela simples só-vídeo. O "sempre no topo" foi removido — Chrome só
  // permite 1 PIP no total; pra as 2 câmeras no topo use "PIP tudo" no dashboard.)
})();
</script></body></html>`);
});

// ── PÁGINA DE TAGGING (Bruno 08-01): o Bruno desenha retângulos numa foto ao vivo
// de cada câmera e NOMEIA cada máquina/área (máquina de cápsulas, mixer, saída das
// cápsulas, mesa de P&P, computador, etc). Salva em v3.camera_zones. Como as
// máquinas não se movem, marca 1× e o Claude sabe pra sempre onde olhar. ─────
router.get('/cameras/tag', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Marcar máquinas nas câmeras</title>
<style>
  body{margin:0;background:#0d1117;color:#e6edf3;font:15px system-ui,sans-serif;}
  header{padding:12px 20px;font-weight:700;border-bottom:1px solid #21262d;}
  header .sub{color:#8b949e;font-weight:400;font-size:13px;display:block;margin-top:3px;}
  .wrap{max-width:1100px;margin:0 auto;padding:16px;}
  .cam{background:#161b22;border:1px solid #21262d;border-radius:12px;margin-bottom:22px;overflow:hidden;}
  .cam h2{margin:0;padding:10px 14px;font-size:15px;border-bottom:1px solid #21262d;}
  .tools{display:flex;align-items:center;gap:8px;padding:9px 14px;flex-wrap:wrap;border-bottom:1px solid #21262d;}
  .tools button{border:1px solid #30363d;background:#0d1117;color:#c9d1d9;border-radius:8px;padding:5px 11px;font-size:12.5px;cursor:pointer;}
  .tools button:hover{background:#1f242c;} .tools .tip{color:#8b949e;font-size:12px;}
  .stage{position:relative;line-height:0;background:#000;cursor:crosshair;touch-action:none;}
  .stage img{width:100%;display:block;}
  .stage canvas{position:absolute;inset:0;width:100%;height:100%;}
  .cam .list{padding:10px 14px;display:flex;flex-wrap:wrap;gap:8px;}
  .chip{display:inline-flex;align-items:center;gap:7px;background:#21262d;border:1px solid #30363d;border-radius:999px;padding:4px 6px 4px 12px;font-size:13px;}
  .chip b{font-weight:600;} .chip small{color:#8b949e;}
  .chip button{border:0;background:#3d1418;color:#f85149;border-radius:50%;width:20px;height:20px;cursor:pointer;font-size:13px;line-height:1;}
  .hint{padding:0 14px 12px;color:#8b949e;font-size:12.5px;}
  #pin-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:20;}
  #pin-overlay .box{background:#161b22;border:1px solid #30363d;padding:22px;border-radius:12px;min-width:270px;}
  #pin-overlay input{width:100%;box-sizing:border-box;padding:9px;margin:10px 0;border:1px solid #30363d;border-radius:8px;background:#0d1117;color:#e6edf3;font-size:15px;}
  #pin-overlay button{width:100%;padding:9px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;}
  #dlg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:30;}
  #dlg .box{background:#161b22;border:1px solid #30363d;padding:20px;border-radius:12px;min-width:320px;max-width:92vw;}
  #dlg label{display:block;font-size:12.5px;color:#8b949e;margin:10px 0 4px;}
  #dlg input,#dlg select,#dlg textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #30363d;border-radius:8px;background:#0d1117;color:#e6edf3;font-size:14px;}
  #dlg .row{display:flex;gap:10px;margin-top:16px;} #dlg .row button{flex:1;padding:9px;border:0;border-radius:8px;font-weight:600;cursor:pointer;}
  #dlg .ok{background:#2ea043;color:#fff;} #dlg .cancel{background:#30363d;color:#c9d1d9;}
  #err{color:#f85149;font-size:13px;min-height:16px;}
</style></head><body>
<header>🏷️ Marcar máquinas & áreas nas câmeras
  <span class="sub">Arraste um retângulo em cima de cada máquina/área e dê um nome. Como elas não se movem, você faz isso uma vez só. Isso ensina o sistema onde olhar.</span></header>
<div class="wrap" id="wrap">
  <div class="cam" data-cam="warehouse"><h2>🏭 Warehouse Floor</h2><div class="tools"><button data-act="finish">✓ Fechar forma</button><button data-act="undo">↶ Desfazer ponto</button><button data-act="clear">✕ Limpar</button><span class="tip">Clique pra colocar pontos ao redor da máquina; ligue-os. Feche com ✓ ou 2 cliques no 1º ponto.</span></div><div class="stage"><img alt="warehouse"><canvas></canvas></div><div class="list"></div></div>
  <div class="cam" data-cam="packaging"><h2>📦 Packaging Line</h2><div class="tools"><button data-act="finish">✓ Fechar forma</button><button data-act="undo">↶ Desfazer ponto</button><button data-act="clear">✕ Limpar</button><span class="tip">Ex.: Máquina de cápsulas, Saída das cápsulas, Mesa de P&P, Computador…</span></div><div class="stage"><img alt="packaging"><canvas></canvas></div><div class="list"></div></div>
  <div class="cam" data-cam="formulation"><h2>🧪 Formulation</h2><div class="tools"><button data-act="finish">✓ Fechar forma</button><button data-act="undo">↶ Desfazer ponto</button><button data-act="clear">✕ Limpar</button><span class="tip">Ex.: Mixer, Área de formulação…</span></div><div class="stage"><img alt="formulation"><canvas></canvas></div><div class="list"></div></div>
</div>
<div id="pin-overlay"><div class="box"><strong>PIN das câmeras</strong>
  <input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="••••••" autofocus>
  <div id="err"></div><button id="go">Entrar</button></div></div>
<div id="dlg"><div class="box"><strong>Nomear zona</strong>
  <label>Nome (o que é?)</label><input id="z-name" placeholder="Ex.: Máquina de cápsulas">
  <label>Tipo</label><select id="z-kind">
    <option value="machine">Máquina</option><option value="output">Saída (ex.: onde saem as cápsulas)</option>
    <option value="area">Área (ex.: P&P, formulação)</option><option value="table">Mesa/bancada</option>
    <option value="computer">Computador</option><option value="object">Objeto (ex.: aspirador)</option></select>
  <label>Observação (opcional)</label><textarea id="z-notes" rows="2" placeholder="Ex.: se sair menos cápsula aqui, pode ter problema na máquina"></textarea>
  <div class="row"><button class="cancel" id="z-cancel">Cancelar</button><button class="ok" id="z-save">Salvar</button></div></div></div>
<script>
(function(){
  var K='hf_cam_tok', TOKEN=null;
  var ov=document.getElementById('pin-overlay'), err=document.getElementById('err');
  var CAMS=['warehouse','packaging','formulation'];
  var state={}; // cam -> {img,canvas,list,zones,pts,hover}
  var pending=null; // {cam, points}

  CAMS.forEach(function(cam){
    var el=document.querySelector('.cam[data-cam="'+cam+'"]');
    state[cam]={img:el.querySelector('img'),canvas:el.querySelector('canvas'),list:el.querySelector('.list'),zones:[],pts:[],hover:null};
    var st=el.querySelector('.stage');
    // CLICAR pra colocar ponto; 2 cliques perto do 1º ponto = fecha a forma
    st.addEventListener('pointerdown',function(e){ addPoint(cam,e); });
    st.addEventListener('pointermove',function(e){ state[cam].hover=frac(cam,e); draw(cam); });
    st.addEventListener('pointerleave',function(){ state[cam].hover=null; draw(cam); });
    el.querySelectorAll('.tools button').forEach(function(b){ b.addEventListener('click',function(){ var a=b.dataset.act; if(a==='finish')finish(cam); else if(a==='undo'){state[cam].pts.pop();draw(cam);} else if(a==='clear'){state[cam].pts=[];draw(cam);} }); });
  });
  function frac(cam,e){ var r=state[cam].img.getBoundingClientRect(); return {x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)), y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))}; }
  function addPoint(cam,e){ e.preventDefault(); var s=state[cam]; var p=frac(cam,e);
    // clicou perto do 1º ponto (com >=3) → fecha a forma
    if(s.pts.length>=3){ var f=s.pts[0]; var r=s.img.getBoundingClientRect(); var dx=(p.x-f.x)*r.width, dy=(p.y-f.y)*r.height; if(Math.sqrt(dx*dx+dy*dy)<14){ finish(cam); return; } }
    s.pts.push(p); draw(cam);
  }
  function finish(cam){ var s=state[cam]; if(s.pts.length<3){ alert('Coloque pelo menos 3 pontos ao redor da máquina.'); return; } pending={cam:cam,points:s.pts.slice()}; openDlg(); }
  function draw(cam){ var s=state[cam],cv=s.canvas,img=s.img; cv.width=img.clientWidth; cv.height=img.clientHeight; var c=cv.getContext('2d'); c.clearRect(0,0,cv.width,cv.height); var W=cv.width,H=cv.height;
    s.zones.forEach(function(z){ var pts=z.points||bboxPts(z); poly(c,pts,'#2ea043','rgba(46,160,67,.16)',z.name,W,H,true); });
    if(s.pts.length){ // forma em construção
      poly(c,s.pts,'#58a6ff','rgba(88,166,255,.14)','',W,H,false);
      if(s.hover){ var last=s.pts[s.pts.length-1]; c.strokeStyle='rgba(88,166,255,.6)'; c.setLineDash([5,4]); c.beginPath(); c.moveTo(last.x*W,last.y*H); c.lineTo(s.hover.x*W,s.hover.y*H); c.stroke(); c.setLineDash([]); }
      s.pts.forEach(function(p,i){ c.beginPath(); c.arc(p.x*W,p.y*H,i===0?6:4,0,7); c.fillStyle=i===0?'#f0c040':'#58a6ff'; c.fill(); });
    }
  }
  function bboxPts(z){ return [{x:z.x0,y:z.y0},{x:z.x1,y:z.y0},{x:z.x1,y:z.y1},{x:z.x0,y:z.y1}]; }
  function poly(c,pts,stroke,fill,label,W,H,closed){ if(!pts.length)return; c.beginPath(); c.moveTo(pts[0].x*W,pts[0].y*H); for(var i=1;i<pts.length;i++)c.lineTo(pts[i].x*W,pts[i].y*H); if(closed)c.closePath(); c.fillStyle=fill; if(closed)c.fill(); c.strokeStyle=stroke; c.lineWidth=2; c.stroke();
    if(label){ var cx=0,cy=0; pts.forEach(function(p){cx+=p.x;cy+=p.y;}); cx=cx/pts.length*W; cy=cy/pts.length*H; c.fillStyle='rgba(0,0,0,.55)'; var tw=c.measureText(label).width; c.fillRect(cx-tw/2-4,cy-9,tw+8,17); c.fillStyle='#fff'; c.font='bold 13px system-ui'; c.textAlign='center'; c.fillText(label,cx,cy+4); c.textAlign='left'; } }

  function openDlg(){ document.getElementById('z-name').value=''; document.getElementById('z-notes').value=''; document.getElementById('dlg').style.display='flex'; document.getElementById('z-name').focus(); }
  document.getElementById('z-cancel').onclick=function(){ document.getElementById('dlg').style.display='none'; pending=null; };
  document.getElementById('z-save').onclick=function(){
    if(!pending)return; var name=document.getElementById('z-name').value.trim(); if(!name){document.getElementById('z-name').focus();return;}
    var body={t:TOKEN,cam:pending.cam,name:name,kind:document.getElementById('z-kind').value,notes:document.getElementById('z-notes').value.trim(),points:pending.points};
    fetch('/api/cam/zones',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(j){
      document.getElementById('dlg').style.display='none';
      if(j.ok){ state[pending.cam].zones.push({id:j.id,name:name,kind:body.kind,points:pending.points}); state[pending.cam].pts=[]; render(pending.cam); }
      else alert('Erro: '+(j.error||'?'));
      pending=null;
    }).catch(function(){alert('sem conexão');});
  };
  function render(cam){ var s=state[cam]; draw(cam);
    s.list.innerHTML=''; s.zones.forEach(function(z){ var chip=document.createElement('span'); chip.className='chip'; chip.innerHTML='<b>'+esc(z.name)+'</b> <small>'+esc(z.kind||'')+'</small>'; var b=document.createElement('button'); b.textContent='×'; b.title='apagar'; b.onclick=function(){ del(cam,z.id); }; chip.appendChild(b); s.list.appendChild(chip); });
  }
  function del(cam,id){ if(!confirm('Apagar essa marcação?'))return; fetch('/api/cam/zones/'+id,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({t:TOKEN})}).then(function(){ state[cam].zones=state[cam].zones.filter(function(z){return z.id!==id;}); render(cam); }); }
  function esc(s){ return String(s).replace(/[&<>"]/g,function(m){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m];}); }

  function loadZones(){ fetch('/api/cam/zones?t='+encodeURIComponent(TOKEN)).then(function(r){return r.json();}).then(function(j){ (j.zones||[]).forEach(function(z){ if(state[z.cam]) state[z.cam].zones.push(z); }); CAMS.forEach(render); }); }
  function startAll(){ CAMS.forEach(function(cam){ var img=state[cam].img; img.onload=function(){ draw(cam); }; img.src='/api/cam/'+cam+'?t='+encodeURIComponent(TOKEN)+'&r='+Date.now(); }); loadZones(); }
  window.addEventListener('resize',function(){ CAMS.forEach(draw); });

  function auth(tok){ TOKEN=tok; try{localStorage.setItem(K,tok);}catch(e){} ov.style.display='none'; startAll(); }
  function tryTok(t){ if(!t)return false; var i=(''+t).indexOf('.'); var exp=i>0?Number((''+t).slice(0,i)):0; return exp&&Date.now()<exp-60000; }
  document.getElementById('go').onclick=doPin;
  document.getElementById('pin').addEventListener('keydown',function(e){ if(e.key==='Enter')doPin(); });
  function doPin(){ var pin=document.getElementById('pin').value.trim(); if(!pin)return; err.textContent='';
    fetch('/api/cam/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:pin})}).then(function(r){ if(r.status===200)return r.json(); if(r.status===403)throw'PIN incorreto'; if(r.status===429)throw'Muitas tentativas'; throw'Câmeras offline'; }).then(function(j){ auth(j.token); }).catch(function(m){ err.textContent=(typeof m==='string'?m:'erro'); }); }
  var saved=null; try{saved=localStorage.getItem(K);}catch(e){}
  if(tryTok(saved)) auth(saved); else document.getElementById('pin').focus();
})();
</script></body></html>`);
});

// Recursos (pedido Bruno 07-01): auto-reconexão com backoff (gateway flapa),
// tamanho ajustável dos cards, fullscreen por câmera, PIP NATIVO (estilo
// YouTube: janela flutuante do SO, redimensionável, sempre no topo).
// PIP técnica: MJPEG (<img>) não entra em PIP direto — bombeamos os frames num
// <canvas> -> captureStream() -> <video> escondido -> requestPictureInPicture().
router.get('/cameras', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Câmeras — Produção</title>
<style>
  body{margin:0;background:#0d1117;color:#e6edf3;font:15px system-ui,sans-serif;}
  header{padding:12px 20px;font-weight:700;letter-spacing:.3px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:14px;flex-wrap:wrap;}
  header .sub{color:#8b949e;font-weight:400;font-size:13px;}
  #gw{width:9px;height:9px;border-radius:50%;background:#8b949e;flex:none;}
  #gw.ok{background:#2ea043;} #gw.down{background:#f85149;}
  .sizer{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12.5px;color:#8b949e;}
  .sizer input{accent-color:#2563eb;width:140px;}
  .grid{display:grid;gap:16px;padding:16px;grid-template-columns:repeat(auto-fit,minmax(var(--wtile,520px),1fr));max-width:1780px;margin:0 auto;}
  .card{background:#161b22;border:1px solid #21262d;border-radius:12px;overflow:hidden;position:relative;}
  .card .bar{display:flex;align-items:center;gap:8px;padding:9px 12px;}
  .card h2{margin:0;font-size:14px;color:#9fb0c0;font-weight:600;flex:1;}
  .badge{font-size:11px;padding:2px 8px;border-radius:999px;background:#21262d;color:#8b949e;flex:none;}
  .badge.live{background:rgba(46,160,67,.18);color:#3fb950;}
  .badge.retry{background:rgba(210,153,34,.18);color:#d29922;}
  .badge.off{background:rgba(248,81,73,.15);color:#f85149;}
  .bar button{flex:none;border:1px solid #30363d;background:#0d1117;color:#c9d1d9;border-radius:8px;padding:4px 9px;font-size:12.5px;cursor:pointer;}
  .bar button:hover{background:#1f242c;}
  .card img,.card video{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#000;}
  .card:fullscreen{background:#000;} .card:fullscreen img,.card:fullscreen video{height:calc(100vh - 42px);aspect-ratio:auto;}
  .off-msg{padding:26px;text-align:center;color:#8b949e;display:none;font-size:13.5px;}
  #pin-overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:10;}
  #pin-overlay .box{background:#161b22;border:1px solid #30363d;padding:22px;border-radius:12px;min-width:270px;}
  #pin-overlay input{width:100%;box-sizing:border-box;padding:9px;margin:10px 0;border:1px solid #30363d;border-radius:8px;background:#0d1117;color:#e6edf3;font-size:15px;}
  #pin-overlay button{width:100%;padding:9px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;}
  #pin-err{color:#f85149;font-size:13px;min-height:16px;}
</style></head><body>
<header>🎥 Câmeras — Produção <span id="gw" title="gateway"></span><span class="sub">(ao vivo, somente visualização)</span>
  <span class="sizer">
    <button id="pipall" style="border:1px solid #30363d;background:#0d1117;color:#c9d1d9;border-radius:8px;padding:4px 10px;font-size:12.5px;cursor:pointer;" title="Uma janela PIP flutuante com TODAS as câmeras lado a lado (o navegador só permite 1 janela PIP por vez)">⧉ PIP tudo</button>
    tamanho <input id="sz" type="range" min="340" max="1400" step="20">
  </span>
</header>
<div id="pin-overlay"><div class="box"><strong>PIN das câmeras</strong>
  <input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="••••••" autofocus>
  <div id="pin-err"></div><button id="go">Entrar</button></div></div>
<div class="grid" id="grid">
  <div class="card" data-cam="warehouse">
    <div class="bar"><h2>🏭 Warehouse Floor</h2><span class="badge">—</span>
      <button data-act="pip" title="Picture-in-Picture (janela flutuante)">⧉ PIP</button>
      <button data-act="fs" title="Tela cheia">⛶</button></div>
    <video muted autoplay playsinline></video><img alt="Warehouse Floor" style="display:none"><div class="off-msg"></div>
  </div>
  <div class="card" data-cam="packaging">
    <div class="bar"><h2>📦 Packaging Line</h2><span class="badge">—</span>
      <button data-act="pip" title="Picture-in-Picture (janela flutuante)">⧉ PIP</button>
      <button data-act="fs" title="Tela cheia">⛶</button></div>
    <video muted autoplay playsinline></video><img alt="Packaging Line" style="display:none"><div class="off-msg"></div>
  </div>
</div>
<script>
(function(){
  var K='hf_cam_tok', TOKEN=null;
  var ov=document.getElementById('pin-overlay'), inp=document.getElementById('pin'), err=document.getElementById('pin-err');
  var gw=document.getElementById('gw');
  var cams={}; // id -> {card,img,badge,offmsg,backoff,timer,pump,video,canvas,inPip}
  document.querySelectorAll('.card').forEach(function(c){
    cams[c.dataset.cam]={card:c,img:c.querySelector('img'),video:c.querySelector('video'),badge:c.querySelector('.badge'),offmsg:c.querySelector('.off-msg'),backoff:2000,timer:null,stallTimer:null,firstFrameTimer:null,pump:null,pipVideo:null,canvas:null,inPip:false,mode:'mp4',mp4Fails:0};
  });

  // ── tamanho ajustável (persistido) ──
  var sz=document.getElementById('sz');
  var savedSz=parseInt(localStorage.getItem('hf_cam_size')||'520',10);
  sz.value=savedSz; document.documentElement.style.setProperty('--wtile', savedSz+'px');
  sz.oninput=function(){ document.documentElement.style.setProperty('--wtile', sz.value+'px'); try{localStorage.setItem('hf_cam_size', sz.value);}catch(e){} };

  function setBadge(c, cls, txt){ c.badge.className='badge '+cls; c.badge.textContent=txt; }

  // ── stream + AUTO-RECONEXÃO (o gateway flapa; nunca desiste) ──
  // v3: H.264 fMP4 FULL HD primeiro (<video>, /api/cam/<id>/mp4) — 1080p fluido;
  // se falhar 3×, cai sozinho pro MJPEG (<img>) e segue tentando.
  function markOff(c, id){
    clearTimeout(c.stallTimer); clearTimeout(c.firstFrameTimer);
    c.offmsg.textContent='câmera offline — reconectando sozinho…';
    c.offmsg.style.display='block';
    setBadge(c,'off','offline · re-tentando');
    c.timer=setTimeout(function(){ startStream(id); }, c.backoff);
    c.backoff=Math.min(c.backoff*1.8, 30000); // 2s → 30s cap
  }
  function startStream(id){
    var c=cams[id]; if(!TOKEN) return;
    clearTimeout(c.timer); clearTimeout(c.stallTimer); clearTimeout(c.firstFrameTimer);
    setBadge(c,'retry','conectando…');
    c.offmsg.style.display='none';
    if(c.mode==='mp4' && c.video){
      c.video.style.display='block'; c.img.style.display='none';
      var v=c.video;
      var fail=function(){
        clearTimeout(c.stallTimer); clearTimeout(c.firstFrameTimer);
        c.mp4Fails++;
        v.style.display='none';
        // TELA PRETA / mp4 problemático (GOP longo da warehouse) → cai RÁPIDO pro
        // MJPEG, que agora tem reconexão transparente no servidor (robusto). Bruno 07-08.
        if(c.mp4Fails>=2){ c.mode='mjpeg'; c.backoff=2000; startStream(id); return; }
        markOff(c, id);
      };
      v.onerror=fail; v.onended=fail;
      v.onplaying=function(){ setBadge(c,'live','ao vivo · HD'); c.backoff=2000; c.mp4Fails=0; clearTimeout(c.firstFrameTimer); };
      // WATCHDOG do 1º frame: se não COMEÇOU a tocar em 7s (keyframe não chegou →
      // tela preta), falha e cai pro MJPEG em vez de ficar preto pra sempre.
      c.firstFrameTimer=setTimeout(function(){ if(v.readyState<3 || !(v.currentTime>0)) fail(); }, 7000);
      v.onwaiting=function(){
        clearTimeout(c.stallTimer);
        c.stallTimer=setTimeout(function(){ if(v.readyState<3) fail(); }, 7000);
      };
      v.src='/api/cam/'+id+'/mp4?t='+encodeURIComponent(TOKEN)+'&r='+Date.now();
      v.play().catch(function(){});
    } else {
      c.video && (c.video.style.display='none');
      c.img.style.display='block';
      c.img.onerror=function(){ c.img.style.display='none'; markOff(c, id); };
      c.img.onload=function(){ setBadge(c,'live','ao vivo'); c.backoff=2000; };
      c.img.src='/api/cam/'+id+'?t='+encodeURIComponent(TOKEN)+'&r='+Date.now();
    }
  }
  function startAll(){ Object.keys(cams).forEach(startStream); }

  // ── health poll: quando o gateway VOLTA, reconecta na hora ──
  setInterval(function(){
    if(!TOKEN) return;
    fetch('/api/cam/health?t='+encodeURIComponent(TOKEN)).then(function(r){return r.json();}).then(function(j){
      gw.className=j.reachable?'ok':'down';
      gw.title=j.reachable?'gateway das câmeras: no ar':'gateway das câmeras: fora do ar (PC das câmeras/túnel)';
      // gateway VOLTOU e a câmera está offline → reconecta na hora, e volta a
      // TENTAR o mp4 (HD): a queda pode ter sido do gateway, não do codec —
      // não deixa a câmera presa no MJPEG pra sempre depois de um blip. Bruno 07-08.
      if(j.reachable){ Object.keys(cams).forEach(function(id){ var c=cams[id]; if(c.badge.className.indexOf('off')>=0){ c.backoff=2000; if(c.video){ c.mode='mp4'; c.mp4Fails=0; } startStream(id); } }); }
    }).catch(function(){});
  }, 15000);
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState==='visible' && TOKEN){ Object.keys(cams).forEach(function(id){ if(cams[id].badge.className.indexOf('off')>=0) startStream(id); }); }
  });

  // ── fullscreen ──
  function goFs(id){ var el=cams[id].card; (el.requestFullscreen||el.webkitRequestFullscreen||function(){}).call(el); }

  // ── PIP nativo (estilo YouTube). No mp4 é DIRETO no <video> (Full HD, sem
  // canvas). No fallback MJPEG usa canvas pump -> captureStream -> video PIP. ──
  function togglePip(id){
    var c=cams[id];
    if(!document.pictureInPictureEnabled){ alert('Este navegador não suporta Picture-in-Picture. Use Chrome/Edge.'); return; }
    if(c.mode==='mp4' && c.video){
      if(document.pictureInPictureElement===c.video){ document.exitPictureInPicture().catch(function(){}); return; }
      c.video.requestPictureInPicture().catch(function(e){ alert('PIP falhou: '+e.message); });
      return;
    }
    if(c.inPip && c.pipVideo){ document.exitPictureInPicture().catch(function(){}); return; }
    if(!c.canvas){
      c.canvas=document.createElement('canvas');
      c.pipVideo=document.createElement('video');
      c.pipVideo.muted=true; c.pipVideo.playsInline=true; c.pipVideo.style.display='none';
      document.body.appendChild(c.pipVideo);
    }
    var w=c.img.naturalWidth||1280, h=c.img.naturalHeight||720;
    c.canvas.width=w; c.canvas.height=h;
    var ctx=c.canvas.getContext('2d');
    clearInterval(c.pump);
    c.pump=setInterval(function(){ try{ if(c.img.complete && c.img.naturalWidth) ctx.drawImage(c.img,0,0,w,h); }catch(e){} }, 66); // ~15fps
    if(!c.pipVideo.srcObject){ c.pipVideo.srcObject=c.canvas.captureStream(15); }
    c.pipVideo.play().then(function(){ return c.pipVideo.requestPictureInPicture(); }).then(function(){
      c.inPip=true;
      c.pipVideo.addEventListener('leavepictureinpicture', function onleave(){
        c.inPip=false; clearInterval(c.pump); c.pump=null;
        c.pipVideo.removeEventListener('leavepictureinpicture', onleave);
      });
    }).catch(function(e){ clearInterval(c.pump); c.pump=null; alert('PIP falhou: '+e.message); });
  }

  // ── MULTI-PIP: TODAS as câmeras numa janela PIP só (Bruno 07-01).
  // O navegador só permite UMA janela PIP por vez (abrir outra fecha a anterior)
  // — então compomos os streams lado a lado num canvas e mandamos o conjunto.
  var LBL={warehouse:'Warehouse Floor',packaging:'Packaging Line'};
  var all={canvas:null,video:null,pump:null,inPip:false};
  function togglePipAll(){
    if(!document.pictureInPictureEnabled){ alert('Este navegador não suporta Picture-in-Picture. Use Chrome/Edge.'); return; }
    if(all.inPip&&all.video){ document.exitPictureInPicture().catch(function(){}); return; }
    if(!all.canvas){
      all.canvas=document.createElement('canvas');
      all.video=document.createElement('video');
      all.video.muted=true; all.video.playsInline=true; all.video.style.display='none';
      document.body.appendChild(all.video);
    }
    var ids=Object.keys(cams), cw=1280, ch=720;
    all.canvas.width=cw*ids.length; all.canvas.height=ch;
    var ctx=all.canvas.getContext('2d');
    clearInterval(all.pump);
    all.pump=setInterval(function(){
      ids.forEach(function(id,ix){
        var c2=cams[id];
        // fonte = <video> H.264 (mp4) ou <img> MJPEG (fallback) — drawImage aceita os 2
        var el=(c2.mode==='mp4' && c2.video && c2.video.readyState>=2) ? c2.video
          : (c2.img && c2.img.complete && c2.img.naturalWidth) ? c2.img : null;
        try{
          ctx.fillStyle='#000'; ctx.fillRect(ix*cw,0,cw,ch);
          if(el){
            var sw=el.videoWidth||el.naturalWidth, sh=el.videoHeight||el.naturalHeight;
            var s=Math.min(cw/sw,ch/sh), w=sw*s, h=sh*s;
            ctx.drawImage(el, ix*cw+(cw-w)/2, (ch-h)/2, w, h);
          } else {
            ctx.fillStyle='#8b949e'; ctx.font='26px system-ui'; ctx.fillText('câmera offline — reconectando…', ix*cw+40, ch/2);
          }
          ctx.fillStyle='rgba(0,0,0,.55)'; ctx.fillRect(ix*cw,0,250,34);
          ctx.fillStyle='#fff'; ctx.font='bold 19px system-ui'; ctx.fillText(LBL[id]||id, ix*cw+12, 24);
          if(ix>0){ ctx.fillStyle='#0d1117'; ctx.fillRect(ix*cw-2,0,4,ch); } // divisor
        }catch(e){}
      });
    },66); // ~15fps
    if(!all.video.srcObject) all.video.srcObject=all.canvas.captureStream(15);
    all.video.play().then(function(){ return all.video.requestPictureInPicture(); }).then(function(){
      all.inPip=true;
      all.video.addEventListener('leavepictureinpicture', function onleave(){
        all.inPip=false; clearInterval(all.pump); all.pump=null;
        all.video.removeEventListener('leavepictureinpicture', onleave);
      });
    }).catch(function(e){ clearInterval(all.pump); all.pump=null; alert('PIP falhou: '+e.message); });
  }
  document.getElementById('pipall').onclick=togglePipAll;

  document.querySelectorAll('.card').forEach(function(card){
    card.querySelector('[data-act=fs]').onclick=function(){ goFs(card.dataset.cam); };
    card.querySelector('[data-act=pip]').onclick=function(){ togglePip(card.dataset.cam); };
  });

  // ── sessão (PIN 1x -> token; PIN nunca em URL) ──
  function tokenFresh(t){ if(!t) return false; var exp=parseInt(String(t).split('.')[0],10); return isFinite(exp) && Date.now() < exp - 60000; }
  function tryPin(pin){
    fetch('/api/cam/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:pin})})
      .then(function(r){
        if(r.status===200){ return r.json().then(function(j){
          TOKEN=j.token; try{ localStorage.setItem(K, j.token); }catch(e){}
          ov.style.display='none'; startAll();
        }); }
        if(r.status===403){ err.textContent='PIN incorreto'; return; }
        if(r.status===429){ err.textContent='Muitas tentativas — aguarde um pouco'; return; }
        err.textContent='Câmeras offline no momento — tente mais tarde';
      }).catch(function(){ err.textContent='Sem conexão com o servidor'; });
  }
  document.getElementById('go').onclick=function(){ var p=inp.value.trim(); if(p) tryPin(p); };
  inp.addEventListener('keydown', function(e){ if(e.key==='Enter') document.getElementById('go').click(); });
  var saved=null; try{ saved=localStorage.getItem(K); }catch(e){}
  if(tokenFresh(saved)){ TOKEN=saved; ov.style.display='none'; startAll(); }
  else { try{ localStorage.removeItem(K); }catch(e){} }
})();
</script></body></html>`);
});

module.exports = router;
