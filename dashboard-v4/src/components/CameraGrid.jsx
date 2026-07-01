/* Câmeras ao vivo (Warehouse + Packaging) — componente reusável (widget do Hoje
   + página Câmeras). Mesmo backend do /cameras standalone:
     POST /api/cam/session {pin} -> token HMAC 12h (PIN nunca em URL)
     GET  /api/cam/:name?t=      -> MJPEG proxied
     GET  /api/cam/health?t=     -> gateway alcançável? (reconexão automática)
   Recursos: auto-reconexão com backoff (gateway flapa), tamanho ajustável,
   fullscreen por câmera, PIP nativo (canvas -> captureStream -> video PIP). */
import React from 'react';

const CAMS = [
  { id: 'warehouse', label: '🏭 Warehouse Floor' },
  { id: 'packaging', label: '📦 Packaging Line' },
];
const TOK_KEY = 'hf_cam_tok';
const SIZE_KEY = 'hf_cam_size_dash';

const tokenFresh = (t) => {
  if (!t) return false;
  const exp = parseInt(String(t).split('.')[0], 10);
  return Number.isFinite(exp) && Date.now() < exp - 60000;
};

function CameraGrid({ compact = false }) {
  const [token, setToken] = React.useState(() => {
    try { const t = localStorage.getItem(TOK_KEY); return tokenFresh(t) ? t : null; } catch { return null; }
  });
  const [pin, setPin] = React.useState('');
  const [pinErr, setPinErr] = React.useState(null);
  const [size, setSize] = React.useState(() => {
    try { return parseInt(localStorage.getItem(SIZE_KEY), 10) || (compact ? 420 : 560); } catch { return compact ? 420 : 560; }
  });
  const [status, setStatus] = React.useState({});   // camId -> 'live' | 'retry' | 'off'
  const [gwUp, setGwUp] = React.useState(null);      // null=?, true, false
  const ref = React.useRef({});                       // camId -> { img, timer, backoff, pump, video, canvas, inPip }

  const setSt = (id, s) => setStatus((p) => ({ ...p, [id]: s }));

  const startStream = React.useCallback((id) => {
    const c = ref.current[id]; if (!c || !c.img || !token) return;
    clearTimeout(c.timer);
    setSt(id, 'retry');
    c.img.style.display = 'block';
    c.img.onerror = () => {
      c.img.style.display = 'none';
      setSt(id, 'off');
      c.timer = setTimeout(() => startStream(id), c.backoff || 2000);
      c.backoff = Math.min((c.backoff || 2000) * 1.8, 30000);
    };
    c.img.onload = () => { setSt(id, 'live'); c.backoff = 2000; };
    c.img.src = '/api/cam/' + id + '?t=' + encodeURIComponent(token) + '&r=' + Date.now();
  }, [token]);

  // inicia/limpa streams
  React.useEffect(() => {
    if (!token) return undefined;
    CAMS.forEach((c) => startStream(c.id));
    const cur = ref.current;
    const all = allRef.current;
    return () => {
      Object.values(cur).forEach((c) => {
        if (!c) return;
        clearTimeout(c.timer); clearInterval(c.pump);
        if (c.img) { c.img.onerror = null; c.img.onload = null; c.img.src = ''; } // fecha o stream
        if (c.video && document.pictureInPictureElement === c.video) document.exitPictureInPicture().catch(() => {});
      });
      clearInterval(all.pump);
      if (all.video && document.pictureInPictureElement === all.video) document.exitPictureInPicture().catch(() => {});
    };
  }, [token, startStream]);

  // health poll — reconecta na hora quando o gateway volta
  React.useEffect(() => {
    if (!token) return undefined;
    const t = setInterval(() => {
      fetch('/api/cam/health?t=' + encodeURIComponent(token)).then((r) => r.json()).then((j) => {
        setGwUp(!!j.reachable);
        if (j.reachable) {
          CAMS.forEach((c) => {
            const st = ref.current[c.id];
            if (st && st.img && st.img.style.display === 'none') { st.backoff = 2000; startStream(c.id); }
          });
        }
      }).catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, [token, startStream]);

  const doPin = async (e) => {
    e.preventDefault(); setPinErr(null);
    try {
      const r = await fetch('/api/cam/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
      if (r.status === 200) {
        const j = await r.json();
        try { localStorage.setItem(TOK_KEY, j.token); } catch {}
        setToken(j.token); setPin('');
      } else if (r.status === 403) setPinErr('PIN incorreto');
      else if (r.status === 429) setPinErr('Muitas tentativas — aguarde um pouco');
      else setPinErr('Câmeras offline no momento');
    } catch { setPinErr('Sem conexão com o servidor'); }
  };

  const goFullscreen = (id) => {
    const c = ref.current[id];
    const el = c && c.wrap;
    if (el) (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
  };

  const togglePip = async (id) => {
    const c = ref.current[id]; if (!c || !c.img) return;
    if (!document.pictureInPictureEnabled) { alert('Este navegador não suporta Picture-in-Picture. Use Chrome/Edge.'); return; }
    if (c.inPip && c.video) { document.exitPictureInPicture().catch(() => {}); return; }
    if (!c.canvas) {
      c.canvas = document.createElement('canvas');
      c.video = document.createElement('video');
      c.video.muted = true; c.video.playsInline = true; c.video.style.display = 'none';
      document.body.appendChild(c.video);
    }
    const w = c.img.naturalWidth || 1280, h = c.img.naturalHeight || 720;
    c.canvas.width = w; c.canvas.height = h;
    const ctx = c.canvas.getContext('2d');
    clearInterval(c.pump);
    c.pump = setInterval(() => { try { if (c.img.complete && c.img.naturalWidth) ctx.drawImage(c.img, 0, 0, w, h); } catch {} }, 66);
    if (!c.video.srcObject) c.video.srcObject = c.canvas.captureStream(15);
    try {
      await c.video.play();
      await c.video.requestPictureInPicture();
      c.inPip = true;
      const onleave = () => { c.inPip = false; clearInterval(c.pump); c.pump = null; c.video.removeEventListener('leavepictureinpicture', onleave); };
      c.video.addEventListener('leavepictureinpicture', onleave);
    } catch (e2) { clearInterval(c.pump); c.pump = null; alert('PIP falhou: ' + e2.message); }
  };

  // MULTI-PIP (Bruno 07-01): o navegador só permite UMA janela PIP por vez —
  // então compomos TODAS as câmeras lado a lado num canvas e mandamos o conjunto.
  const allRef = React.useRef({});
  const togglePipAll = async () => {
    const all = allRef.current;
    if (!document.pictureInPictureEnabled) { alert('Este navegador não suporta Picture-in-Picture. Use Chrome/Edge.'); return; }
    if (all.inPip && all.video) { document.exitPictureInPicture().catch(() => {}); return; }
    if (!all.canvas) {
      all.canvas = document.createElement('canvas');
      all.video = document.createElement('video');
      all.video.muted = true; all.video.playsInline = true; all.video.style.display = 'none';
      document.body.appendChild(all.video);
    }
    const cw = 1280, ch = 720;
    all.canvas.width = cw * CAMS.length; all.canvas.height = ch;
    const ctx = all.canvas.getContext('2d');
    clearInterval(all.pump);
    all.pump = setInterval(() => {
      CAMS.forEach((cam, ix) => {
        const im = ref.current[cam.id] && ref.current[cam.id].img;
        try {
          ctx.fillStyle = '#000'; ctx.fillRect(ix * cw, 0, cw, ch);
          if (im && im.complete && im.naturalWidth) {
            const s = Math.min(cw / im.naturalWidth, ch / im.naturalHeight);
            const w = im.naturalWidth * s, h = im.naturalHeight * s;
            ctx.drawImage(im, ix * cw + (cw - w) / 2, (ch - h) / 2, w, h);
          } else {
            ctx.fillStyle = '#8b949e'; ctx.font = '26px system-ui'; ctx.fillText('câmera offline — reconectando…', ix * cw + 40, ch / 2);
          }
          ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(ix * cw, 0, 250, 34);
          ctx.fillStyle = '#fff'; ctx.font = 'bold 19px system-ui'; ctx.fillText(cam.label.replace(/^\S+\s/, ''), ix * cw + 12, 24);
          if (ix > 0) { ctx.fillStyle = '#0d1117'; ctx.fillRect(ix * cw - 2, 0, 4, ch); }
        } catch {}
      });
    }, 66);
    if (!all.video.srcObject) all.video.srcObject = all.canvas.captureStream(15);
    try {
      await all.video.play();
      await all.video.requestPictureInPicture();
      all.inPip = true;
      const onleave = () => { all.inPip = false; clearInterval(all.pump); all.pump = null; all.video.removeEventListener('leavepictureinpicture', onleave); };
      all.video.addEventListener('leavepictureinpicture', onleave);
    } catch (e2) { clearInterval(all.pump); all.pump = null; alert('PIP falhou: ' + e2.message); }
  };

  const onSize = (v) => { setSize(v); try { localStorage.setItem(SIZE_KEY, String(v)); } catch {} };

  if (!token) {
    return (
      <form onSubmit={doPin} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>🎥 PIN das câmeras:</span>
        <input className="input" type="password" inputMode="numeric" autoComplete="off" placeholder="••••••"
               value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: 120 }}/>
        <button className="btn sm primary" type="submit" disabled={!pin.trim()}>Entrar</button>
        {pinErr && <span style={{ color: 'var(--bad)', fontSize: 12 }}>{pinErr}</span>}
      </form>
    );
  }

  const badge = (id) => {
    const s = status[id];
    const map = {
      live:  { txt: 'ao vivo', bg: 'rgba(34,179,93,0.14)', fg: 'var(--hf-leaf-600)' },
      retry: { txt: 'conectando…', bg: 'rgba(217,119,6,0.14)', fg: '#b45309' },
      off:   { txt: 'offline · re-tentando', bg: 'rgba(220,38,38,0.12)', fg: '#dc2626' },
    };
    const m = map[s] || { txt: '—', bg: 'var(--surface-2)', fg: 'var(--text-3)' };
    return <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 999, background: m.bg, color: m.fg, flex: 'none', fontWeight: 700 }}>{m.txt}</span>;
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <span title={gwUp == null ? 'gateway: verificando' : gwUp ? 'gateway das câmeras no ar' : 'gateway fora do ar (PC das câmeras/túnel)'}
              style={{ width: 9, height: 9, borderRadius: '50%', flex: 'none',
                       background: gwUp == null ? 'var(--text-3)' : gwUp ? 'var(--hf-leaf-500)' : 'var(--bad)' }}/>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>ao vivo · somente visualização</span>
        <span style={{ flex: 1 }}/>
        <button className="btn sm ghost" onClick={togglePipAll}
                title="Uma janela PIP flutuante com TODAS as câmeras lado a lado (o navegador só permite 1 janela PIP por vez)">⧉ PIP tudo</button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-3)' }}>
          tamanho <input type="range" min={300} max={1200} step={20} value={size} onChange={(e) => onSize(+e.target.value)} style={{ width: 120, accentColor: 'var(--hf-navy-500)' }}/>
        </label>
        <a className="btn sm ghost" href="/cameras" target="_blank" rel="noreferrer" title="Página standalone (pra TV/2º monitor)">abrir solto ↗</a>
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: `repeat(auto-fit, minmax(min(${size}px, 100%), 1fr))` }}>
        {CAMS.map((cam) => (
          <div key={cam.id} className="card" style={{ overflow: 'hidden', padding: 0 }}
               ref={(el) => { ref.current[cam.id] = ref.current[cam.id] || {}; ref.current[cam.id].wrap = el; }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
              <b style={{ fontSize: 12.5, flex: 1 }}>{cam.label}</b>
              {badge(cam.id)}
              <button className="btn sm ghost" onClick={() => togglePip(cam.id)} title="Picture-in-Picture (janela flutuante)">⧉ PIP</button>
              <button className="btn sm ghost" onClick={() => goFullscreen(cam.id)} title="Tela cheia">⛶</button>
            </div>
            <img alt={cam.label}
                 ref={(el) => { ref.current[cam.id] = ref.current[cam.id] || {}; ref.current[cam.id].img = el; }}
                 style={{ display: 'block', width: '100%', aspectRatio: '16/9', objectFit: 'contain', background: '#000' }}/>
            {status[cam.id] === 'off' && (
              <div style={{ padding: 18, textAlign: 'center', color: 'var(--text-3)', fontSize: 12.5 }}>
                câmera offline — reconectando sozinho…
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

window.CameraGrid = CameraGrid;
export { CameraGrid };
