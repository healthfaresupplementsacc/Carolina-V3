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
  { id: 'formulation', label: '🧪 Formulation Cam 1' }, // cam6_hd — gateway precisa expor /mp4/formulation
];
const TOK_KEY = 'hf_cam_tok';
const ORDER_KEY = 'hf_cam_order_dash';   // ordem dos tiles (drag-to-reorder)
const WIDTHS_KEY = 'hf_cam_widths_dash'; // largura por câmera (resize por tile)
const VIS_KEY = 'hf_cam_visible_dash';       // câmera on/off (mostrar/ocultar)
const COLLAPSE_KEY = 'hf_cam_collapsed_dash'; // câmera minimizada (só o header)
const HEIGHTS_KEY = 'hf_cam_heights_dash';   // altura por câmera (resize livre)
const PAN_KEY = 'hf_cam_pan_dash';           // pan da imagem por câmera (object-position %)

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
  const defW = compact ? 420 : 560;
  // B (07-08): ordem dos tiles (drag-to-reorder) + largura por câmera (resize por tile), persistidos.
  const [order, setOrder] = React.useState(() => {
    const ids = CAMS.map((c) => c.id);
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); } catch {}
    const valid = (Array.isArray(saved) ? saved : []).filter((id) => ids.includes(id));
    return [...valid, ...ids.filter((id) => !valid.includes(id))]; // câmeras novas entram no fim
  });
  const [widths, setWidths] = React.useState(() => {
    try { const w = JSON.parse(localStorage.getItem(WIDTHS_KEY) || '{}'); return (w && typeof w === 'object') ? w : {}; } catch { return {}; }
  });
  const dragId = React.useRef(null);
  const [visible, setVisible] = React.useState(() => { try { const v = JSON.parse(localStorage.getItem(VIS_KEY) || '{}'); return (v && typeof v === 'object') ? v : {}; } catch { return {}; } });
  const [collapsed, setCollapsed] = React.useState(() => { try { const v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}'); return (v && typeof v === 'object') ? v : {}; } catch { return {}; } });
  const [heights, setHeights] = React.useState(() => { try { const v = JSON.parse(localStorage.getItem(HEIGHTS_KEY) || '{}'); return (v && typeof v === 'object') ? v : {}; } catch { return {}; } });
  const [pan, setPan] = React.useState(() => { try { const v = JSON.parse(localStorage.getItem(PAN_KEY) || '{}'); return (v && typeof v === 'object') ? v : {}; } catch { return {}; } });
  const [status, setStatus] = React.useState({});   // camId -> 'live' | 'retry' | 'off'
  const [mode, setMode] = React.useState({});        // camId -> 'mp4' | 'mjpeg'
  const [gwUp, setGwUp] = React.useState(null);
  const ref = React.useRef({});                       // camId -> { video, img, wrap, timer, stallTimer, backoff, mp4Fails, pump, canvas, pipVideo, inPip }

  const st = (id) => { ref.current[id] = ref.current[id] || { backoff: 2000, mp4Fails: 0 }; return ref.current[id]; };
  const setSt = (id, s) => setStatus((p) => (p[id] === s ? p : { ...p, [id]: s }));
  const camMode = (id) => mode[id] || 'mp4';

  const startStream = React.useCallback((id) => {
    const c = st(id); if (!token) return;
    clearTimeout(c.timer); clearTimeout(c.stallTimer); clearTimeout(c.firstFrameTimer);
    setSt(id, 'retry');
    const m = camMode(id);
    if (m === 'mp4' && c.video) {
      const v = c.video;
      v.onerror = null; v.onplaying = null;
      v.src = '/api/cam/' + id + '/mp4?t=' + encodeURIComponent(token) + '&r=' + Date.now();
      const fail = () => {
        clearTimeout(c.stallTimer); clearTimeout(c.firstFrameTimer);
        c.mp4Fails = (c.mp4Fails || 0) + 1;
        setSt(id, 'off');
        // TELA PRETA / mp4 problemático (GOP longo da warehouse) → cai RÁPIDO pro
        // MJPEG, que tem reconexão transparente no servidor (robusto). Bruno 07-08.
        if (c.mp4Fails >= 2) { setMode((p) => ({ ...p, [id]: 'mjpeg' })); return; }
        c.timer = setTimeout(() => startStream(id), c.backoff || 2000);
        c.backoff = Math.min((c.backoff || 2000) * 1.8, 30000);
      };
      v.onerror = fail;
      v.onended = fail;
      v.onplaying = () => { setSt(id, 'live'); c.backoff = 2000; c.mp4Fails = 0; clearTimeout(c.firstFrameTimer); };
      // WATCHDOG do 1º frame: mp4 que conecta mas NÃO decodifica (fica preto até o
      // keyframe — GOP longo) não dispara onerror/onwaiting; se em 7s não tiver
      // começado a tocar, força o fail → MJPEG. Bruno 07-08.
      c.firstFrameTimer = setTimeout(() => { if (v.readyState < 3 || !(v.currentTime > 0)) fail(); }, 7000);
      // stall watchdog: 'waiting' que não volta a 'playing' em 7s → reconecta
      v.onwaiting = () => {
        clearTimeout(c.stallTimer);
        c.stallTimer = setTimeout(() => { if (v.readyState < 3) fail(); }, 7000);
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
        clearTimeout(c.timer); clearTimeout(c.stallTimer); clearTimeout(c.firstFrameTimer); clearInterval(c.pump);
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

  // Expandir/mostrar uma câmera → (re)inicia o stream SÓ dela (o <video> tinha
  // desmontado ao colapsar/ocultar → conexão fechou e economizou banda). Sem
  // deps: roda todo render mas só age na transição escondida→visível (não pisca
  // as outras). O efeito principal acima cuida do start inicial e de token/mode.
  const shownRef = React.useRef({});
  React.useEffect(() => {
    if (!token) return;
    CAMS.forEach((c) => {
      const shown = isVisible(c.id) && !isCollapsed(c.id);
      if (shown && !shownRef.current[c.id]) startStream(c.id);
      shownRef.current[c.id] = shown;
    });
  });

  // health poll — reconecta na hora quando o gateway volta
  React.useEffect(() => {
    if (!token) return undefined;
    const t = setInterval(() => {
      fetch('/api/cam/health?t=' + encodeURIComponent(token)).then((r) => r.json()).then((j) => {
        setGwUp(!!j.reachable);
        if (j.reachable) {
          CAMS.forEach((cam) => {
            // gateway VOLTOU e cam offline → reconecta já, e volta a tentar o mp4
            // (HD): a queda pode ter sido do gateway, não do codec — não fica preso
            // no MJPEG pra sempre depois de um blip. Bruno 07-08.
            if ((statusRef.current[cam.id] || '') === 'off') {
              const c = st(cam.id); c.backoff = 2000;
              if (c.video && camMode(cam.id) === 'mjpeg') { c.mp4Fails = 0; setMode((p) => ({ ...p, [cam.id]: 'mp4' })); }
              else startStream(cam.id);
            }
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

  // Pop-out: abre ESTA câmera numa janela de navegador normal (redimensionável,
  // pra arrastar pra outro monitor). Reusa /cameras/pip (1 câmera, só-vídeo).
  const popOut = (id) => {
    const w = window.open('/cameras/pip?cam=' + encodeURIComponent(id) + '#t=' + encodeURIComponent(token),
      'hf_win_' + id, 'width=760,height=480');
    if (!w) alert('O navegador bloqueou a janela — permita popups pra este site.');
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
    // Chrome/Edge: Document PIP — flutua SÓ esta câmera, sempre no topo.
    // (O Chrome permite 1 PIP no navegador inteiro → toggleDocPip troca a câmera
    // ou fecha; pra ver AS DUAS no topo é o "Ambas no topo" acima.)
    if (hasDocPip()) {
      try { await toggleDocPip('cam:' + id, CAMS.filter((c) => c.id === id)); }
      catch (e2) { alert('PIP falhou: ' + e2.message); }
      return;
    }
    // fallback (Safari/iPhone): PIP de vídeo nativo
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
      const cell = d.createElement('div');
      cell.style.cssText = 'position:relative;flex:1;min-width:0;height:100%;';
      const chip = d.createElement('div');
      chip.textContent = cam.label;
      chip.style.cssText = 'position:absolute;top:6px;left:8px;z-index:2;background:rgba(0,0,0,.55);color:#fff;font:bold 12px system-ui;padding:3px 8px;border-radius:6px;';
      cell.appendChild(chip);
      const IMG = 'width:100%;height:100%;object-fit:contain;display:block;background:#000;';
      const mp4src = () => base + '/api/cam/' + cam.id + '/mp4?t=' + encodeURIComponent(tok) + '&r=' + Date.now();
      const mjpgsrc = () => base + '/api/cam/' + cam.id + '?t=' + encodeURIComponent(tok) + '&r=' + Date.now();
      // fMP4 não aceita "entrar no meio": numa conexão NOVA o vídeo fica PRETO/
      // congelado até o próximo keyframe. A warehouse tem GOP longo → era o "PIP
      // só da warehouse preto" (Bruno 07-07). Watchdog: se em 6s o mp4 não
      // decodificar um frame, cai pra MJPEG (frame isolado, aparece na hora).
      let el, retry = null, blackTimer = null, fails = 0;
      const mountImg = () => {
        const im = d.createElement('img');
        im.style.cssText = IMG;
        im.onerror = () => { clearTimeout(retry); retry = setTimeout(() => { im.src = mjpgsrc(); }, 2500); };
        im.src = mjpgsrc();
        return im;
      };
      const toMjpeg = () => { clearTimeout(blackTimer); const im = mountImg(); if (el) cell.replaceChild(im, el); else cell.appendChild(im); el = im; };
      if (camMode(cam.id) === 'mjpeg') {
        el = mountImg(); cell.appendChild(el);
      } else {
        const v = d.createElement('video'); v.muted = true; v.autoplay = true; v.playsInline = true; v.style.cssText = IMG;
        v.onplaying = () => { clearTimeout(blackTimer); };
        v.onerror = () => { fails += 1; if (fails >= 2) { toMjpeg(); } else { clearTimeout(retry); retry = setTimeout(() => { v.src = mp4src(); v.play && v.play().catch(() => {}); }, 2500); } };
        v.onended = v.onerror;
        el = v; cell.appendChild(v);
        v.src = mp4src(); v.play && v.play().catch(() => {});
        blackTimer = setTimeout(() => { if (v.readyState < 3) toMjpeg(); }, 6000);
      }
      d.body.appendChild(cell);
      w.addEventListener('pagehide', () => { clearTimeout(retry); clearTimeout(blackTimer); });
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

  const widthOf = (id) => widths[id] || defW;
  const persistWidths = (n) => { try { localStorage.setItem(WIDTHS_KEY, JSON.stringify(n)); } catch {} return n; };
  const persistJSON = (k, obj) => { try { localStorage.setItem(k, JSON.stringify(obj)); } catch {} return obj; };
  const isVisible = (id) => visible[id] !== false;          // default: visível
  const isCollapsed = (id) => !!collapsed[id];              // default: expandido
  const toggleVisible = (id) => setVisible((p) => persistJSON(VIS_KEY, { ...p, [id]: !(p[id] !== false) }));
  const toggleCollapsed = (id) => setCollapsed((p) => persistJSON(COLLAPSE_KEY, { ...p, [id]: !p[id] }));
  const persistHeights = (n) => { try { localStorage.setItem(HEIGHTS_KEY, JSON.stringify(n)); } catch {} return n; };
  const heightOf = (id) => heights[id] || (Math.round((widths[id] || defW) * 9 / 16) + 44); // ~16:9 + header
  const panOf = (id) => pan[id] || { x: 50, y: 50 };
  // Aplica largura/altura/pan IMPERATIVAMENTE (fora do style do React) pra que um
  // re-render de status/badge não resete no meio de um resize/pan. useLayoutEffect
  // roda antes do paint → sem flash.
  React.useLayoutEffect(() => {
    order.forEach((id) => {
      const c = ref.current[id]; if (!c) return;
      if (c.wrap) { c.wrap.style.width = (widths[id] || defW) + 'px'; c.wrap.style.height = isCollapsed(id) ? '' : heightOf(id) + 'px'; }
      const op = panOf(id);
      if (c.video) c.video.style.objectPosition = op.x + '% ' + op.y + '%';
      if (c.img) c.img.style.objectPosition = op.x + '% ' + op.y + '%';
    });
  }, [widths, heights, pan, order, token, mode, collapsed, visible]); // eslint-disable-line react-hooks/exhaustive-deps
  // resize por tile: ao soltar (pointerup) grava largura E altura efetivas.
  const onResizeEnd = (id) => {
    const el = st(id).wrap; if (!el) return;
    const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
    if (w && Math.abs(w - widthOf(id)) > 3) setWidths((p) => persistWidths({ ...p, [id]: w }));
    if (h && !isCollapsed(id) && Math.abs(h - heightOf(id)) > 3) setHeights((p) => persistHeights({ ...p, [id]: h }));
  };
  // pan da imagem: arrastar dentro do vídeo escolhe a área visível (object-position).
  const panStart = (id) => (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const start = panOf(id), sx = e.clientX, sy = e.clientY;
    const clamp = (v) => Math.max(0, Math.min(100, v));
    let lx = start.x, ly = start.y;
    const apply = () => { const c = st(id); if (c.video) c.video.style.objectPosition = lx + '% ' + ly + '%'; if (c.img) c.img.style.objectPosition = lx + '% ' + ly + '%'; };
    const onMove = (ev) => {
      lx = clamp(start.x - (ev.clientX - sx) / rect.width * 100);
      ly = clamp(start.y - (ev.clientY - sy) / rect.height * 100);
      apply();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
      setPan((p) => persistJSON(PAN_KEY, { ...p, [id]: { x: lx, y: ly } }));
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  };
  const resetPan = (id) => setPan((p) => persistJSON(PAN_KEY, { ...p, [id]: { x: 50, y: 50 } }));
  // slider "todas": iguala a largura de todas as câmeras.
  const setAllWidths = (w) => setWidths(() => persistWidths(CAMS.reduce((n, c) => { n[c.id] = w; return n; }, {})));
  // drag-to-reorder: solta 'src' antes do 'target'.
  const onDropAt = (targetId) => {
    const src = dragId.current; dragId.current = null;
    if (!src || src === targetId) return;
    const next = order.filter((x) => x !== src);
    const ti = next.indexOf(targetId);
    next.splice(ti < 0 ? next.length : ti, 0, src);
    setOrder(next); try { localStorage.setItem(ORDER_KEY, JSON.stringify(next)); } catch {}
  };

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
          <button key={'vis-' + cam.id} className="btn sm ghost" onClick={() => toggleVisible(cam.id)}
                  title={(isVisible(cam.id) ? 'Ocultar ' : 'Mostrar ') + cam.label}
                  style={{ opacity: isVisible(cam.id) ? 1 : 0.4 }}>
            {isVisible(cam.id) ? '👁' : '🚫'} {cam.label.replace(/^\S+\s/, '')}
          </button>
        ))}
        <button className="btn sm ghost" onClick={togglePipAll}
                title="As câmeras numa janela flutuante SEMPRE-NO-TOPO (redimensionável). O Chrome só permite 1 janela PIP no total, então vão juntas nela.">📌 Ambas no topo</button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-3)' }}
               title="Iguala a largura de TODAS as câmeras. Cada card também dá pra redimensionar sozinho puxando o canto inferior-direito.">
          tamanho (todas) <input type="range" min={280} max={1200} step={20} value={widthOf(order[0] || CAMS[0].id)} onChange={(e) => setAllWidths(+e.target.value)} style={{ width: 110, accentColor: 'var(--hf-navy-500)' }}/>
        </label>
        <a className="btn sm ghost" href="/cameras" target="_blank" rel="noreferrer" title="Página standalone (pra TV/2º monitor)">abrir solto ↗</a>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
        {order.map((id) => CAMS.find((c) => c.id === id)).filter(Boolean).filter((cam) => isVisible(cam.id)).map((cam) => (
          <div key={cam.id} className="card"
               style={{ overflow: 'hidden', padding: 0, maxWidth: '100%', minWidth: 220, display: 'flex', flexDirection: 'column',
                        resize: isCollapsed(cam.id) ? 'none' : 'both' }}
               ref={(el) => { st(cam.id).wrap = el; }}
               onPointerUp={() => onResizeEnd(cam.id)}
               onDragOver={(e) => e.preventDefault()}
               onDrop={() => onDropAt(cam.id)}>
            {/* HEADER — arrasta pra mover/reordenar · clique pra minimizar */}
            <div draggable onDragStart={() => { dragId.current = cam.id; }} onDragEnd={() => { dragId.current = null; }}
                 onClick={() => toggleCollapsed(cam.id)}
                 title="Arraste pra mover/reordenar · clique pra minimizar/expandir"
                 style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '8px 12px', cursor: 'grab', flex: 'none' }}>
              <span style={{ color: 'var(--text-3)', fontSize: 11, flex: 'none', width: 12, textAlign: 'center' }}>{isCollapsed(cam.id) ? '▸' : '▾'}</span>
              <b style={{ fontSize: 12.5, flex: 1, minWidth: 80 }}>{cam.label}</b>
              {badge(cam.id)}
              <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); togglePip(cam.id); }} title="PIP — flutua SÓ esta câmera, sempre no topo (o Chrome permite 1 PIP por vez; clicar noutra troca)">⧉ PIP</button>
              <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); popOut(cam.id); }} title="Abrir esta câmera numa janela separada (redimensionável, pra outro monitor)">⧉↗</button>
              <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); goFullscreen(cam.id); }} title="Tela cheia">⛶</button>
              <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); toggleVisible(cam.id); }} title="Fechar (ocultar — reabre no 👁 lá em cima)">✕</button>
            </div>
            {!isCollapsed(cam.id) && (
              <div style={{ position: 'relative', flex: 1, minHeight: 120, overflow: 'hidden', background: '#000', cursor: 'grab', touchAction: 'none' }}
                   onPointerDown={panStart(cam.id)} onDoubleClick={() => resetPan(cam.id)}
                   title="Arraste a imagem pra escolher a área · 2 cliques recentra">
                {camMode(cam.id) === 'mp4' ? (
                  <video muted autoPlay playsInline draggable={false}
                         ref={(el) => { st(cam.id).video = el; }}
                         style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', background: '#000' }}/>
                ) : (
                  <img alt={cam.label} draggable={false}
                       ref={(el) => { st(cam.id).img = el; }}
                       style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', background: '#000' }}/>
                )}
                {status[cam.id] === 'off' && (
                  <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--text-3)', fontSize: 12.5, background: 'rgba(0,0,0,0.6)' }}>
                    câmera offline — reconectando sozinho…
                  </div>
                )}
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
