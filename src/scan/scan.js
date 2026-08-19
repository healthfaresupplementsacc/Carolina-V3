'use strict';
/* ============================================================
   HEALTHFARE — LEITOR DE CELULAR (/scan/?c=CODIGO). S15 Fase 3.

   O celular do operador vira leitor de codigo de barras do kiosk.
   Sem login: a credencial E o codigo do par (6 chars, curto, renovavel
   do kiosk). Por isso o POST scan/push NAO manda o page token.

   Decodificacao, em ordem:
     1. BarcodeDetector nativo (Android/Chrome): rapido e sem download;
     2. ZXing vendorado (src/scan/vendor/zxing.min.js, MIT) pro resto;
     3. campo "Digitar codigo na mao" — SEMPRE visivel (REGRA #0: se a
        camera falhar, o operador nao pode ficar parado).

   Textos de tela em PT-BR com acento, sem em dash, e todo erro diz o que
   fazer AGORA (nunca um codigo de status).

   Cada leitura: flash verde + vibracao + POST. Rede caiu? tenta de novo
   (fila simples, ate 20 itens) e avisa na tela.
   ============================================================ */
(function () {
  var FORMATS = ['code_128', 'qr_code', 'upc_a', 'upc_e', 'ean_13', 'ean_8', 'data_matrix'];
  var PUSH = '/api/v3/scan/push';
  var KEEPALIVE = '/api/v3/scan/keepalive';
  var KEEP_MS = 60000;
  var DUP_MS = 2000;         // mesmo codigo em <2s = leitura repetida da mesma etiqueta
  var QUEUE_MAX = 20;

  var qs = new URLSearchParams(location.search);
  var PAIR = (qs.get('c') || qs.get('code') || '').trim().toUpperCase();

  var video = document.getElementById('video');
  var lastEl = document.getElementById('last');
  var statusEl = document.getElementById('status');
  var errEl = document.getElementById('err');
  var flashEl = document.getElementById('flash');
  var manualEl = document.getElementById('manual');
  var sendEl = document.getElementById('send');
  var pillCode = document.getElementById('pillcode');

  var lastCode = '';
  var lastAt = 0;
  var stream = null;
  var detector = null;
  var zxReader = null;
  var running = false;
  var queue = [];
  var flushing = false;

  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function setErr(t) {
    if (!errEl) return;
    if (!t) { errEl.className = ''; errEl.textContent = ''; return; }
    errEl.className = 'on'; errEl.textContent = t;
  }
  function showCode(c) { if (lastEl) lastEl.textContent = c; }

  function flash() {
    if (!flashEl) return;
    flashEl.className = 'on';
    setTimeout(function () { flashEl.className = ''; }, 120);
  }
  function buzz() {
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) {}
  }

  /** Nome do formato → simbologia do nosso contrato. */
  function symbologyOf(fmt) {
    var f = String(fmt || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (f.indexOf('qr') >= 0) return 'qr_code';
    if (f.indexOf('code_128') >= 0 || f === 'code128') return 'code_128';
    if (f.indexOf('upc_e') >= 0) return 'upc_e';
    if (f.indexOf('upc') >= 0) return 'upc_a';
    if (f.indexOf('ean_8') >= 0) return 'ean_8';
    if (f.indexOf('ean') >= 0) return 'ean_13';
    if (f.indexOf('data_matrix') >= 0 || f === 'datamatrix') return 'data_matrix';
    return f || 'unknown';
  }

  /** Leitura nova? (a camera le a mesma etiqueta 30x por segundo) */
  function isNew(code) {
    var now = Date.now();
    if (code === lastCode && (now - lastAt) < DUP_MS) return false;
    lastCode = code; lastAt = now;
    return true;
  }

  // ── envio ───────────────────────────────────────────────────
  function push(barcode, symbology) {
    var item = { code: PAIR, barcode: barcode, symbology: symbology || 'manual' };
    queue.push(item);
    if (queue.length > QUEUE_MAX) queue.shift();
    flush();
  }

  function flush() {
    if (flushing || !queue.length) return;
    flushing = true;
    var item = queue[0];
    fetch(PUSH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; });
    }).then(function (x) {
      flushing = false;
      if (x.r.status === 410 || x.r.status === 404) {
        // par expirou: o kiosk precisa gerar outro QR
        queue.length = 0;
        setErr('Perdeu a conexão com o computador. Escaneie o QR da tela do computador de novo.');
        setStatus('desconectado');
        return;
      }
      if (!x.r.ok) {
        setErr('O computador não aceitou esse código. Escaneie de novo, ou digite ele aqui embaixo.');
        queue.shift();
        flush();
        return;
      }
      queue.shift();
      setErr('');
      setStatus('enviado pro computador');
      flush();
    }).catch(function () {
      flushing = false;
      setErr('Sem internet no celular. Assim que voltar eu mando sozinho.');
      setTimeout(flush, 2000);
    });
  }

  /** Um codigo foi lido (camera ou digitado). */
  function onCode(barcode, symbology) {
    var code = String(barcode || '').replace(/[\r\n\t]+/g, '').trim();
    if (!code) return;
    if (!isNew(code)) return;
    flash(); buzz();
    showCode(code);
    setStatus('mandando pro computador...');
    push(code, symbology);
  }

  // ── camera ──────────────────────────────────────────────────
  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setErr('Este navegador não abre a câmera. Digite o código aqui embaixo.');
      setStatus('sem câmera');
      return Promise.resolve(false);
    }
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    }).then(function (s) {
      stream = s;
      video.srcObject = s;
      return video.play().catch(function () {});
    }).then(function () {
      setStatus('conectado ao computador. Aponte pro código de barras');
      return true;
    }).catch(function (e) {
      var name = (e && e.name) || '';
      setErr(name === 'NotAllowedError'
        ? 'Toque em Permitir pra usar a câmera. Enquanto isso, digite o código aqui embaixo.'
        : 'Não consegui abrir a câmera. Digite o código aqui embaixo.');
      setStatus('sem câmera');
      return false;
    });
  }

  /** BarcodeDetector nativo: o caminho bom quando existe. */
  function startNative() {
    try {
      detector = new window.BarcodeDetector({ formats: FORMATS });
    } catch (e) {
      try { detector = new window.BarcodeDetector(); } catch (e2) { return false; }
    }
    running = true;
    var tick = function () {
      if (!running) return;
      if (!video.videoWidth) { requestAnimationFrame(tick); return; }
      detector.detect(video).then(function (list) {
        if (list && list.length) onCode(list[0].rawValue, symbologyOf(list[0].format));
      }).catch(function () {}).then(function () {
        setTimeout(tick, 120);
      });
    };
    tick();
    return true;
  }

  /** ZXing vendorado: cobre iOS e o resto sem BarcodeDetector. */
  function startZxing() {
    var Z = window.ZXing;
    if (!Z) {
      setErr('Este navegador não lê código de barras. Digite o código aqui embaixo.');
      return false;
    }
    try {
      var hints = null;
      if (Z.DecodeHintType && Z.BarcodeFormat) {
        hints = new Map();
        hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
          Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.UPC_A,
          Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8,
          Z.BarcodeFormat.DATA_MATRIX,
        ]);
        hints.set(Z.DecodeHintType.TRY_HARDER, true);
      }
      zxReader = new Z.BrowserMultiFormatReader(hints, 200);
      zxReader.decodeFromVideoElement(video, function (result, err) {
        if (result) {
          var fmt = result.getBarcodeFormat ? result.getBarcodeFormat() : null;
          var name = (Z.BarcodeFormat && fmt != null) ? String(Z.BarcodeFormat[fmt] || '') : '';
          onCode(result.getText ? result.getText() : String(result), symbologyOf(name));
        }
      });
      running = true;
      return true;
    } catch (e) {
      setErr('O leitor da câmera falhou. Digite o código aqui embaixo.');
      return false;
    }
  }

  function startDecoder() {
    if (typeof window.BarcodeDetector !== 'undefined') {
      if (window.BarcodeDetector.getSupportedFormats) {
        // alguns navegadores expoem a classe mas nao suportam nada
        window.BarcodeDetector.getSupportedFormats().then(function (f) {
          if (f && f.length) { if (!startNative()) startZxing(); }
          else startZxing();
        }).catch(function () { if (!startNative()) startZxing(); });
        return;
      }
      if (startNative()) return;
    }
    startZxing();
  }

  // ── keepalive: avisa o kiosk que o celular continua vivo ────
  function keepalive() {
    if (!PAIR) return;
    fetch(KEEPALIVE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: PAIR }),
    }).catch(function () {});
  }

  // ── manual (sempre disponivel) ──────────────────────────────
  function sendManual() {
    var v = (manualEl && manualEl.value || '').trim();
    if (!v) { manualEl && manualEl.focus(); return; }
    lastCode = ''; lastAt = 0;                 // digitou: e intencional, mesmo repetido
    onCode(v, 'manual');
    manualEl.value = '';
    manualEl.blur();
  }

  function boot() {
    if (pillCode) pillCode.textContent = PAIR ? ('computador ' + PAIR) : '';
    if (!PAIR) {
      setErr('Este link não tem o código do computador. Escaneie o QR que aparece na tela do computador.');
      setStatus('não conectado');
    }
    if (sendEl) sendEl.addEventListener('click', sendManual);
    if (manualEl) {
      manualEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendManual(); } });
    }
    startCamera().then(function (ok) { if (ok) startDecoder(); });
    if (PAIR) {
      keepalive();
      setInterval(keepalive, KEEP_MS);
    }
    // celular bloqueou/voltou: religa a camera
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (video && video.paused) { try { video.play(); } catch (e) {} }
      keepalive();
    });
  }

  // exposto pro harness (e pra depurar no celular)
  window.HF_SCAN = {
    onCode: onCode, push: push, symbologyOf: symbologyOf, isNew: isNew,
    pair: function () { return PAIR; }, queue: function () { return queue; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
