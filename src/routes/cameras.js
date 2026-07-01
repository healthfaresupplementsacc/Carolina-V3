'use strict';
/**
 * Câmeras (view-only) — Warehouse Floor + Packaging Line.
 *
 * Proxy PIN-gated para o gateway de câmeras (PC das câmeras, via Tailscale
 * Funnel). O browser do funcionário NUNCA vê a URL do gateway nem o token —
 * ambos ficam só em env vars do Railway. Sem o PIN, as imagens não carregam.
 *
 *   GET /cameras                  -> página standalone (pede o PIN 1x, mostra as 2 câmeras)
 *   GET /api/cam/:name?k=<PIN>    -> MJPEG proxied (name: warehouse | packaging)
 *
 * Env (Railway):
 *   CAM_TUNNEL_URL  ex.: https://<maquina>.ts.net/embed   (muda quando o PC das câmeras migrar — só troca a env)
 *   CAM_TOKEN       segredo compartilhado com o gateway (fica no servidor)
 *   CAM_VIEW_PIN    PIN que o funcionário digita 1x na página
 *
 * PORTABILIDADE: se as envs faltarem ou o PC das câmeras estiver offline
 * (ex.: durante a migração pra outra máquina), a rota responde 503 e o resto
 * do V4 segue 100% intacto — nada aqui é dependência do dashboard.
 */

const express = require('express');
const crypto = require('crypto');
const { Readable } = require('stream');
const { makeRateLimit } = require('../middleware/security');

const router = express.Router();

const CAMS = new Set(['warehouse', 'packaging']);
const LABELS = { warehouse: 'Warehouse Floor', packaging: 'Packaging Line' };

// 60 req/min por IP — segura brute-force de PIN sem atrapalhar o uso normal
// (o stream MJPEG é 1 request longa, não N requests).
router.use('/api/cam', makeRateLimit({ limit: 60, windowMs: 60 * 1000 }));

function pinOk(k) {
  const pin = process.env.CAM_VIEW_PIN || '';
  if (!pin || !k) return false;
  const a = crypto.createHash('sha256').update(String(k)).digest();
  const b = crypto.createHash('sha256').update(pin).digest();
  return crypto.timingSafeEqual(a, b);
}

router.get('/api/cam/:name', async (req, res) => {
  const { name } = req.params;
  if (!CAMS.has(name)) return res.status(404).json({ error: 'unknown_camera' });
  if (!pinOk(req.query.k)) return res.status(403).json({ error: 'bad_pin' });

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
  var K='hf_cam_pin', ov=document.getElementById('pin-overlay'),
      inp=document.getElementById('pin'), err=document.getElementById('pin-err');
  function load(pin){
    document.querySelectorAll('img[data-cam]').forEach(function(im){
      im.src='/api/cam/'+im.dataset.cam+'?k='+encodeURIComponent(pin)+'&t='+Date.now();
      im.onerror=function(){ im.style.display='none'; im.nextElementSibling.style.display='block';
        try{localStorage.removeItem(K);}catch(e){} };
      im.onload=function(){ im.style.display='block'; im.nextElementSibling.style.display='none'; };
    });
  }
  function tryPin(pin, remember){
    fetch('/api/cam/warehouse?k='+encodeURIComponent(pin), {method:'GET', headers:{Range:'bytes=0-0'}})
      .then(function(r){
        if(r.status===403){ err.textContent='PIN incorreto'; return; }
        try{ r.body && r.body.cancel && r.body.cancel(); }catch(e){}
        if(remember){ try{ localStorage.setItem(K, pin); }catch(e){} }
        ov.style.display='none'; load(pin);
      }).catch(function(){ err.textContent='Sem conexão com o servidor'; });
  }
  document.getElementById('go').onclick=function(){ var p=inp.value.trim(); if(p) tryPin(p, true); };
  inp.addEventListener('keydown', function(e){ if(e.key==='Enter') document.getElementById('go').click(); });
  var saved=null; try{ saved=localStorage.getItem(K); }catch(e){}
  if(saved) tryPin(saved, false);
})();
</script></body></html>`);
});

module.exports = router;
