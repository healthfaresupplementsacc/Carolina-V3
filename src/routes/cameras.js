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

const router = express.Router();

const CAMS = new Set(['warehouse', 'packaging']);
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

// ── health: o PC das câmeras está alcançável AGORA? (a página usa pra
// reconectar sozinha quando o gateway volta — ele flapa na prática) ─────────
router.get('/api/cam/health', async (req, res) => {
  if (!tokenOk(req.query.t)) return res.status(403).json({ error: 'bad_token' });
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
const brokers = new Map(); // name -> Promise<broker|null>; broker = {clients:Set, ctrl, node, contentType, alive}

async function openBroker(name) {
  const base = process.env.CAM_TUNNEL_URL;
  const token = process.env.CAM_TOKEN;
  if (!base || !token) return null;
  const b = { clients: new Set(), ctrl: new AbortController(), node: null, contentType: null, alive: false, lingerTimer: null };
  // fail-fast: funnel pendurado → corta em 8s (a página re-tenta sozinha).
  const connectTimer = setTimeout(() => b.ctrl.abort(), 8000);
  let up;
  try {
    up = await fetch(`${base.replace(/\/$/, '')}/stream/${name}`, {
      headers: { 'X-Cam-Token': token },
      signal: b.ctrl.signal,
    });
  } catch { clearTimeout(connectTimer); return null; }
  clearTimeout(connectTimer);
  if (!up.ok || !up.body) return null;
  b.contentType = up.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=frame';
  b.alive = true;
  b.node = Readable.fromWeb(up.body);
  const teardown = () => {
    b.alive = false;
    brokers.delete(name);
    for (const c of b.clients) { try { c.end(); } catch (_) {} }
    b.clients.clear();
  };
  b.node.on('data', (chunk) => {
    for (const c of b.clients) {
      try {
        if (c.writableLength > 4 * 1024 * 1024) { c.destroy(); b.clients.delete(c); continue; }
        c.write(chunk);
      } catch (_) { b.clients.delete(c); }
    }
  });
  b.node.on('error', teardown);
  b.node.on('end', teardown);
  return b;
}

function getBroker(name) {
  const cur = brokers.get(name);
  if (cur) return cur;                       // Promise (corrida de 2 primeiros-viewers → 1 upstream)
  const p = openBroker(name).then((b) => {
    if (!b) brokers.delete(name);
    return b;
  }).catch(() => { brokers.delete(name); return null; });
  brokers.set(name, p);
  return p;
}

router.get('/api/cam/:name', async (req, res) => {
  const { name } = req.params;
  if (!CAMS.has(name)) return res.status(404).json({ error: 'unknown_camera' });
  if (!tokenOk(req.query.t)) return res.status(403).json({ error: 'bad_token' });
  if (!process.env.CAM_TUNNEL_URL || !process.env.CAM_TOKEN) {
    return res.status(503).json({ error: 'cameras_offline' }); // migração/PC desligado — V4 segue intacto
  }
  const b = await getBroker(name);
  if (!b || !b.alive) return res.status(503).json({ error: 'cameras_offline' });

  res.status(200);
  res.set('Content-Type', b.contentType);
  res.set('Cache-Control', 'no-store');
  b.clients.add(res);
  if (b.lingerTimer) { clearTimeout(b.lingerTimer); b.lingerTimer = null; }
  req.on('close', () => {
    b.clients.delete(res);
    // último viewer saiu → segura 5s (reload rápido reusa) e derruba o upstream
    if (b.clients.size === 0 && b.alive) {
      b.lingerTimer = setTimeout(() => {
        if (b.clients.size === 0) { try { b.ctrl.abort(); b.node && b.node.destroy(); } catch (_) {} brokers.delete(name); }
      }, 5000);
    }
  });
});


// ---- página standalone (não toca o dashboard-v4) --------------------------
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
  .card img{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#000;}
  .card:fullscreen{background:#000;} .card:fullscreen img{height:calc(100vh - 42px);aspect-ratio:auto;}
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
    <img alt="Warehouse Floor"><div class="off-msg"></div>
  </div>
  <div class="card" data-cam="packaging">
    <div class="bar"><h2>📦 Packaging Line</h2><span class="badge">—</span>
      <button data-act="pip" title="Picture-in-Picture (janela flutuante)">⧉ PIP</button>
      <button data-act="fs" title="Tela cheia">⛶</button></div>
    <img alt="Packaging Line"><div class="off-msg"></div>
  </div>
</div>
<script>
(function(){
  var K='hf_cam_tok', TOKEN=null;
  var ov=document.getElementById('pin-overlay'), inp=document.getElementById('pin'), err=document.getElementById('pin-err');
  var gw=document.getElementById('gw');
  var cams={}; // id -> {card,img,badge,offmsg,backoff,timer,pump,video,canvas,inPip}
  document.querySelectorAll('.card').forEach(function(c){
    cams[c.dataset.cam]={card:c,img:c.querySelector('img'),badge:c.querySelector('.badge'),offmsg:c.querySelector('.off-msg'),backoff:2000,timer:null,pump:null,video:null,canvas:null,inPip:false};
  });

  // ── tamanho ajustável (persistido) ──
  var sz=document.getElementById('sz');
  var savedSz=parseInt(localStorage.getItem('hf_cam_size')||'520',10);
  sz.value=savedSz; document.documentElement.style.setProperty('--wtile', savedSz+'px');
  sz.oninput=function(){ document.documentElement.style.setProperty('--wtile', sz.value+'px'); try{localStorage.setItem('hf_cam_size', sz.value);}catch(e){} };

  function setBadge(c, cls, txt){ c.badge.className='badge '+cls; c.badge.textContent=txt; }

  // ── stream + AUTO-RECONEXÃO (o gateway flapa; nunca desiste) ──
  function startStream(id){
    var c=cams[id]; if(!TOKEN) return;
    clearTimeout(c.timer);
    setBadge(c,'retry','conectando…');
    c.img.style.display='block'; c.offmsg.style.display='none';
    c.img.onerror=function(){
      c.img.style.display='none';
      c.offmsg.textContent='câmera offline — reconectando sozinho…';
      c.offmsg.style.display='block';
      setBadge(c,'off','offline · re-tentando');
      c.timer=setTimeout(function(){ startStream(id); }, c.backoff);
      c.backoff=Math.min(c.backoff*1.8, 30000); // 2s → 30s cap
    };
    c.img.onload=function(){ setBadge(c,'live','ao vivo'); c.backoff=2000; };
    c.img.src='/api/cam/'+id+'?t='+encodeURIComponent(TOKEN)+'&r='+Date.now();
  }
  function startAll(){ Object.keys(cams).forEach(startStream); }

  // ── health poll: quando o gateway VOLTA, reconecta na hora ──
  setInterval(function(){
    if(!TOKEN) return;
    fetch('/api/cam/health?t='+encodeURIComponent(TOKEN)).then(function(r){return r.json();}).then(function(j){
      gw.className=j.reachable?'ok':'down';
      gw.title=j.reachable?'gateway das câmeras: no ar':'gateway das câmeras: fora do ar (PC das câmeras/túnel)';
      if(j.reachable){ Object.keys(cams).forEach(function(id){ if(cams[id].badge.className.indexOf('off')>=0){ cams[id].backoff=2000; startStream(id); } }); }
    }).catch(function(){});
  }, 15000);
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState==='visible' && TOKEN){ Object.keys(cams).forEach(function(id){ if(cams[id].badge.className.indexOf('off')>=0) startStream(id); }); }
  });

  // ── fullscreen ──
  function goFs(id){ var el=cams[id].card; (el.requestFullscreen||el.webkitRequestFullscreen||function(){}).call(el); }

  // ── PIP nativo (estilo YouTube): canvas pump -> captureStream -> video PIP ──
  function togglePip(id){
    var c=cams[id];
    if(!document.pictureInPictureEnabled){ alert('Este navegador não suporta Picture-in-Picture. Use Chrome/Edge.'); return; }
    if(c.inPip && c.video){ document.exitPictureInPicture().catch(function(){}); return; }
    if(!c.canvas){
      c.canvas=document.createElement('canvas');
      c.video=document.createElement('video');
      c.video.muted=true; c.video.playsInline=true; c.video.style.display='none';
      document.body.appendChild(c.video);
    }
    var w=c.img.naturalWidth||1280, h=c.img.naturalHeight||720;
    c.canvas.width=w; c.canvas.height=h;
    var ctx=c.canvas.getContext('2d');
    clearInterval(c.pump);
    c.pump=setInterval(function(){ try{ if(c.img.complete && c.img.naturalWidth) ctx.drawImage(c.img,0,0,w,h); }catch(e){} }, 66); // ~15fps
    if(!c.video.srcObject){ c.video.srcObject=c.canvas.captureStream(15); }
    c.video.play().then(function(){ return c.video.requestPictureInPicture(); }).then(function(){
      c.inPip=true;
      c.video.addEventListener('leavepictureinpicture', function onleave(){
        c.inPip=false; clearInterval(c.pump); c.pump=null;
        c.video.removeEventListener('leavepictureinpicture', onleave);
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
        var im=cams[id].img;
        try{
          ctx.fillStyle='#000'; ctx.fillRect(ix*cw,0,cw,ch);
          if(im.complete&&im.naturalWidth){
            var s=Math.min(cw/im.naturalWidth,ch/im.naturalHeight), w=im.naturalWidth*s, h=im.naturalHeight*s;
            ctx.drawImage(im, ix*cw+(cw-w)/2, (ch-h)/2, w, h);
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
