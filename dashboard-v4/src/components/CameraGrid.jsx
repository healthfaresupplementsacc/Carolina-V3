/* Câmeras ao vivo (Warehouse + Packaging) — widget do Hoje + página Câmeras.
   v3 (07-01): player H.264 fMP4 FULL HD (1920×1080 ~6.2Mbps) via
   GET /api/cam/:name/mp4 — 15× mais eficiente que MJPEG. Fallback automático
   pra MJPEG (<img>) se o mp4 falhar 3× (gateway antigo/transição).
   Mantém: auto-reconexão com backoff, tamanho ajustável, fullscreen,
   PIP nativo (no mp4 é DIRETO no <video> — sem canvas pump) e ⧉ PIP tudo. */
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
  const [mode, setMode] = React.useState({});        // camId -> 'mp4' | 'mjpeg'
  const [gwUp, setGwUp] = React.useState(null);
  const ref = React.useRef({});                       // camId -> { video, img, wrap, timer, stallTimer, backoff, mp4Fails, pump, canvas, pipVideo, inPip }

  const st = (id) => { ref.current[id] = ref.current[id] || { backoff: 2000, mp4Fails: 0 }; return ref.current[id]; };
  const setSt = (id, s) => setStatus((p) => (p[id] === s ? p : { ...p, [id]: s }));
  const camMode = (id) => mode[id] || 'mp4';

  const startStream = React.useCallback((id) => {
    const c = st(id); if (!token) return;
    clearTimeout(c.timer); clearTimeout(c.stallTimer);
    setSt(id, 'retry');
    const m = camMode(id);
    if (m === 'mp4' && c.video) {
      const v = c.video;
      v.onerror = null; v.onplaying = null;
      v.src = '/api/cam/' + id + '/mp4?t=' + encodeURIComponent(token) + '&r=' + Date.now();
      const fail = () => {
        c.mp4Fails = (c.mp4Fails || 0) + 1;
        setSt(id, 'off');
        if (c.mp4Fails >= 3) { setMode((p) => ({ ...p, [id]: 'mjpeg' })); return; } // fallback MJPEG
        c.timer = setTimeout(() => startStream(id), c.backoff || 2000);
        c.backoff = Math.min((c.backoff || 2000) * 1.8, 30000);
      };
      v.onerror = fail;
      v.onended = fail;
      v.onplaying = () => { setSt(id, 'live'); c.backoff = 2000; c.mp4Fails = 0; };
      // stall watchdog: 'waiting' que não volta a 'playing' em 12s → reconecta
      v.onwaiting = () => {
        clearTimeout(c.stallTimer);
        c.stallTimer = setTimeout(() => { if (v.readyState < 3) fail(); }, 12000);
      };
      v.play().catch(() => {});
    } else if (c.img) {
      const im = c.img;
      im.style.display = 'block';
      im.onerror = () => {
        im.style.display = 'none';
        setSt(id, 'off');
        c.timer = setTimeout(() => startStream(id), c.backoff || 2000);
        c.backoff = Math.min((c.backoff || 2000) * 1.8, 30000);
      };
      im.onload = () => { setSt(id, 'live'); c.backoff = 2000; };
      im.src = '/api/cam/' + id + '?t=' + encodeURIComponent(token) + '&r=' + Date.now();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, mode]);

  // inicia/limpa streams (re-roda quando o mode de alguma cam muda p/ fallback)
  React.useEffect(() => {
    if (!token) return undefined;
    CAMS.forEach((c) => startStream(c.id));
    const cur = ref.current;
    return () => {
      Object.values(cur).forEach((c) => {
        if (!c) return;
        clearTimeout(c.timer); clearTimeout(c.stallTimer); clearInterval(c.pump);
        if (c.video) { c.video.onerror = null; c.video.onplaying = null; c.video.onwaiting = null; c.video.onended = null; c.video.removeAttribute('src'); try { c.video.load(); } catch {} }
        if (c.img) { c.img.onerror = null; c.img.onload = null; c.img.src = ''; }
        if (document.pictureInPictureElement && (document.pictureInPictureElement === c.video || document.pictureInPictureElement === c.pipVideo)) {
          document.exitPictureInPicture().catch(() => {});
        }
      });
      const all = allRef.current;
      clearInterval(all.pump);
      if (all.video && document.pictureInPictureElement === all.video) document.exitPictureInPicture().catch(() => {});
      // docPIP: fecha a janela ao desmontar (+ janelinhas auxiliares)
      const doc = docRef.current;
      try { if (doc.win && !doc.win.closed) doc.win.close(); } catch {}
      docRef.current = {};
      Object.values(helpersRef.current).forEach((w) => { try { if (w && !w.closed) w.close(); } catch {} });
      helpersRef.current = {};
    };
  }, [token, mode, startStream]);

  // health poll — reconecta na hora quando o gateway volta
  React.useEffect(() => {
    if (!token) return undefined;
    const t = setInterval(() => {
      fetch('/api/cam/health?t=' + encodeURIComponent(token)).then((r) => r.json()).then((j) => {
        setGwUp(!!j.reachable);
        if (j.reachable) {
          CAMS.forEach((cam) => {
            if ((statusRef.current[cam.id] || '') === 'off') { st(cam.id).backoff = 2000; startStream(cam.id); }
          });
        }
      }).catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, [token, startStream]);
  const statusRef = React.useRef({});
  React.useEffect(() => { statusRef.current = status; }, [status]);

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
    const el = st(id).wrap;
    if (el) (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
  };

  // ── PIP cross-browser: Chrome/Edge usam requestPictureInPicture; o iPhone
  // (Safari/WebKit) usa webkitSetPresentationMode — sem isso o PIP "não funciona
  // no iPhone" (Bruno 07-02). enterPip/exitPip/inPipNow abstraem os dois.
  const pipCapable = (v) => !!(document.pictureInPictureEnabled
    || (v && v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture')));
  // PIP exige metadata carregada ("Metadata for the video element are not loaded
  // yet"): se o stream ainda está conectando, dá um play() e espera o
  // loadedmetadata por até 4s (dentro da janela de ativação do clique).
  const waitMeta = (v, ms = 4000) => new Promise((resolve, reject) => {
    if (v.readyState >= 1) { resolve(); return; }
    let t = null;
    const on = () => { cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(t); v.removeEventListener('loadedmetadata', on); };
    t = setTimeout(() => { cleanup(); reject(new Error('A câmera ainda está conectando — espere o vídeo aparecer no card e tente de novo.')); }, ms);
    v.addEventListener('loadedmetadata', on);
    try { if (v.play) v.play().catch(() => {}); } catch {}
  });
  const enterPip = async (v) => {
    if (document.pictureInPictureEnabled && v.requestPictureInPicture) { await waitMeta(v); await v.requestPictureInPicture(); return; }
    if (v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture')) { await waitMeta(v); v.webkitSetPresentationMode('picture-in-picture'); return; }
    throw new Error('Este navegador não suporta Picture-in-Picture.');
  };
  const inPipNow = (v) => !!(v && (document.pictureInPictureElement === v || v.webkitPresentationMode === 'picture-in-picture'));
  const exitPip = (v) => {
    if (v && v.webkitPresentationMode === 'picture-in-picture') { try { v.webkitSetPresentationMode('inline'); } catch {} return; }
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  };

  // PIP por câmera: no mp4 é DIRETO no <video>; no mjpeg usa canvas pump.
  // openPip = SÓ abre (usado pelo toggle e pelo PIP duplo).
  const openPip = async (id) => {
    const c = st(id);
    if (camMode(id) === 'mp4' && c.video) { await enterPip(c.video); return; }
    // fallback MJPEG → canvas pump
    if (!c.canvas) {
      c.canvas = document.createElement('canvas');
      c.pipVideo = document.createElement('video');
      c.pipVideo.muted = true; c.pipVideo.playsInline = true; c.pipVideo.style.cssText = 'position:fixed;bottom:0;right:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
      document.body.appendChild(c.pipVideo);
    }
    const im = c.img;
    const w = (im && im.naturalWidth) || 1280, h = (im && im.naturalHeight) || 720;
    c.canvas.width = w; c.canvas.height = h;
    const ctx = c.canvas.getContext('2d');
    clearInterval(c.pump);
    c.pump = setInterval(() => { try { if (im && im.complete && im.naturalWidth) ctx.drawImage(im, 0, 0, w, h); } catch {} }, 66);
    if (!c.pipVideo.srcObject) c.pipVideo.srcObject = c.canvas.captureStream(15);
    try {
      await c.pipVideo.play();
      await enterPip(c.pipVideo);
      c.inPip = true;
      const onleave = () => { c.inPip = false; clearInterval(c.pump); c.pump = null; c.pipVideo.removeEventListener('leavepictureinpicture', onleave); };
      c.pipVideo.addEventListener('leavepictureinpicture', onleave);
      c.pipVideo.addEventListener('webkitpresentationmodechanged', function wk() { if (c.pipVideo.webkitPresentationMode !== 'picture-in-picture') { onleave(); c.pipVideo.removeEventListener('webkitpresentationmodechanged', wk); } });
    } catch (e2) { clearInterval(c.pump); c.pump = null; throw e2; }
  };
  const togglePip = async (id) => {
    // Chrome/Edge: janela Document PIP (tamanho controlado — sempre visível)
    if (hasDocPip()) {
      // 2 JANELAS AO MESMO TEMPO (Bruno 07-02): o Chrome só permite 1 docPIP por
      // aba → se JÁ tem outra câmera fixada nesta aba, a 2ª abre via janelinha
      // auxiliar (/cameras/pip), que tem direito ao PRÓPRIO docPIP. 1 clique lá
      // ("Fixar por cima") e as DUAS ficam flutuando juntas.
      const h = helpersRef.current[id];
      if (h && !h.closed) { try { h.close(); } catch {} delete helpersRef.current[id]; return; } // toggle off da auxiliar
      const cur = docRef.current;
      if (cur.win && !cur.win.closed && cur.key && cur.key !== 'cam:' + id) {
        const w = window.open('/cameras/pip?cam=' + encodeURIComponent(id) + '#t=' + encodeURIComponent(token),
          'hf_pip_' + id, 'width=520,height=340,left=60,top=60,popup=1');
        if (!w) { alert('O navegador bloqueou a janelinha — permita popups pra este site.'); return; }
        helpersRef.current[id] = w;
        return;
      }
      try { await toggleDocPip('cam:' + id, CAMS.filter((c) => c.id === id)); }
      catch (e2) { alert('PIP falhou: ' + e2.message); }
      return;
    }
    const c = st(id);
    if (!pipCapable(c.video || c.pipVideo)) { alert('Este navegador não suporta Picture-in-Picture. Use Chrome/Edge (ou Safari no iPhone).'); return; }
    if (camMode(id) === 'mp4' && c.video && inPipNow(c.video)) { exitPip(c.video); return; }
    if (c.inPip && c.pipVideo) { exitPip(c.pipVideo); return; }
    try { await openPip(id); } catch (e2) { alert('PIP falhou: ' + e2.message); }
  };

  // ── Document PIP (Bruno 07-02 #9): o PIP de vídeo nativo ficou INVISÍVEL na
  // máquina do Bruno (Chrome memorizou tamanho/posição degenerados da janela —
  // vídeo preto + ícone na aba, janela nunca aparece; não há API pra corrigir).
  // Document PIP deixa a GENTE definir o tamanho a cada abertura → janela sempre
  // visível, sempre por cima. Os botões usam docPIP quando disponível; senão
  // caem no PIP de vídeo antigo (iPhone continua no WebKit).
  const docRef = React.useRef({}); // { win, key }
  const helpersRef = React.useRef({}); // camId -> janela auxiliar (/cameras/pip)
  const hasDocPip = () => !!(window.documentPictureInPicture && window.documentPictureInPicture.requestWindow);
  const fillCamsWindow = (w, cams, tok) => {
    const d = w.document;
    try { d.title = cams.map((c) => c.label).join(' + '); } catch {}
    d.body.style.cssText = 'margin:0;background:#000;height:100vh;overflow:hidden;display:flex;';
    const base = window.location.origin;
    cams.forEach((cam) => {
      const m = camMode(cam.id);
      const cell = d.createElement('div');
      cell.style.cssText = 'position:relative;flex:1;min-width:0;height:100%;';
      const chip = d.createElement('div');
      chip.textContent = cam.label;
      chip.style.cssText = 'position:absolute;top:6px;left:8px;z-index:2;background:rgba(0,0,0,.55);color:#fff;font:bold 12px system-ui;padding:3px 8px;border-radius:6px;';
      cell.appendChild(chip);
      const src = () => base + (m === 'mp4' ? '/api/cam/' + cam.id + '/mp4?t=' : '/api/cam/' + cam.id + '?t=') + encodeURIComponent(tok) + '&r=' + Date.now();
      let el;
      if (m === 'mp4') { el = d.createElement('video'); el.muted = true; el.autoplay = true; el.playsInline = true; }
      else el = d.createElement('img');
      el.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#000;';
      let retry = null;
      const reconnect = () => { clearTimeout(retry); retry = setTimeout(() => { el.src = src(); if (el.play) el.play().catch(() => {}); }, 2500); };
      el.onerror = reconnect;
      if (m === 'mp4') el.onended = reconnect;
      el.src = src();
      cell.appendChild(el);
      d.body.appendChild(cell);
      if (el.play) el.play().catch(() => {});
      w.addEventListener('pagehide', () => clearTimeout(retry));
    });
  };
  // abre/troca/fecha a janela docPIP: mesmo key → fecha (toggle); key diferente
  // → fecha a atual e abre a nova (troca de câmera num clique).
  const toggleDocPip = async (key, cams) => {
    const cur = docRef.current;
    if (cur.win && !cur.win.closed) {
      const same = cur.key === key;
      try { cur.win.close(); } catch {}
      cur.win = null; cur.key = null;
      if (same) return; // toggle off
    }
    const w = await window.documentPictureInPicture.requestWindow({ width: cams.length > 1 ? 880 : 480, height: 300 });
    fillCamsWindow(w, cams, token);
    docRef.current = { win: w, key };
    w.addEventListener('pagehide', () => { if (docRef.current.win === w) docRef.current = {}; });
  };

  // MULTI-PIP: navegador permite 1 janela PIP → compõe TODAS num canvas
  // (drawImage aceita <video> e <img>; funciona nos 2 modes).
  const allRef = React.useRef({});
  const togglePipAll = async () => {
    // Chrome/Edge: janela Document PIP com as 2 câmeras lado a lado
    if (hasDocPip()) {
      try { await toggleDocPip('all', CAMS); }
      catch (e2) { alert('PIP falhou: ' + e2.message); }
      return;
    }
    const all = allRef.current;
    if (!pipCapable(all.video || st(CAMS[0].id).video)) { alert('Este navegador não suporta Picture-in-Picture. Use Chrome/Edge (ou Safari no iPhone).'); return; }
    if (all.inPip && all.video) { exitPip(all.video); return; }
    if (!all.canvas) {
      all.canvas = document.createElement('canvas');
      all.video = document.createElement('video');
      all.video.muted = true; all.video.playsInline = true; all.video.style.cssText = 'position:fixed;bottom:0;right:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
      document.body.appendChild(all.video);
    }
    const cw = 1280, ch = 720;
    all.canvas.width = cw * CAMS.length; all.canvas.height = ch;
    const ctx = all.canvas.getContext('2d');
    clearInterval(all.pump);
    all.pump = setInterval(() => {
      CAMS.forEach((cam, ix) => {
        const c = ref.current[cam.id] || {};
        const el = (camMode(cam.id) === 'mp4' && c.video && c.video.readyState >= 2) ? c.video
          : (c.img && c.img.complete && c.img.naturalWidth) ? c.img : null;
        try {
          ctx.fillStyle = '#000'; ctx.fillRect(ix * cw, 0, cw, ch);
          if (el) {
            const sw = el.videoWidth || el.naturalWidth, sh = el.videoHeight || el.naturalHeight;
            const s = Math.min(cw / sw, ch / sh), w = sw * s, h = sh * s;
            ctx.drawImage(el, ix * cw + (cw - w) / 2, (ch - h) / 2, w, h);
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
      await enterPip(all.video);
      all.inPip = true;
      const onleave = () => { all.inPip = false; clearInterval(all.pump); all.pump = null; all.video.removeEventListener('leavepictureinpicture', onleave); };
      all.video.addEventListener('leavepictureinpicture', onleave);
      all.video.addEventListener('webkitpresentationmodechanged', function wk() { if (all.video.webkitPresentationMode !== 'picture-in-picture') { onleave(); all.video.removeEventListener('webkitpresentationmodechanged', wk); } });
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
      live:  { txt: camMode(id) === 'mp4' ? 'ao vivo · HD' : 'ao vivo', bg: 'rgba(34,179,93,0.14)', fg: 'var(--hf-leaf-600)' },
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
        {CAMS.map((cam) => (
          <button key={cam.id} className="btn sm ghost" onClick={() => togglePip(cam.id)}
                  title={'Janela PIP flutuante só da ' + cam.label + ' (o navegador permite 1 PIP por vez — clicar na outra troca na hora)'}>
            ⧉ PIP {cam.label.replace(/^\S+\s/, '')}
          </button>
        ))}
        <button className="btn sm ghost" onClick={togglePipAll}
                title="As DUAS câmeras lado a lado numa janela PIP flutuante (único jeito de ver as 2 juntas — o navegador não permite 2 janelas PIP)">⧉ PIP tudo</button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-3)' }}>
          tamanho <input type="range" min={300} max={1200} step={20} value={size} onChange={(e) => onSize(+e.target.value)} style={{ width: 120, accentColor: 'var(--hf-navy-500)' }}/>
        </label>
        <a className="btn sm ghost" href="/cameras" target="_blank" rel="noreferrer" title="Página standalone (pra TV/2º monitor)">abrir solto ↗</a>
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: `repeat(auto-fit, minmax(min(${size}px, 100%), 1fr))` }}>
        {CAMS.map((cam) => (
          <div key={cam.id} className="card" style={{ overflow: 'hidden', padding: 0 }}
               ref={(el) => { st(cam.id).wrap = el; }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
              <b style={{ fontSize: 12.5, flex: 1 }}>{cam.label}</b>
              {badge(cam.id)}
              <button className="btn sm ghost" onClick={() => togglePip(cam.id)} title="Picture-in-Picture (janela flutuante)">⧉ PIP</button>
              <button className="btn sm ghost" onClick={() => goFullscreen(cam.id)} title="Tela cheia">⛶</button>
            </div>
            {camMode(cam.id) === 'mp4' ? (
              <video muted autoPlay playsInline
                     ref={(el) => { st(cam.id).video = el; }}
                     style={{ display: 'block', width: '100%', aspectRatio: '16/9', objectFit: 'contain', background: '#000' }}/>
            ) : (
              <img alt={cam.label}
                   ref={(el) => { st(cam.id).img = el; }}
                   style={{ display: 'block', width: '100%', aspectRatio: '16/9', objectFit: 'contain', background: '#000' }}/>
            )}
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
