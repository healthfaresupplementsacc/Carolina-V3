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

// ── stream proxied (token na query — de curta duração, não é o PIN) ────────
router.get('/api/cam/:name', async (req, res) => {
  const { name } = req.params;
  if (!CAMS.has(name)) return res.status(404).json({ error: 'unknown_camera' });
  if (!tokenOk(req.query.t)) return res.status(403).json({ error: 'bad_token' });

  const base = process.env.CAM_TUNNEL_URL;
  const token = process.env.CAM_TOKEN;
  if (!base || !token) return res.status(503).json({ error: 'cameras_offline' }); // migração/PC desligado — V4 segue intacto

  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());          // funcionário fechou a página -> derruba o stream upstream

  let up;
  try {
    up = await fetch(`${base.replace(/\/$/, '')}/stream/${name}`, {
      headers: { 'X-Cam-Token': token },
      signal: ctrl.signal,
    });
  } catch {
    return res.status(503).json({ error: 'cameras_offline' });
  }
  if (!up.ok || !up.body) return res.status(503).json({ error: 'cameras_offline' });

  res.status(200);
  res.set('Content-Type', up.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=frame');
  res.set('Cache-Control', 'no-store');
  const body = Readable.fromWeb(up.body);
  body.on('error', () => { try { res.end(); } catch (_) {} });
  res.on('close', () => { try { ctrl.abort(); body.destroy(); } catch (_) {} });
  body.pipe(res);
});

// ---- página standalone (não toca o dashboard-v4) --------------------------
router.get('/cameras', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Câmeras — Produção</title>
<style>
  body{margin:0;background:#0d1117;color:#e6edf3;font:15px system-ui,sans-serif;}
  header{padding:14px 20px;font-weight:700;letter-spacing:.3px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:10px;}
  .grid{display:grid;gap:16px;padding:16px;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));max-width:1500px;margin:0 auto;}
  .card{background:#161b22;border:1px solid #21262d;border-radius:12px;overflow:hidden;}
  .card h2{margin:0;padding:10px 14px;font-size:14px;color:#9fb0c0;font-weight:600;}
  .card img{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#000;}
  .off{padding:28px;text-align:center;color:#8b949e;display:none;}
  #pin-overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:10;}
  #pin-overlay .box{background:#161b22;border:1px solid #30363d;padding:22px;border-radius:12px;min-width:270px;}
  #pin-overlay input{width:100%;box-sizing:border-box;padding:9px;margin:10px 0;border:1px solid #30363d;border-radius:8px;background:#0d1117;color:#e6edf3;font-size:15px;}
  #pin-overlay button{width:100%;padding:9px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;}
  #pin-err{color:#f85149;font-size:13px;min-height:16px;}
</style></head><body>
<header>🎥 Câmeras — Produção <span style="color:#8b949e;font-weight:400;font-size:13px">(ao vivo, somente visualização)</span></header>
<div id="pin-overlay"><div class="box"><strong>PIN das câmeras</strong>
  <input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="••••••" autofocus>
  <div id="pin-err"></div><button id="go">Entrar</button></div></div>
<div class="grid">
  <div class="card"><h2>🏭 Warehouse Floor</h2><img data-cam="warehouse" alt="Warehouse Floor"><div class="off">câmera offline</div></div>
  <div class="card"><h2>📦 Packaging Line</h2><img data-cam="packaging" alt="Packaging Line"><div class="off">câmera offline</div></div>
</div>
<script>
(function(){
  var K='hf_cam_tok', ov=document.getElementById('pin-overlay'),
      inp=document.getElementById('pin'), err=document.getElementById('pin-err');
  function tokenFresh(t){ // expiração é o prefixo do token — validável no client
    if(!t) return false; var exp=parseInt(String(t).split('.')[0],10);
    return isFinite(exp) && Date.now() < exp - 60000;
  }
  function load(tok){
    document.querySelectorAll('img[data-cam]').forEach(function(im){
      im.src='/api/cam/'+im.dataset.cam+'?t='+encodeURIComponent(tok)+'&r='+Date.now();
      // stream caiu (PC das câmeras off / blip do funnel): mostra offline mas NÃO
      // apaga o token — sessão continua válida; recarregar a página tenta de novo.
      im.onerror=function(){ im.style.display='none'; im.nextElementSibling.style.display='block'; };
      im.onload=function(){ im.style.display='block'; im.nextElementSibling.style.display='none'; };
    });
  }
  function tryPin(pin){
    fetch('/api/cam/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:pin})})
      .then(function(r){
        if(r.status===200){ return r.json().then(function(j){
          try{ localStorage.setItem(K, j.token); }catch(e){}
          ov.style.display='none'; load(j.token);
        }); }
        if(r.status===403){ err.textContent='PIN incorreto'; return; }
        if(r.status===429){ err.textContent='Muitas tentativas — aguarde um pouco'; return; }
        err.textContent='Câmeras offline no momento — tente mais tarde';
      }).catch(function(){ err.textContent='Sem conexão com o servidor'; });
  }
  document.getElementById('go').onclick=function(){ var p=inp.value.trim(); if(p) tryPin(p); };
  inp.addEventListener('keydown', function(e){ if(e.key==='Enter') document.getElementById('go').click(); });
  var saved=null; try{ saved=localStorage.getItem(K); }catch(e){}
  if(tokenFresh(saved)){ ov.style.display='none'; load(saved); }
  else { try{ localStorage.removeItem(K); }catch(e){} }
})();
</script></body></html>`);
});

module.exports = router;
