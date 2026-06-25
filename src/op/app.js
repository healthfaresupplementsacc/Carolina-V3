'use strict';
/* ============================================================
   HEALTHFARE Operator Page — /op (redesign FIEL ao design).
   Port verbatim de "HealthFare Linha.dc.html" (handoff Claude Design):
   estilos inline exatos, ambiente (4 blobs de marca + bottles reais à deriva
   com drop-shadow + cápsulas de gel REAIS com pó/sheen/seam e ciclo de cor),
   motor de cor (dia/energia/pulse), todas as telas e overlays.

   ARQUITETURA ANTI-BLINK (patch UX):
   - Cada tela/modal é uma CAMADA persistente no DOM; troca = cross-fade de
     opacidade (220ms). Nunca há frame vazio → sem flash branco/escuro.
   - mount+patch: a casca de cada camada é montada UMA vez (anim de entrada
     toca uma vez); updates internos (PIN, passos do flow, voz) são cirúrgicos.
   - Ambiente (blobs/bottles/cápsulas) montado uma vez e NUNCA muda opacidade
     nas transições.

   Plumbing (API/handlers/timers/offline) PRESERVADO:
     auth/login·logout·heartbeat, architect/person/:id/today, active-operators,
     event/start·retroactive·:id/end·:id/join, note, missing-bottle-counts,
     clock-out, forgotten-checkout/resolve.
   ============================================================ */
(function () {
  var CFG = window.HF_OP_CONFIG || { pageToken: '' };
  var DATA = window.HF_DATA || { groups: [], quick: [], supplements: [], recent_batches: [] };
  var SM = window.HFStateMachine; var D = window.HFDesign;
  var Q = window.HFOfflineQueue || null;
  var ROOT = document.getElementById('hf-canvas'); // design fixo 1440x900 (escalado por fitCanvas)

  // ── ícones (paths SVG — cópia exata do design) ─────────────
  var ICONS = {
    factory: 'M3 21h18M5 21V10l4 2.5V10l4 2.5V7l5 3v11',
    flask: 'M9 3h6M10 3v5.5L5.5 17a2 2 0 0 0 1.8 3h9.4a2 2 0 0 0 1.8-3L14 8.5V3M7.5 14h9',
    spray: 'M8 21h6M9 21v-4M6.5 17h9v-2a4.5 4.5 0 0 0-9 0zM16 4h3M16 7h4M16 10h3M14.5 3v9',
    package: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13.2V21',
    truck: 'M3 6.5h11v9H3zM14 9.5h3.5l3 3v3H17M7 19a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 7 19zM17.5 19a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    sparkle: 'M12 3l1.7 5.1L19 10l-5.3 1.9L12 17l-1.7-5.1L5 10l5.3-1.9z',
    tag: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-7-7a2 2 0 0 1-.6-1.4V5a2 2 0 0 1 2-2h6.6a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 .2 2.8zM8 8h.01',
    printer: 'M6 9V3.5h12V9M6 18.5H4.5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H18M6.5 14.5h11V21h-11z',
    wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.5V21H7l6-6a4 4 0 0 0 5.2-5.4l-2.8 2.8-2-2 2.7-2.7z',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20.5 20.5l-4-4',
    coffee: 'M4 8.5h13v4.5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM17 9.5h2a2 2 0 0 1 0 4h-2M7 3v1.5M10 3v1.5M13 3v1.5',
    chat: 'M21 11.5a8 8 0 0 1-11.6 7.1L4 20.5l1.9-5.3A8 8 0 1 1 21 11.5z',
    book: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15.5H6.5A1.5 1.5 0 0 0 5 20zM19 3v15.5',
    bowl: 'M4 11h16a8 8 0 0 1-16 0zM9 11V7.5a3 3 0 0 1 6 0V11',
    gear: 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM19.2 12c0-.4 0-.7-.1-1l1.7-1.4-1.7-2.9-2 .8a7 7 0 0 0-1.7-1l-.3-2.2H11l-.3 2.2a7 7 0 0 0-1.7 1l-2-.8L5.3 9.6 7 11c0 .3-.1.6-.1 1s0 .7.1 1l-1.7 1.4 1.7 2.9 2-.8a7 7 0 0 0 1.7 1l.3 2.2h2.4l.3-2.2a7 7 0 0 0 1.7-1l2 .8 1.7-2.9L19.1 13c.1-.3.1-.6.1-1z',
    pause: 'M9.5 4.5H6.5v15h3zM17.5 4.5h-3v15h3z',
    edit: 'M12 20h9M16.8 3.6a2 2 0 0 1 2.8 2.8L7.5 18.5 3 19.5l1-4.5z',
    swap: 'M7 7h11l-3.2-3.2M17 17H6l3.2 3.2',
    plus: 'M12 5v14M5 12h14',
    cross: 'M9.5 3h5v5.5H20v5h-5.5V19h-5v-5.5H4v-5h5.5z',
    box: 'M3.5 7.5l8.5-4 8.5 4-8.5 4zM3.5 7.5v9l8.5 4 8.5-4v-9M12 11.5V21',
  };
  var SLUG_ICON = {
    production_line: 'factory', review: 'search', counting: 'box', line_changeover: 'swap', formulation: 'flask', mixing: 'bowl', encapsulation: 'flask', material_handling: 'package',
    cleaning: 'spray', repair: 'wrench', facility_maintenance: 'gear', organization: 'grid', machine_downtime: 'pause', label_change: 'tag', label_repair: 'wrench',
    orders: 'printer', order_printing: 'printer', order_printing_2: 'printer', labeling: 'tag', packaging: 'package', marketplace_prep: 'tag', shipping: 'truck', dc_shipment: 'truck',
    clinic_shipment: 'cross', box_closing: 'box', special_task: 'sparkle', break: 'coffee', meeting: 'chat', training: 'book', lunch: 'coffee', end_of_day: 'coffee',
  };
  function iconPath(slug) { if (SLUG_ICON[slug] && ICONS[SLUG_ICON[slug]]) return ICONS[SLUG_ICON[slug]]; if (/_other$/.test(slug || '')) return ICONS.edit; return ICONS.sparkle; }
  var GROUP_ICON = { linha: 'factory', formulacao: 'flask', limpeza: 'spray', embalagem: 'package', envio: 'truck', outros: 'grid' };
  var GROUP_ACCENT = { linha: '#2f7ae0', formulacao: '#1b8f8f', limpeza: '#2faa57', embalagem: '#c77d12', envio: '#5a6ee0', outros: '#8a7ad0' };

  var MANTRAS = [
    { pt: 'Você cuida de mais de um milhão de vidas.', es: 'Cuidas de más de un millón de vidas.', en: 'You care for over a million lives.' },
    { pt: 'Cada lote que você fecha chega a uma família.', es: 'Cada lote que cierras llega a una familia.', en: 'Every batch you finish reaches a family.' },
    { pt: 'Saúde de verdade começa nas suas mãos.', es: 'La salud de verdad empieza en tus manos.', en: 'Real health begins in your hands.' },
    { pt: 'O mundo confia no seu cuidado, hoje.', es: 'El mundo confía en tu cuidado, hoy.', en: 'The world trusts your care, today.' },
    { pt: 'Pequenos gestos seus, impacto gigante.', es: 'Tus pequeños gestos, impacto gigante.', en: 'Your small acts, a giant impact.' },
    { pt: 'Mais de um milhão de pessoas, um propósito: você.', es: 'Más de un millón de personas, un propósito: tú.', en: 'A million people, one purpose: you.' },
  ];

  // bottle por nome de produto (carrega de products.json)
  var PRODUCTS = { exact: {}, aliases: {} };
  fetch('/op/products.json').then(function (r) { return r.json(); }).then(function (j) { PRODUCTS = j; }).catch(function () {});
  function bottleFor(name) {
    if (!name) return null; var n = String(name).toLowerCase();
    for (var k in (PRODUCTS.exact || {})) if (k.toLowerCase() === n) return '/op/assets/bottles/' + PRODUCTS.exact[k];
    for (var a in (PRODUCTS.aliases || {})) if (n.indexOf(a) >= 0) return '/op/assets/bottles/' + PRODUCTS.aliases[a];
    return null;
  }
  var BOTTLE_FILES = ['benfotiamine', 'berberine', 'nad', 'l-carnitine', 'plant-sterols', 'rutin', 'white-kidney', 'chlorophyll', 'ashwagandha', 'charcoal'];

  // ── settings (localStorage por device) ─────────────────────
  var SKEY = 'hf_op_settings_v5';
  var SDEF = { mantras: true, mantraLang: 'rotate', dayPhase: 'auto', density: 'medium', aging: false, warnMin: 45, overMin: 90 };
  function loadSettings() { try { return Object.assign({}, SDEF, JSON.parse(localStorage.getItem(SKEY) || '{}')); } catch (e) { return Object.assign({}, SDEF); } }
  function saveSettings() { try { localStorage.setItem(SKEY, JSON.stringify(S.settings)); } catch (e) {} }

  // ── estado ─────────────────────────────────────────────────
  var S = {
    screen: 'login', pin: '', pinError: '', shake: false,
    session: null, now: Date.now(), logoffLeft: null,
    myTasks: [], team: [], completedToday: 0, goal: 8, pulse: 0, online: navigator.onLine,
    flow: null, overlay: null, settingsOpen: false, alert: null, settings: loadSettings(),
    mantraIdx: 0, mantraLangTick: 0, toast: '', voice: { on: false, secs: 0, target: null }, _focus: null,
  };

  // ── API (Bearer pageToken + X-Session-Token + offline queue) ─
  function api(path, opts) {
    opts = opts || {}; var headers = { Authorization: 'Bearer ' + CFG.pageToken };
    if (S.session) headers['X-Session-Token'] = S.session.token;
    if (opts.headers) Object.assign(headers, opts.headers);
    var init = { method: opts.method || 'GET', headers: headers };
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (r.status === 401 && S.session && path.indexOf('/auth/login') < 0) { endSession(); throw mkErr('Sessão expirou — entra de novo', r.status); }
        if (!r.ok) throw mkErr((j && (j.detail || j.error)) || ('HTTP ' + r.status), r.status, j);
        return j;
      });
    }).catch(function (e) {
      if (e._net && Q && init.method === 'POST' && /\/event\/(start|retroactive)|\/note/.test(path)) {
        Q.enqueue({ path: path, body: opts.body, sessionToken: S.session && S.session.token });
        return { ok: true, queued: true };
      }
      throw e;
    });
  }
  function mkErr(msg, status, body) { var e = new Error(msg); e.status = status; e.body = body; return e; }
  var _fetch = window.fetch;
  window.fetch = function () { return _fetch.apply(this, arguments).catch(function (err) { err._net = true; throw err; }); };

  function toast(m) { S.toast = m; render(); clearTimeout(toast._t); toast._t = setTimeout(function () { S.toast = ''; render(); }, 2600); }

  // ── helpers de markup ──────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sty(o) { var s = ''; for (var k in o) { if (!o.hasOwnProperty(k)) continue; var kk = k.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); }); s += kk + ':' + o[k] + ';'; } return s; }
  function svg(path, sz, sw) { sz = sz || 24; sw = sw || 1.8; return '<svg width="' + sz + '" height="' + sz + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"></path></svg>'; }
  function svgr(inner, sz, sw, fill) { sz = sz || 24; return '<svg width="' + sz + '" height="' + sz + '" viewBox="0 0 24 24" fill="' + (fill || 'none') + '" stroke="' + (fill === 'currentColor' ? 'none' : 'currentColor') + '" stroke-width="' + (sw || 1.8) + '" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>'; }
  var CHECK = '<polyline points="20 6 9 17 4 12"></polyline>';
  var PLAY = '<polygon points="6 4 20 12 6 20 6 4"></polygon>';
  var PEOPLE = '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>';
  var CLOCK = '<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline>';
  var MIC = '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line>';
  var EDITP = '<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path>';
  var DOOR = '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line>';
  var WARN = '<path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>';

  function isSandbox() { return !!(S.session && S.session.person && S.session.person.is_sandbox); }
  function accent() { return isSandbox() ? '#0a9aa6' : '#0e7a4e'; } // sandbox = verde-água

  function curMantra() {
    var m = MANTRAS[S.mantraIdx % MANTRAS.length];
    var lang = S.settings.mantraLang || 'rotate';
    if (lang === 'rotate') { return m[['pt', 'es', 'en'][S.mantraLangTick % 3]]; }
    return m[lang] || m.pt;
  }

  // ── motor de cor (dia / energia / pulse) ───────────────────
  function dayFrac() {
    var ph = S.settings.dayPhase || 'auto';
    if (ph === 'morning') return 0.18;
    if (ph === 'afternoon') return 0.55;
    if (ph === 'evening') return 0.92;
    var d = new Date(S.now); var h = d.getHours() + d.getMinutes() / 60;
    return Math.max(0, Math.min(1, (h - 7) / 12));
  }
  function phaseLabel() { var f = dayFrac(); return f < 0.34 ? 'Manhã' : f < 0.67 ? 'Tarde' : 'Noite'; }
  function greetingTxt() { var f = dayFrac(); return f < 0.34 ? 'Bom dia' : f < 0.67 ? 'Boa tarde' : 'Boa noite'; }
  function energyVal() { return Math.min(1, S.completedToday / 8); }
  function fmtDur(iso) { var m = Math.max(0, Math.floor((S.now - Date.parse(iso)) / 60000)); return m >= 60 ? Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') : m + ' min'; }
  function clockNow() { return new Date(S.now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
  function dateNow() { return new Date(S.now).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }); }

  function ageState(startIso) {
    if (!S.settings.aging) return 'ok';
    var mins = (S.now - Date.parse(startIso)) / 60000;
    var warn = Number(S.settings.warnMin) || 45, over = Number(S.settings.overMin) || 90;
    if (mins >= over) return 'over'; if (mins >= warn) return 'warn'; return 'ok';
  }
  var AGE = {
    ok: { border: '#0e7a4e', icoBg: 'rgba(14,122,78,.1)', ico: '#0e7a4e', badge: '', glow: '0 16px 38px -24px rgba(15,40,90,.45)' },
    warn: { border: '#d99100', icoBg: 'rgba(217,145,0,.13)', ico: '#b3740a', badge: 'Demorando', glow: '0 0 0 1px rgba(217,145,0,.3), 0 18px 40px -22px rgba(217,145,0,.55)' },
    over: { border: '#c0352b', icoBg: 'rgba(192,53,43,.13)', ico: '#c0352b', badge: 'Atrasada · precisa de ajuda', glow: '0 0 0 1px rgba(192,53,43,.35), 0 18px 42px -20px rgba(192,53,43,.6)' },
  };

  // ════════════════════════════════════════════════════════════
  // AMBIENTE (montado UMA vez; rebuild só se densidade mudar)
  // ════════════════════════════════════════════════════════════
  var AMBIENT = null, MANTRA = null, shellBuilt = false, ambientDensity = null;
  var LYR = {}; // name -> { el, on, key }
  function bootShell() {
    // #hf-ambient vive no #hf-stage (full viewport), fora do canvas — não recriar aqui.
    ROOT.innerHTML =
      '<div id="hf-mantra-wrap"></div>' +
      '<div id="hf-main">' +
        '<div id="scr-login" class="hf-layer"></div>' +
        '<div id="scr-home" class="hf-layer"></div>' +
        '<div id="lyr-flow" class="hf-layer hf-modal"></div>' +
        '<div id="lyr-overlay" class="hf-layer hf-modal"></div>' +
        '<div id="lyr-settings" class="hf-layer"></div>' +
        '<div id="lyr-alert" class="hf-layer hf-modal"></div>' +
      '</div>' +
      '<div id="hf-toast"></div>';
    AMBIENT = document.getElementById('hf-ambient');
    MANTRA = document.getElementById('hf-mantra-wrap');
    ['login', 'home', 'flow', 'overlay', 'settings', 'alert'].forEach(function (n) {
      LYR[n] = { el: document.getElementById(n === 'login' || n === 'home' ? 'scr-' + n : 'lyr-' + n), on: false, key: null };
    });
    buildAmbient();
    shellBuilt = true;
  }
  function ambientBottles() {
    var dens = S.settings.density; var n = dens === 'low' ? 4 : dens === 'high' ? 8 : 6;
    var defs = [
      { top: '56%', left: '3%', w: 230, blur: 1.5, op: 0.5, anim: 'driftA 64s ease-in-out infinite alternate', rot: -8 },
      { top: '52%', left: '-3%', w: 300, blur: 5, op: 0.32, anim: 'driftB 82s ease-in-out infinite alternate', rot: 6 },
      { top: '12%', left: '80%', w: 260, blur: 2, op: 0.42, anim: 'driftC 72s ease-in-out infinite alternate', rot: 10 },
      { top: '60%', left: '82%', w: 340, blur: 7, op: 0.26, anim: 'driftD 90s ease-in-out infinite alternate', rot: -6 },
      { top: '36%', left: '44%', w: 180, blur: 9, op: 0.16, anim: 'driftA 100s ease-in-out infinite alternate', rot: 4 },
      { top: '78%', left: '34%', w: 210, blur: 4, op: 0.3, anim: 'driftC 78s ease-in-out infinite alternate', rot: -12 },
      { top: '4%', left: '52%', w: 160, blur: 6, op: 0.22, anim: 'driftB 96s ease-in-out infinite alternate', rot: 8 },
      { top: '30%', left: '20%', w: 150, blur: 8, op: 0.18, anim: 'driftD 86s ease-in-out infinite alternate', rot: -4 },
    ];
    var html = '';
    defs.slice(0, n).forEach(function (d, k) {
      var st = {
        position: 'absolute', top: d.top, left: d.left, width: d.w + 'px', opacity: d.op,
        filter: 'blur(' + d.blur + 'px) saturate(calc(0.85 + 0.45*var(--day,.5))) drop-shadow(0 18px 30px rgba(15,40,90,.28)) drop-shadow(0 2px 6px rgba(15,40,90,.22))',
        transform: 'rotate(' + d.rot + 'deg)', animation: d.anim, willChange: 'transform', pointerEvents: 'none', userSelect: 'none',
      };
      html += '<img src="/op/assets/bottles/' + BOTTLE_FILES[k % BOTTLE_FILES.length] + '.png" loading="lazy" alt="" style="' + sty(st) + '">';
    });
    return html;
  }
  function capsules() {
    var dens = S.settings.density; var n = dens === 'low' ? 6 : dens === 'high' ? 14 : 10;
    var powders = [
      { base: '#8b9099', light: '#b9bdc4', dark: '#5e636b' }, { base: '#7a5230', light: '#a07a52', dark: '#553620' },
      { base: '#e3b822', light: '#f3d970', dark: '#b08c10' }, { base: '#3a6fd0', light: '#79a0e8', dark: '#244c9c' },
      { base: '#7a4bd0', light: '#a784e6', dark: '#54309c' }, { base: '#2a2d33', light: '#54585f', dark: '#15171b' },
      { base: '#ecdf9a', light: '#f7eec2', dark: '#cbbd70' }, { base: '#d8c8a8', light: '#ece0c8', dark: '#b3a07c' },
      { base: '#5a9e52', light: '#86c47e', dark: '#3d7a37' }, { base: '#d98a2b', light: '#f0ad60', dark: '#b06814' },
      { base: '#f2f2ee', light: '#ffffff', dark: '#d2d2cc' },
    ];
    var html = '';
    for (var i = 0; i < n; i++) {
      var pw = powders[(i * 3 + 1) % powders.length];
      var w = 46 + (i * 41 % 70); var h = Math.round(w * 0.41);
      var topN = (i * 53 + 6) % 88; var leftN = (i * 67 + 5) % 90;
      if (topN < 17 && leftN < 36) { leftN = leftN + 44; if (leftN < 36) leftN += 30; }
      var dur = 36 + (i * 13 % 50); var drift = ['driftA', 'driftB', 'driftC', 'driftD'][i % 4]; var spin = (i % 2 ? 'spinSlow' : 'spinRev');
      var far = i >= n * 0.55;
      var wrap = { position: 'absolute', top: topN + '%', left: leftN + '%', width: w + 'px', height: h + 'px', opacity: far ? 0.4 : 0.74, filter: far ? 'blur(1.6px)' : 'none', animation: drift + ' ' + dur + 's ease-in-out infinite alternate, ' + spin + ' ' + (dur * 2.2) + 's linear infinite', willChange: 'transform', pointerEvents: 'none' };
      var pill = { position: 'relative', width: '100%', height: '100%', borderRadius: '999px', overflow: 'hidden', background: 'linear-gradient(180deg, rgba(255,255,255,.5) 0%, rgba(255,255,255,.08) 26%, rgba(255,255,255,0) 50%, rgba(0,0,0,.05) 78%, rgba(0,0,0,.14) 100%)', border: '1px solid rgba(255,255,255,.55)', boxShadow: 'inset 0 -2px 5px rgba(0,0,0,.14), inset 0 2px 4px rgba(255,255,255,.6), inset 7px 0 9px -7px rgba(0,0,0,.18), inset -7px 0 9px -7px rgba(0,0,0,.14), 0 ' + Math.round(h * 0.5) + 'px ' + Math.round(h * 1.1) + 'px -' + Math.round(h * 0.4) + 'px rgba(15,40,90,.3)' };
      var powder = { position: 'absolute', inset: '2px', borderRadius: '999px', backgroundColor: pw.base, backgroundImage: 'radial-gradient(rgba(255,255,255,.4) 0.5px, transparent 0.7px), radial-gradient(rgba(0,0,0,.22) 0.5px, transparent 0.7px), linear-gradient(180deg, ' + pw.light + ' 0%, ' + pw.base + ' 46%, ' + pw.dark + ' 100%)', backgroundSize: '3.5px 3.5px, 4.5px 4.5px, 100% 100%', backgroundPosition: '0 0, 2px 2px, 0 0', boxShadow: 'inset 0 -3px 5px rgba(0,0,0,.22), inset 0 2px 3px rgba(255,255,255,.25)', animation: 'hfHue ' + (26 + (i * 11 % 34)) + 's linear infinite', animationDelay: '-' + (i * 5) + 's' };
      var seam = { position: 'absolute', left: '46%', top: '4%', width: '4px', height: '92%', zIndex: '2', background: 'linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.3) 40%, rgba(0,0,0,.12) 60%, rgba(0,0,0,0))' };
      var sheen = { position: 'absolute', left: '10%', right: '10%', top: '13%', height: '24%', borderRadius: '999px', background: 'linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.85) 45%, rgba(255,255,255,0))', filter: 'blur(1.4px)', zIndex: '2' };
      html += '<div style="' + sty(wrap) + '"><div style="' + sty(pill) + '"><div style="' + sty(powder) + '"></div><div style="' + sty(seam) + '"></div><div style="' + sty(sheen) + '"></div></div></div>';
    }
    return html;
  }
  function buildAmbient() {
    if (!AMBIENT) return;
    var blobs =
      '<div style="position:absolute; width:62vmax; height:62vmax; left:-16vmax; top:-20vmax; border-radius:50%; background:radial-gradient(circle, #2f7ae0, transparent 68%); filter:blur(60px); opacity:calc(0.14 + 0.34*var(--day,.5) + 0.16*var(--energy,.3) + 0.1*var(--pulse,0));"></div>' +
      '<div style="position:absolute; width:58vmax; height:58vmax; right:-18vmax; top:8vmax; border-radius:50%; background:radial-gradient(circle, #44ae4f, transparent 66%); filter:blur(64px); opacity:calc(0.12 + 0.32*var(--day,.5) + 0.18*var(--energy,.3) + 0.1*var(--pulse,0));"></div>' +
      '<div style="position:absolute; width:54vmax; height:54vmax; left:24vmax; bottom:-24vmax; border-radius:50%; background:radial-gradient(circle, #1b8f8f, transparent 70%); filter:blur(66px); opacity:calc(0.1 + 0.26*var(--day,.5) + 0.14*var(--energy,.3));"></div>' +
      '<div style="position:absolute; width:40vmax; height:40vmax; right:18vmax; bottom:-12vmax; border-radius:50%; background:radial-gradient(circle, #0f4c92, transparent 72%); filter:blur(70px); opacity:calc(0.08 + 0.2*var(--day,.5));"></div>';
    AMBIENT.innerHTML = blobs + ambientBottles() + capsules();
    ambientDensity = S.settings.density;
  }
  function adminUI() { return S.session && ['admin', 'owner', 'manager'].indexOf(S.session.person.role) >= 0; }

  // ════════════════════════════════════════════════════════════
  // RENDER (camadas persistentes + cross-fade; sem rebuild global)
  // ════════════════════════════════════════════════════════════
  // monta a casca de uma camada UMA vez por key (anim de entrada toca 1x);
  // liga/desliga via classe .on (CSS faz o cross-fade). onMount roda no build.
  function mountLayer(name, on, htmlFn, key, onMount) {
    var L = LYR[name]; if (!L) return;
    if (on) {
      var rebuilt = false;
      if (!L.on || L.key !== key) { L.el.innerHTML = htmlFn(); L.key = key; rebuilt = true; }
      if (!L.on) { L.el.classList.add('on'); L.on = true; }
      if (rebuilt && onMount) onMount(L.el);
    } else if (L.on) { L.el.classList.remove('on'); L.on = false; }
  }
  function restoreFocus(scope) {
    if (!S._focus) return; var fo = scope.querySelector('[data-focus="' + S._focus + '"]'); if (!fo) return;
    fo.focus(); try { var v = fo.value; fo.value = ''; fo.value = v; } catch (e) {}
  }
  function render() {
    if (!shellBuilt) bootShell();
    // vars no <html> → herdadas pelo #hf-ambient (no stage) E pelo #hf-canvas
    var RS = document.documentElement.style;
    document.documentElement.classList.toggle('hf-sandbox', isSandbox()); // tinge o ambiente (água)
    RS.setProperty('--accent', accent());
    RS.setProperty('--day', dayFrac().toFixed(3));
    RS.setProperty('--energy', energyVal().toFixed(3));
    RS.setProperty('--pulse', S.pulse.toFixed(3));
    if (ambientDensity !== S.settings.density) buildAmbient();
    // mantra (fixa no rodapé; só na home e quando ligada)
    MANTRA.innerHTML = (S.settings.mantras && S.screen === 'home')
      ? '<div style="position:absolute; bottom:24px; left:0; right:0; z-index:4; display:flex; justify-content:center; pointer-events:none; padding:0 16px;"><div id="hf-mantra-text" style="animation:hfMantra 7s ease-in-out infinite; font-family:\'Sora\',sans-serif; font-weight:600; font-size:18px; letter-spacing:.01em; color:#4a6485; text-align:center; max-width:760px; text-shadow:0 1px 14px rgba(255,255,255,.7);">' + esc(curMantra()) + '</div></div>'
      : '';

    mountLayer('login', S.screen === 'login', loginInner, 'login|' + S.pin.length + '|' + S.pinError + '|' + (S.shake ? 1 : 0));
    mountLayer('home', S.screen === 'home', homeInner, homeKey());
    mountFlow();
    mountLayer('overlay', !!S.overlay, overlayInner, overlayKey(), function (el) { restoreFocus(el); });
    mountLayer('settings', S.settingsOpen && adminUI(), settingsInner, settingsKey());
    mountLayer('alert', !!S.alert, alertInner, alertKey(), function (el) { var b = el.querySelector('#hf-alert-ok'); if (b) b.focus(); });
    setToast();
  }
  function setToast() {
    var t = document.getElementById('hf-toast'); if (!t) return;
    if (S.toast) { t.innerHTML = '<div style="background:#0c2545; color:#fff; padding:14px 24px; border-radius:16px; font-weight:600; font-size:15px; box-shadow:0 20px 50px -16px rgba(12,37,69,.7); max-width:92vw; text-align:center;">' + esc(S.toast) + '</div>'; t.classList.add('on'); }
    else { t.classList.remove('on'); }
  }

  // ── TOPBAR ─────────────────────────────────────────────────
  function iconBtn(act, title, inner, color, bg, border) {
    return '<button data-act="' + act + '" title="' + esc(title) + '" aria-label="' + esc(title) + '" style="flex:none; width:42px; height:42px; border-radius:50%; border:1px solid ' + (border || 'rgba(255,255,255,.8)') + '; background:' + bg + '; backdrop-filter:blur(14px); color:' + color + '; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 8px 22px -14px rgba(15,40,90,.4);">' + inner + '</button>';
  }
  function topbarHTML() {
    var p = S.session.person;
    var logoff = '<span id="hf-logoff" style="font-size:12px; color:#566681; font-weight:600; margin-right:2px;">' + (S.logoffLeft != null && S.logoffLeft <= 120 ? 'sai em ' + S.logoffLeft + 's' : '') + '</span>';
    return '<div style="position:relative; z-index:6; display:flex; align-items:center; gap:14px; padding:clamp(12px,1.6vw,18px) clamp(14px,2.6vw,30px);">'
      + '<div style="display:flex; align-items:center; min-width:0;"><span style="display:inline-flex; align-items:center; padding:9px 17px; border-radius:17px; background:rgba(255,255,255,.8); backdrop-filter:blur(16px); border:1px solid rgba(255,255,255,.9); box-shadow:0 12px 30px -16px rgba(15,40,90,.5);"><img src="/op/assets/healthfare-logo.png" alt="HealthFare" style="height:clamp(34px,3.2vw,46px); width:auto; display:block;"></span></div>'
      + '<div style="flex:1;"></div>' + logoff
      + '<div style="display:flex; align-items:center; gap:9px;">'
      + '<div style="display:flex; align-items:center; gap:8px; background:rgba(255,255,255,.7); backdrop-filter:blur(14px); border:1px solid rgba(255,255,255,.8); border-radius:999px; padding:7px 14px 7px 9px; box-shadow:0 8px 24px -14px rgba(15,40,90,.4);"><div style="width:30px; height:30px; border-radius:50%; background:linear-gradient(140deg,#2f7ae0,#0f4c92); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:12px;">' + esc(D.initials(p.display_name)) + '</div><span style="font-weight:700; font-size:14px; color:#0c2545; white-space:nowrap;">' + esc(p.display_name) + '</span><span style="width:8px; height:8px; border-radius:50%; background:#21a85b; box-shadow:0 0 0 3px rgba(33,168,91,.18); animation:hfPulse 2.4s ease-in-out infinite; margin-left:2px;"></span></div>'
      + (adminUI() ? iconBtn('toggleSettings', 'Ajustes (admin)', svg(ICONS.gear, 20, 1.7), '#42566f', 'rgba(255,255,255,.62)', 'rgba(255,255,255,.8)') : '')
      + iconBtn('clockout', 'Sair (fim do dia)', svgr(DOOR, 20, 1.8), '#b35c00', 'rgba(255,247,234,.82)', 'rgba(199,125,18,.3)')
      + iconBtn('logout', 'Trocar operador', svgr('<path d="M17 1l4 4-4 4"></path><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><path d="M7 23l-4-4 4-4"></path><path d="M21 13v2a4 4 0 0 1-4 4H3"></path>', 20, 1.8), '#42566f', 'rgba(255,255,255,.62)', 'rgba(255,255,255,.8)')
      + '</div></div>';
  }

  // ── LOGIN (só o card; #scr-login centraliza) ───────────────
  function loginInner() {
    var ac = accent();
    var dots = '';
    for (var i = 0; i < 4; i++) {
      var on = S.pin.length > i;
      dots += '<div style="width:16px; height:16px; border-radius:50%; transition:all .2s; background:' + (on ? ac : 'transparent') + '; border:2px solid ' + (on ? ac : 'rgba(15,40,90,.28)') + '; transform:' + (on ? 'scale(1.18)' : 'scale(1)') + ';"></div>';
    }
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'];
    var kp = '';
    keys.forEach(function (k) {
      var isOk = k === '✓', isDel = k === '⌫';
      var base = 'aspect-ratio:1; border-radius:50%; cursor:pointer; font-family:\'Sora\',sans-serif; font-weight:700; font-size:clamp(22px,3vw,28px); display:flex; align-items:center; justify-content:center; transition:transform .1s, background .15s; min-height:0;';
      var st;
      if (isOk) st = base + 'border:0; color:#fff; background:linear-gradient(135deg, color-mix(in srgb, ' + ac + ' 86%, #19c277), ' + ac + '); box-shadow:0 14px 30px -12px color-mix(in srgb, ' + ac + ' 70%, transparent);';
      else if (isDel) st = base + 'border:1px solid rgba(15,40,90,.12); color:#6c819b; background:rgba(255,255,255,.5); font-size:clamp(20px,2.6vw,26px);';
      else st = base + 'border:1px solid rgba(255,255,255,.85); color:#0c2545; background:rgba(255,255,255,.72); box-shadow:0 10px 24px -16px rgba(15,40,90,.5);';
      kp += '<button data-act="pinkey" data-arg="' + k + '" style="' + st + '">' + k + '</button>';
    });
    return '<div style="width:min(94vw,420px); background:rgba(255,255,255,.66); backdrop-filter:blur(26px) saturate(1.5); border:1px solid rgba(255,255,255,.8); border-radius:34px; padding:clamp(26px,4vw,40px) clamp(22px,3.6vw,36px); box-shadow:0 40px 90px -36px rgba(15,40,90,.5), inset 0 1px 0 rgba(255,255,255,.9); text-align:center;">'
      + '<img src="/op/assets/healthfare-logo.png" alt="HealthFare" style="height:clamp(46px,7vw,58px); width:auto; margin:0 auto 10px;">'
      + '<div style="font-family:\'Sora\',sans-serif; font-weight:600; font-size:14px; letter-spacing:.16em; text-transform:uppercase; color:#6c819b; margin-bottom:22px;">Linha de Produção</div>'
      + '<div style="' + (S.shake ? 'animation:hfShake .4s;' : '') + '"><div style="display:flex; justify-content:center; gap:16px; margin-bottom:10px;">' + dots + '</div></div>'
      + '<div style="min-height:22px; color:#c0352b; font-weight:700; font-size:14px; margin-bottom:14px;">' + esc(S.pinError) + '</div>'
      + '<div style="display:grid; grid-template-columns:repeat(3,1fr); gap:clamp(10px,1.8vw,15px); max-width:320px; margin:0 auto;">' + kp + '</div>'
      + '<div style="margin-top:22px; font-size:12.5px; color:#566681; font-weight:500;">Toque seu PIN de 4 dígitos para entrar</div>'
      + '</div>';
  }

  // ── HOME (topbar + conteúdo rolável) ───────────────────────
  function homeKey() {
    var t = (S.myTasks || []).map(function (x) { return x.id + ':' + x.slug + ':' + (x.batch_number || ''); }).join(',');
    var tm = (S.team || []).map(function (o) { return o.id + ':' + (o.current_event_id || '') + ':' + (o.online ? 1 : 0) + ':' + (o.current_slug || '') + ':' + (o.current_batch || '') + ':' + ((o.bg_tasks || []).map(function (b) { return b.event_id; }).join('-')); }).join(',');
    var det = (S.emsDetected ? S.emsDetected.ems_key : '') + '|' + (S.detectBusy ? 1 : 0); // FASE FORM
    var pz = (S.myTasks || []).filter(function (x) { return x.is_paused; }).length + '|' + (S.resumeBusy ? 1 : 0); // FASE PAUSA
    return 'home|' + S.completedToday + '|' + S.goal + '|' + t + '|' + tm + '|' + (S.settings.aging ? S.settings.warnMin + '-' + S.settings.overMin : 0) + '|' + det + '|' + pz;
  }
  // FASE FORM — card de detecção passiva (SUGESTÃO, nunca obrigação — REGRA #0).
  // Aparece embaixo das tarefas quando o EMS mostra ESTE operador numa máquina.
  // 1 toque cria a task com tempo do TOQUE. Some quando registra ou some do EMS.
  function emsDetectCard() {
    var d = S.emsDetected; if (!d) return '';
    // Parte 1/C2 (texto humano): em MÁQUINA → "Você está na {máquina amigável}…";
    // em STAGE sem máquina → "Você está {pesando/misturando/encapsulando/revisando}…".
    var frase;
    if (d.is_machine) {
      frase = 'Você está na <b>' + esc(d.machine_label || 'máquina') + '</b>'
        + (d.product_name ? ', fazendo <b>' + esc(d.product_name) + '</b>' : '');
    } else {
      var verb = STAGE_VERB[d.stage] || 'trabalhando em';
      frase = 'Você está <b>' + esc(verb) + '</b>' + (d.product_name ? ' <b>' + esc(d.product_name) + '</b>' : '');
    }
    frase += (d.batch_number ? ', lote <b>' + esc(d.batch_number) + '</b>' : '') + '.';
    var fb = svgr('<rect x="2" y="7" width="20" height="14" rx="2"></rect><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"></path>', 18, 1.8);
    var thumb = d.product_image
      ? '<span style="flex:none; width:42px; height:42px; border-radius:12px; background:rgba(15,40,90,.07); display:flex; align-items:center; justify-content:center; overflow:hidden; position:relative; color:#1f5fd0;"><span style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center;">' + fb + '</span><img src="' + esc(d.product_image) + '" loading="lazy" width="38" height="38" alt="" style="position:relative; width:38px; height:38px; object-fit:contain;" onerror="this.style.display=\'none\'"></span>'
      : '<span style="flex:none; width:42px; height:42px; border-radius:12px; display:flex; align-items:center; justify-content:center; background:rgba(47,122,224,.12); color:#1f5fd0;">🏭</span>';
    var h = '<div style="background:linear-gradient(135deg,rgba(47,122,224,.09),rgba(47,122,224,.04)); border:1px solid rgba(47,122,224,.28); border-radius:20px; padding:15px 16px; display:flex; flex-direction:column; gap:11px;">';
    h += '<div style="display:flex; align-items:flex-start; gap:12px;">' + thumb + '<div style="flex:1; min-width:0;"><div style="font-size:12px; font-weight:800; letter-spacing:.03em; text-transform:uppercase; color:#1f5fd0;">🏭 O sistema detectou</div>'
      + '<div style="font-size:14.5px; font-weight:500; color:#0c2545; margin-top:4px; line-height:1.4;">' + frase + '</div></div></div>';
    h += '<button data-act="registerDetected" ' + (S.detectBusy ? 'disabled' : '') + ' style="border:0; cursor:pointer; border-radius:14px; padding:13px; background:linear-gradient(135deg,#3a86ee,#1f5fd0); color:#fff; font-weight:800; font-size:15px; font-family:\'Sora\',sans-serif; box-shadow:0 14px 30px -16px rgba(31,95,208,.7); display:flex; align-items:center; justify-content:center; gap:8px;">' + svgr(CHECK, 18, 2.6) + (S.detectBusy ? 'Registrando…' : 'Registrar') + '</button>';
    h += '<div style="font-size:11px; color:#566681; text-align:center;">Sugestão do sistema — você confirma e escolhe a hora. Pode ignorar.</div>';
    h += '</div>';
    return h;
  }
  // FASE PAUSA — operador em pausa: banner com nota + "Voltar ao trabalho".
  // Terminar a pausa descongela todos os processos (backend resumePausedFor).
  function pauseTask() { return (S.myTasks || []).find(function (t) { return t.slug === 'break'; }) || null; }
  function pauseBanner() {
    var pt = pauseTask(); if (!pt) return '';
    var note = (pt.description || '').replace(/\s*\|\s*fim:.*/i, '').trim();
    var frozen = (S.myTasks || []).filter(function (t) { return t.is_paused; }).length;
    var h = '<div style="background:linear-gradient(135deg,rgba(217,145,0,.16),rgba(217,145,0,.07)); border:1px solid rgba(217,145,0,.4); border-radius:20px; padding:16px 18px; display:flex; flex-direction:column; gap:12px;">';
    h += '<div style="display:flex; align-items:center; gap:12px;"><span style="flex:none; width:46px; height:46px; border-radius:14px; background:rgba(217,145,0,.18); color:#8a5a00; display:flex; align-items:center; justify-content:center; font-size:24px;">⏸️</span><div style="flex:1; min-width:0;"><div style="font-family:\'Sora\',sans-serif; font-weight:800; font-size:18px; color:#0c2545;">Você está em pausa</div>'
      + (note ? '<div style="font-size:13.5px; color:#8a5a00; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(note) + '</div>' : '')
      + (frozen ? '<div style="font-size:12px; color:#8a5a00; margin-top:2px;">' + frozen + ' tarefa(s) congelada(s) · o relógio parou</div>' : '') + '</div></div>';
    h += '<button data-act="resumeWork" data-arg="' + pt.id + '" ' + (S.resumeBusy ? 'disabled' : '') + ' style="border:0; cursor:pointer; border-radius:14px; padding:14px; background:linear-gradient(135deg,#1aa06a,#0e7a4e); color:#fff; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; box-shadow:0 14px 30px -16px rgba(14,122,78,.7); display:flex; align-items:center; justify-content:center; gap:8px;">' + svgr('<polygon points="5 3 19 12 5 21 5 3"></polygon>', 17, 2) + (S.resumeBusy ? 'Retomando…' : 'Voltar ao trabalho') + '</button>';
    h += '</div>';
    return h;
  }
  function homeInner() {
    var p = S.session.person; var ac = accent();
    var circ = 2 * Math.PI * 52; var frac = Math.min(1, S.goal ? S.completedToday / S.goal : 0);
    var dash = (circ * frac).toFixed(1) + ' ' + circ.toFixed(1);
    var h = topbarHTML();
    h += '<div class="hf-scroll" style="position:relative; z-index:3; flex:1; overflow-y:auto; padding:12px 32px 40px;">'
      + '<div style="width:min(100%,1120px); margin:0 auto; display:flex; flex-direction:column; gap:clamp(16px,2vw,22px);">';
    // Item A — banner de SANDBOX (conta de teste do Bruno; tudo some em ~15s)
    if (isSandbox()) h += '<div style="display:flex; align-items:center; gap:10px; background:rgba(10,154,166,.12); border:1px solid rgba(10,154,166,.35); border-radius:16px; padding:12px 16px; color:#06707a; font-weight:700; font-size:14px;"><span style="font-size:18px;">🧪</span>Modo Sandbox · suas tarefas e contagens somem sozinhas em ~15s (nada vai pro Slack, métricas ou equipe).</div>';
    h += pauseBanner(); // FASE PAUSA — banner "em pausa" + voltar ao trabalho
    // hero
    h += '<div style="display:grid; grid-template-columns:1fr auto; gap:24px; align-items:center; background:rgba(255,255,255,.62); backdrop-filter:blur(22px) saturate(1.4); border:1px solid rgba(255,255,255,.8); border-radius:30px; padding:clamp(22px,3vw,34px) clamp(22px,3.2vw,38px); box-shadow:0 30px 70px -34px rgba(15,40,90,.42), inset 0 1px 0 rgba(255,255,255,.85);">'
      + '<div style="min-width:0;"><div style="font-size:14px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:' + ac + '; opacity:.9;">' + esc(phaseLabel()) + ' · <span id="hf-clock">' + esc(clockNow()) + '</span></div>'
      + '<div id="hf-greet" style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:clamp(28px,4.4vw,46px); line-height:1.05; margin:6px 0 4px; color:#0c2545;">' + esc(greetingTxt()) + ', ' + esc(p.display_name) + '</div>'
      + '<div id="hf-date" style="font-size:15px; color:#5a6e87; text-transform:capitalize; font-weight:500;">' + esc(dateNow()) + '</div></div>'
      + '<div style="position:relative; width:clamp(118px,13vw,150px); height:clamp(118px,13vw,150px); display:flex; align-items:center; justify-content:center;"><svg viewBox="0 0 120 120" style="width:100%; height:100%; transform:rotate(-90deg);"><circle cx="60" cy="60" r="52" fill="none" stroke="rgba(15,40,90,.1)" stroke-width="11"></circle><circle cx="60" cy="60" r="52" fill="none" stroke="' + ac + '" stroke-width="11" stroke-linecap="round" stroke-dasharray="' + dash + '" style="transition:stroke-dasharray .8s cubic-bezier(.2,.8,.2,1); filter:drop-shadow(0 0 6px rgba(14,122,78,.4));"></circle></svg>'
      + '<div style="position:absolute; text-align:center;"><div style="font-family:\'Sora\',sans-serif; font-weight:800; font-size:clamp(26px,3vw,34px); color:#0c2545; line-height:1;">' + S.completedToday + '</div><div style="font-size:12px; font-weight:600; color:#566681;">de ' + S.goal + ' hoje</div></div></div></div>';
    // CTA
    h += '<button data-act="startFlow" style="position:relative; overflow:hidden; border:0; cursor:pointer; border-radius:26px; padding:clamp(22px,2.8vw,30px) 28px; background:linear-gradient(135deg, color-mix(in srgb, var(--accent) 88%, #19c277) 0%, var(--accent) 100%); color:#fff; box-shadow:0 26px 50px -18px color-mix(in srgb, var(--accent) 60%, transparent), inset 0 1px 0 rgba(255,255,255,.3); display:flex; align-items:center; justify-content:center; gap:16px;"><span style="position:absolute; top:0; left:0; width:40%; height:100%; background:linear-gradient(100deg, transparent, rgba(255,255,255,.28), transparent); animation:hfSheen 5s ease-in-out infinite; pointer-events:none;"></span><span style="display:flex; align-items:center; justify-content:center; width:clamp(40px,4.4vw,52px); height:clamp(40px,4.4vw,52px); border-radius:50%; background:rgba(255,255,255,.2);">' + svgr('<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>', 26, 2.4) + '</span><span style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:clamp(20px,2.6vw,27px); letter-spacing:.01em;">Iniciar Tarefa</span></button>';
    // colunas
    h += '<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(290px,1fr)); gap:clamp(16px,2vw,22px);">';
    h += '<div><div style="display:flex; align-items:center; gap:10px; margin:0 4px 12px;"><span style="color:#0f4c92;">' + svgr('<path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>', 19, 1.9) + '</span><h2 style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:17px; color:#0c2545;">Minhas tarefas</h2></div><div style="display:flex; flex-direction:column; gap:11px;">';
    if (!S.myTasks.length) h += '<div style="background:rgba(255,255,255,.5); border:1px dashed rgba(15,40,90,.18); border-radius:18px; padding:22px; text-align:center; color:#566681; font-weight:500; font-size:14px;">Nenhuma tarefa aberta. Toque em Iniciar Tarefa.</div>';
    S.myTasks.forEach(function (t) {
      if (t.slug === 'break') return; // FASE PAUSA: a pausa vive no banner, não na lista
      // tarefa congelada (pausa ativa): relógio para, sem aging, badge "Pausada"
      if (t.is_paused) {
        var prodP = t.product || t.supplement || t.supplement_name || null;
        var subP = (prodP ? prodP + (t.batch_number ? ' · ' + t.batch_number : '') : (t.batch_number || '')) || labelOf(t.slug);
        var cardP = { display: 'flex', alignItems: 'center', gap: '14px', background: 'rgba(15,40,90,.05)', border: '1px solid rgba(15,40,90,.12)', borderLeft: '4px solid #b08400', borderRadius: '20px', padding: '15px 16px', opacity: '.78' };
        h += '<div style="' + sty(cardP) + '"><span style="flex:none; width:46px; height:46px; border-radius:14px; background:rgba(217,145,0,.14); color:#8a5a00; display:flex; align-items:center; justify-content:center; font-size:22px;">⏸️</span><div style="flex:1; min-width:0;"><div style="font-weight:700; font-size:16px; color:#0c2545;">' + esc(labelOf(t.slug)) + '</div><div style="font-size:13px; color:#5a6e87; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(subP) + '</div><div style="display:inline-flex; align-items:center; gap:6px; margin-top:7px; font-size:11.5px; font-weight:800; color:#8a5a00; background:rgba(217,145,0,.13); padding:3px 9px; border-radius:7px;">Pausada · relógio parado</div></div></div>';
        return;
      }
      // background (na máquina: encapsulação/mistura/tablete) roda longo de
      // propósito → NÃO envelhece (sem badge "demorando"); ganha pill própria.
      var isBg = !!t.is_long_running;
      var a = isBg ? 'ok' : ageState(t.started_at); var ag = AGE[a];
      var prod = t.product || t.supplement || t.supplement_name || null;
      var sub = (prod ? prod + (t.batch_number ? ' · ' + t.batch_number : '') + ' · ' : (t.batch_number ? t.batch_number + ' · ' : '')) + 'há ' + fmtDur(t.started_at);
      var card = { display: 'flex', alignItems: 'center', gap: '14px', background: 'rgba(255,255,255,.74)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,.85)', borderLeft: '4px solid ' + ag.border, borderRadius: '20px', padding: '15px 16px', boxShadow: ag.glow, transition: 'box-shadow .5s, border-color .5s' };
      var ico = { flex: 'none', width: '46px', height: '46px', borderRadius: '14px', background: ag.icoBg, color: ag.ico, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background .5s, color .5s' };
      h += '<div style="' + sty(card) + '"><span style="' + sty(ico) + '">' + svg(iconPath(t.slug), 24) + '</span><div style="flex:1; min-width:0;"><div style="font-weight:700; font-size:16px; color:#0c2545;">' + esc(labelOf(t.slug)) + '</div><div style="font-size:13px; color:#5a6e87; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(sub) + '</div>'
        + (isBg
            ? '<div style="display:inline-flex; align-items:center; gap:6px; margin-top:7px; font-size:11.5px; font-weight:800; color:#1f5fd0; background:rgba(47,122,224,.1); padding:3px 9px; border-radius:7px;">⚙ background · na máquina</div>'
            : (a !== 'ok' ? '<div style="display:inline-flex; align-items:center; gap:6px; margin-top:7px; font-size:11.5px; font-weight:800; color:' + ag.ico + '; background:' + (a === 'over' ? 'rgba(192,53,43,.1)' : 'rgba(217,145,0,.13)') + '; padding:3px 9px 3px 7px; border-radius:7px;"><span style="width:7px; height:7px; border-radius:50%; background:' + ag.ico + ';' + (a === 'over' ? 'animation:hfPulse 1.4s ease-in-out infinite;' : '') + '"></span>' + esc(ag.badge) + '</div>' : ''))
        + '</div><button data-act="reclassify" data-arg="' + t.id + '" title="Tipo errado? Trocar" style="flex:none; border:1px solid rgba(15,40,90,.14); cursor:pointer; border-radius:14px; padding:13px 14px; margin-right:8px; background:rgba(255,255,255,.7); color:#42566f; font-weight:800; font-size:15px;">⇄</button><button data-act="finish" data-arg="' + t.id + '" style="flex:none; border:0; cursor:pointer; border-radius:14px; padding:13px 18px; background:linear-gradient(135deg,#cf463c,#b3261e); color:#fff; font-weight:700; font-size:14px; box-shadow:0 12px 26px -14px rgba(179,38,30,.7); display:flex; align-items:center; gap:7px;">' + svgr(CHECK, 17, 2.4) + 'Finalizar</button></div>';
    });
    h += emsDetectCard(); // FASE FORM — sugestão passiva: EMS mostra o operador numa máquina
    h += '</div></div>';
    h += '<div><div style="display:flex; align-items:center; gap:10px; margin:0 4px 12px;"><span style="color:#0f4c92;">' + svgr(PEOPLE, 19, 1.9) + '</span><h2 style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:17px; color:#0c2545;">Equipe agora</h2></div><div style="display:flex; flex-direction:column; gap:11px;">';
    // inclui quem só tem BACKGROUND ao vivo (antes ficava de fora — feed pegava só foreground)
    var others = (S.team || []).filter(function (o) { return o.id !== p.id && (o.current_event_id || (Array.isArray(o.bg_tasks) && o.bg_tasks.length)); });
    if (!others.length) h += '<div style="background:rgba(255,255,255,.5); border:1px dashed rgba(15,40,90,.18); border-radius:18px; padding:22px; text-align:center; color:#566681; font-weight:500; font-size:14px;">Ninguém com tarefa aberta agora.</div>';
    others.forEach(function (o) {
      var hasFg = !!o.current_event_id;
      var bg = Array.isArray(o.bg_tasks) ? o.bg_tasks : [];
      var inCw = Array.isArray(o.current_cowork) && o.current_cowork.indexOf(p.id) >= 0;
      var a = hasFg ? ageState(o.current_started_at) : 'ok'; var ag = AGE[a];
      // linha principal: foreground se houver; senão a 1ª background ("na máquina")
      // nome do SUPLEMENTO seguido do batch (antes mostrava só o batch). prodBatch helper.
      var prodBatch = function (prod, batch) { return (prod ? prod + (batch ? ' · ' + batch : '') : (batch || '')); };
      var mainSub = hasFg
        ? (labelOf(o.current_slug) + ((o.current_product || o.current_batch) ? ' · ' + prodBatch(o.current_product, o.current_batch) : '') + ' · há ' + fmtDur(o.current_started_at) + (Array.isArray(o.current_cowork) && o.current_cowork.length ? ' · em grupo' : ''))
        : ('⚙ na máquina: ' + labelOf(bg[0].slug) + ((bg[0].product || bg[0].batch) ? ' · ' + prodBatch(bg[0].product, bg[0].batch) : '') + ' · há ' + fmtDur(bg[0].started_at));
      // pills das background extras (se bg-only, a 1ª já vai na linha principal)
      var bgPills = '';
      for (var bi = (hasFg ? 0 : 1); bi < bg.length; bi++) {
        bgPills += '<span style="display:inline-flex; align-items:center; gap:4px; margin:6px 6px 0 0; font-size:10.5px; font-weight:700; color:#1f5fd0; background:rgba(47,122,224,.1); padding:2px 8px; border-radius:7px;">⚙ ' + esc(labelOf(bg[bi].slug)) + ((bg[bi].product || bg[bi].batch) ? ' · ' + esc(prodBatch(bg[bi].product, bg[bi].batch)) : '') + '</span>';
      }
      var card = { display: 'flex', alignItems: 'center', gap: '13px', background: 'rgba(255,255,255,.66)', backdropFilter: 'blur(16px)', border: a === 'ok' ? '1px solid rgba(255,255,255,.82)' : '1px solid ' + ag.border, borderLeft: a === 'ok' ? '1px solid rgba(255,255,255,.82)' : '4px solid ' + ag.border, borderRadius: '20px', padding: '14px 16px', boxShadow: a === 'ok' ? '0 16px 38px -26px rgba(15,40,90,.42)' : ag.glow, transition: 'box-shadow .5s, border-color .5s' };
      h += '<div style="' + sty(card) + '"><span style="position:relative; flex:none; width:44px; height:44px; border-radius:50%; background:linear-gradient(140deg,#5a6e87,#42566f); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:14px;">' + esc(D.initials(o.display_name)) + '<span style="position:absolute; right:-1px; bottom:-1px; width:13px; height:13px; border-radius:50%; border:2px solid #fff; background:' + (o.online ? '#21a85b' : '#b3bccb') + ';"></span></span><div style="flex:1; min-width:0;"><div style="font-weight:700; font-size:15px; color:#0c2545;">' + esc(o.display_name) + '</div><div style="font-size:12.5px; color:#5a6e87; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(mainSub) + '</div>'
        + (hasFg && a !== 'ok' ? '<div style="display:inline-flex; align-items:center; gap:6px; margin-top:6px; font-size:11px; font-weight:800; color:' + ag.ico + '; background:' + (a === 'over' ? 'rgba(192,53,43,.1)' : 'rgba(217,145,0,.13)') + '; padding:2px 9px 2px 7px; border-radius:7px;"><span style="width:6px; height:6px; border-radius:50%; background:' + ag.ico + ';' + (a === 'over' ? 'animation:hfPulse 1.4s ease-in-out infinite;' : '') + '"></span>' + esc(a === 'over' ? 'Precisa de ajuda' : 'Demorando') + '</div>' : '')
        + bgPills
        + '</div>'
        + (hasFg
          ? (inCw
            ? '<button style="flex:none; border:1px solid rgba(15,40,90,.14); cursor:default; border-radius:13px; padding:11px 16px; background:rgba(15,40,90,.05); color:#566681; font-weight:700; font-size:13px;">Já junto</button>'
            : '<button data-act="join" data-arg="' + o.current_event_id + '" data-name="' + esc(o.display_name) + '" data-sub="' + esc(labelOf(o.current_slug) + ((o.current_product || o.current_batch) ? ' · ' + prodBatch(o.current_product, o.current_batch) : '')) + '" style="flex:none; border:0; cursor:pointer; border-radius:13px; padding:11px 16px; background:rgba(47,122,224,.12); color:#1f5fd0; font-weight:700; font-size:13px; display:flex; align-items:center; gap:6px;">' + svgr(PEOPLE, 14, 2) + 'Entrar</button>')
          : '')
        + '</div>';
    });
    h += '</div></div></div>';
    h += '<button data-act="note" style="align-self:center; margin-top:2px; border:1px solid rgba(255,255,255,.8); cursor:pointer; border-radius:16px; padding:13px 22px; background:rgba(255,255,255,.55); backdrop-filter:blur(14px); color:#42566f; font-weight:600; font-size:14px; display:flex; align-items:center; gap:10px; box-shadow:0 10px 26px -18px rgba(15,40,90,.4);">' + svgr(EDITP, 18, 1.8) + 'Nota rápida / Voz</button>';
    h += '</div></div>';
    return h;
  }

  // ── helpers de domínio ─────────────────────────────────────
  function labelOf(slug) {
    var q = (DATA.quick || []).find(function (x) { return x.slug === slug; }); if (q) return q.label;
    for (var i = 0; i < (DATA.groups || []).length; i++) { var t = (DATA.groups[i].types || []).find(function (x) { return x.slug === slug; }); if (t) return t.label; }
    return slug || '—';
  }
  function typeMeta(slug) {
    for (var i = 0; i < (DATA.groups || []).length; i++) { var t = (DATA.groups[i].types || []).find(function (x) { return x.slug === slug; }); if (t) return t; }
    var qq = (DATA.quick || []).find(function (x) { return x.slug === slug; }); return qq || { slug: slug };
  }

  // ════════════════════════════════════════════════════════════
  // FLOW — casca montada UMA vez; crumbs + corpo trocam por dentro
  // (sem re-pop do modal a cada passo = sem blink)
  // ════════════════════════════════════════════════════════════
  function mountFlow() {
    var L = LYR.flow;
    if (S.flow) {
      if (!L.on) { L.el.innerHTML = flowShellHTML(); L.el.classList.add('on'); L.on = true; }
      var cr = L.el.querySelector('#flow-crumbs'); if (cr) cr.innerHTML = crumbHTML(S.flow);
      var bd = L.el.querySelector('#flow-body'); if (bd) { bd.innerHTML = flowBody(S.flow); restoreFocus(bd); }
    } else if (L.on) { L.el.classList.remove('on'); L.on = false; }
  }
  function flowCrumbs(f) {
    var step = f.step, rp = !!f.requires_product;
    var c = [
      { label: 'Grupo', active: step === 'group', done: ['type', 'supp', 'batch', 'confirm', 'finished'].indexOf(step) >= 0 },
      { label: 'Tarefa', active: step === 'type', done: ['supp', 'batch', 'confirm', 'finished'].indexOf(step) >= 0 },
    ];
    if (rp) {
      c.push({ label: 'Produto', active: step === 'supp', done: ['batch', 'confirm', 'finished'].indexOf(step) >= 0 });
      c.push({ label: 'Lote', active: step === 'batch', done: ['confirm', 'finished'].indexOf(step) >= 0 });
    }
    c.push({ label: 'Confirmar', active: step === 'confirm' || step === 'finished', done: false });
    return c;
  }
  function crumbHTML(f) {
    var ac = accent();
    return flowCrumbs(f).map(function (c) {
      var dot = { flex: 'none', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: c.done ? ac : (c.active ? 'color-mix(in srgb,' + ac + ' 18%, white)' : 'rgba(15,40,90,.08)'), color: c.done ? '#fff' : (c.active ? ac : '#566681'), border: (c.active && !c.done) ? '2px solid ' + ac : '0' };
      var txt = { fontSize: '12.5px', fontWeight: c.active ? '700' : '600', color: c.active ? '#0c2545' : '#566681', whiteSpace: 'nowrap' };
      return '<div style="display:flex; align-items:center; gap:7px;"><span style="' + sty(dot) + '">' + (c.done ? svgr(CHECK, 12, 3.4) : '') + '</span><span style="' + sty(txt) + '">' + esc(c.label) + '</span></div>';
    }).join('');
  }
  function flowShellHTML() {
    return '<div class="hf-scroll" style="position:relative; width:800px; max-width:97%; max-height:846px; overflow-y:auto; background:rgba(255,255,255,.84); backdrop-filter:blur(30px) saturate(1.5); border:1px solid rgba(255,255,255,.85); border-radius:30px; box-shadow:0 50px 110px -40px rgba(12,37,69,.6), inset 0 1px 0 rgba(255,255,255,.9); animation:hfPop .35s cubic-bezier(.2,.8,.2,1) both;">'
      + '<div style="position:sticky; top:0; z-index:2; display:flex; align-items:center; gap:14px; padding:clamp(16px,2.4vw,22px) clamp(18px,2.8vw,28px); background:linear-gradient(rgba(255,255,255,.86), rgba(255,255,255,.5)); backdrop-filter:blur(10px); border-bottom:1px solid rgba(15,40,90,.07); border-radius:30px 30px 0 0;"><div id="flow-crumbs" style="flex:1; display:flex; align-items:center; gap:clamp(8px,1.4vw,16px); flex-wrap:wrap; min-width:0;"></div><button data-act="cancelFlow" title="Cancelar" aria-label="Cancelar" style="flex:none; width:40px; height:40px; border-radius:50%; border:1px solid rgba(15,40,90,.12); background:rgba(255,255,255,.7); color:#6c819b; cursor:pointer; display:flex; align-items:center; justify-content:center;">' + svgr('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>', 20, 2.2) + '</button></div>'
      + '<div id="flow-body" style="padding:clamp(18px,2.6vw,28px);"></div></div>';
  }
  function flowBody(f) {
    if (f.step === 'group') return flowGroup();
    if (f.step === 'type') return flowType();
    if (f.step === 'pipeline') return flowPipeline();
    if (f.step === 'supp') return flowSupp();
    if (f.step === 'batch') return flowBatch();
    if (f.step === 'confirm') return flowConfirm();
    if (f.step === 'finished') return flowFinished();
    return '';
  }
  var tileBase = 'display:flex; flex-direction:column; align-items:center; justify-content:center; gap:11px; padding:20px 12px; border-radius:22px; cursor:pointer; text-align:center; transition:transform .1s; font-family:\'Manrope\',sans-serif; color:#0c2545;';
  function flowGroup() {
    var h = '<div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:clamp(20px,2.6vw,26px); color:#0c2545; margin-bottom:18px;">O que você vai fazer?</div><div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(148px,1fr)); gap:clamp(10px,1.4vw,14px);">';
    (DATA.groups || []).forEach(function (g) {
      var ac = GROUP_ACCENT[g.key] || '#0f4c92';
      h += '<button data-act="pickGroup" data-arg="' + esc(g.key) + '" style="' + tileBase + 'min-height:116px; border:1px solid rgba(15,40,90,.1); background:rgba(255,255,255,.74); box-shadow:0 14px 34px -22px rgba(15,40,90,.4);"><span style="flex:none; width:56px; height:56px; border-radius:18px; display:flex; align-items:center; justify-content:center; background:color-mix(in srgb, ' + ac + ' 14%, white); color:' + ac + ';">' + svg(ICONS[GROUP_ICON[g.key] || 'grid'], 28, 1.7) + '</span><span style="font-family:\'Sora\',sans-serif; font-weight:600; font-size:15px; line-height:1.2;">' + esc(g.label) + '</span></button>';
    });
    (DATA.quick || []).forEach(function (q) {
      h += '<button data-act="quickLunch" data-arg="' + esc(q.slug) + '" style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:11px; padding:20px 12px; border-radius:22px; cursor:pointer; min-height:116px; text-align:center; border:0; background:linear-gradient(135deg,#3cc878,#0e7a4e); color:#fff; box-shadow:0 18px 38px -18px rgba(14,122,78,.7);"><span style="flex:none; width:56px; height:56px; border-radius:18px; display:flex; align-items:center; justify-content:center; background:rgba(255,255,255,.22); color:#fff;">' + svg(ICONS.coffee, 28, 1.7) + '</span><span style="font-family:\'Sora\',sans-serif; font-weight:600; font-size:15px;">' + esc(q.label) + '</span></button>';
    });
    h += '</div>'; return h;
  }
  function flowType() {
    var g = (DATA.groups || []).find(function (x) { return x.key === S.flow.groupKey; }) || { types: [], key: '' };
    var gac = GROUP_ACCENT[g.key] || accent();
    var h = '<div style="display:flex; align-items:center; gap:12px; margin-bottom:18px;"><span style="flex:none; width:42px; height:42px; border-radius:13px; background:rgba(15,40,90,.07); color:#0f4c92; display:flex; align-items:center; justify-content:center;">' + svg(ICONS[GROUP_ICON[g.key] || 'grid'], 24, 1.7) + '</span><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:clamp(19px,2.4vw,24px); color:#0c2545;">' + esc(g.label) + '</div></div><div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:clamp(10px,1.4vw,14px);">';
    (g.types || []).forEach(function (t) {
      var other = !!t.other || /_other$/.test(t.slug);
      var ac = other ? '#c77d12' : gac;
      var tile = tileBase + 'min-height:108px; border:' + (other ? '1px solid rgba(199,125,18,.35)' : '1px solid rgba(15,40,90,.1)') + '; background:' + (other ? 'rgba(255,247,234,.78)' : 'rgba(255,255,255,.74)') + '; box-shadow:0 14px 34px -22px rgba(15,40,90,.4);';
      var ico = 'flex:none; width:50px; height:50px; border-radius:15px; display:flex; align-items:center; justify-content:center; background:color-mix(in srgb, ' + ac + ' 14%, white); color:' + ac + ';';
      var lab = 'font-family:\'Sora\',sans-serif; font-weight:600; font-size:15px; line-height:1.2; color:' + (other ? '#8a5a00' : '#0c2545') + ';';
      h += '<button data-act="pickType" data-arg="' + esc(t.slug) + '" style="' + tile + '"><span style="' + ico + '">' + svg(iconPath(t.slug), 25, 1.7) + '</span><span style="' + lab + '">' + esc(t.label) + '</span></button>';
    });
    h += '</div><div style="display:flex; gap:11px; margin-top:22px;">' + backBtn() + '</div>'; return h;
  }
  // FASE 4 + FASE FORM — Step PIPELINE-LIST: lista LOTE+PRODUTO do EMS.
  // Slugs que usam a lista do EMS (vs catálogo direto): linha/revisão +
  // formulação (pesagem/mistura/encapsulação). Cada um filtra os sub-stages
  // certos no backend (/lots/available). Lista vazia → cai pro catálogo.
  var LOT_LIST_SLUGS = { production_line: 1, review: 1, weighing: 1, mixing: 1, encapsulation: 1, fnsku_labeling: 1 };
  function usesLotList(slug) { return !!LOT_LIST_SLUGS[slug]; }
  var STAGE_PT = { encapsulated: 'Encapsulado', encapsulating: 'Encapsulando', ready_for_line: 'Pronto p/ linha', on_line: 'Na linha', yield_review: 'Conferência', to_count: 'A contar', to_separate: 'A separar', label_printing: 'Imprimindo label', pending: 'Na fila', weighing: 'Pesagem', weighed: 'Pesado', blending: 'Mistura', blended: 'Misturado', produced: 'Produzido' };
  // FASE C2 — verbo PT do stage (detecção por stage sem máquina)
  var STAGE_VERB = { weighing: 'pesando', weighed: 'pesando', blending: 'misturando', blended: 'misturando', encapsulating: 'encapsulando', encapsulated: 'encapsulando', yield_review: 'revisando', to_count: 'contando', to_separate: 'separando', label_printing: 'imprimindo label' };
  function lotCard(l) {
    var fbIcon = svgr('<path d="M5 8l7-4 7 4-7 4zM5 8v8l7 4 7-4V8"></path>', 18, 1.8);
    var thumb = l.product_image
      ? '<span style="flex:none; width:40px; height:40px; border-radius:11px; background:rgba(15,40,90,.07); display:flex; align-items:center; justify-content:center; overflow:hidden; position:relative; color:#5a6e87;"><span style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center;">' + fbIcon + '</span><img src="' + esc(l.product_image) + '" loading="lazy" width="36" height="36" alt="" style="position:relative; width:36px; height:36px; object-fit:contain;" onerror="this.style.display=\'none\'"></span>'
      : '<span style="flex:none; width:40px; height:40px; border-radius:11px; display:flex; align-items:center; justify-content:center; background:rgba(15,40,90,.07); color:#5a6e87;">' + fbIcon + '</span>';
    var st = STAGE_PT[l.stage] || l.stage || '';
    var bd = l.is_related ? '1px solid rgba(31,95,208,.4)' : '1px solid rgba(15,40,90,.12)';
    var bg = l.is_related ? 'rgba(47,122,224,.06)' : 'rgba(255,255,255,.72)';
    return '<button data-act="pickLot" data-arg="' + esc(l.batch_number) + '" data-prod="' + esc(l.product_name || '') + '" style="display:flex; align-items:center; gap:11px; text-align:left; cursor:pointer; padding:12px 13px; border-radius:15px; border:' + bd + '; background:' + bg + '; font-family:\'Manrope\',sans-serif;">' + thumb + '<span style="flex:1; min-width:0;"><span style="display:block; font-weight:700; font-size:15px; color:#0c2545; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(l.product_name || 'Produto') + '</span><span style="display:block; font-size:12.5px; color:#5a6e87; margin-top:1px;">' + esc(l.batch_number) + (st ? ' · ' + esc(st) : '') + '</span></span></button>';
  }
  function flowPipeline() {
    var lots = S.flow.lots; // null=carregando, []=nenhum
    var q = (S.flow.lotQuery || '').trim().toLowerCase();
    var filtered = Array.isArray(lots) ? lots.filter(function (l) { return !q || ((l.batch_number || '') + ' ' + (l.product_name || '')).toLowerCase().indexOf(q) >= 0; }) : [];
    var gridOpen = '<div class="hf-scroll" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:9px;">';
    var sectionHead = function (txt, color) { return '<div style="grid-column:1/-1; font-size:12px; font-weight:800; letter-spacing:.04em; text-transform:uppercase; color:' + color + '; margin:2px 2px 0;">' + txt + '</div>'; };
    var empty = function (t) { return '<div style="color:#566681; font-size:14px; text-align:center; padding:18px;">' + t + '</div>'; };
    var body = '';
    if (lots == null) body = empty('Carregando lotes do EMS…');
    else if (!lots.length) body = empty('Nenhum lote disponível no EMS agora. Use o catálogo completo abaixo. 👇');
    else if (!filtered.length) body = empty('Nada bate com a busca.');
    else {
      // FASE LISTA: relacionados ("🎯 Prováveis pra esta tarefa") no TOPO; resto
      // da linha ("📋 Outros em produção") abaixo. Busca filtra ambas seções.
      var related = filtered.filter(function (l) { return l.is_related; }).slice(0, 30);
      var others = filtered.filter(function (l) { return !l.is_related; }).slice(0, 30);
      body = '<div style="max-height:392px; overflow-y:auto;">';
      if (related.length) body += gridOpen + sectionHead('🎯 Prováveis pra esta tarefa', '#1f5fd0') + related.map(lotCard).join('') + '</div>';
      if (others.length) body += gridOpen + sectionHead('📋 Outros em produção', '#566681') + others.map(lotCard).join('') + '</div>';
      body += '</div>';
    }
    var h = '<div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:clamp(19px,2.4vw,24px); color:#0c2545; margin-bottom:14px;">Qual lote?</div>';
    h += '<div style="position:relative; margin-bottom:12px;"><span style="position:absolute; left:16px; top:50%; transform:translateY(-50%); color:#566681;">' + svgr('<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line>', 20, 2) + '</span><input value="' + esc(S.flow.lotQuery || '') + '" data-input="lotQuery" data-focus="lotQuery" placeholder="Buscar lote ou produto…" style="width:100%; min-height:56px; font-size:17px; padding:12px 16px 12px 46px; border:1px solid rgba(15,40,90,.16); border-radius:16px; background:rgba(255,255,255,.9); color:#0c2545; outline:none;"></div>';
    if (S.flow.emsStale) h += '<div style="font-size:12.5px; color:#8a5a00; background:rgba(217,145,0,.12); border-left:3px solid #d99100; padding:9px 12px; border-radius:10px; margin-bottom:10px;">EMS indisponível — lista pode estar desatualizada. Use o catálogo se não achar.</div>';
    h += body;
    h += '<button data-act="pickCatalog" style="margin-top:14px; width:100%; border:1px dashed rgba(15,40,90,.22); background:rgba(255,255,255,.5); color:#42566f; border-radius:14px; padding:13px; font-weight:600; font-size:14px; cursor:pointer;">Não achou na lista? Buscar no catálogo completo →</button>';
    h += '<div style="display:flex; gap:11px; margin-top:14px;">' + backBtn() + '</div>';
    return h;
  }
  function flowSupp() {
    var list = SM.searchSupplements(DATA.supplements, S.flow.query || '');
    var rows = '';
    var qnorm = (S.flow.query || '').trim();
    if (qnorm && !list.some(function (p) { return p.canonical_name.toLowerCase() === qnorm.toLowerCase(); })) {
      rows += '<button data-act="pickSupp" data-arg="' + esc(qnorm) + '" data-new="1" style="display:flex; align-items:center; gap:12px; width:100%; text-align:left; cursor:pointer; padding:13px 15px; border-radius:14px; border:1px dashed ' + accent() + '; background:color-mix(in srgb,' + accent() + ' 7%, white); font-family:\'Manrope\',sans-serif;"><span style="flex:none; width:34px; height:34px; border-radius:10px; display:flex; align-items:center; justify-content:center; background:' + accent() + '; color:#fff;">' + svgr('<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>', 18, 2.2) + '</span><span style="flex:1; min-width:0; font-weight:600; font-size:16px; color:#0c2545;">Adicionar “' + esc(qnorm) + '”</span></button>';
    }
    var fallbackIcon = svgr('<path d="M5 8l7-4 7 4-7 4zM5 8v8l7 4 7-4V8"></path>', 18, 1.8);
    // ícone genérico ATRÁS + img ON TOP; onerror só esconde a img (imagem quebrada
    // → o ícone reaparece). Imagens EMS são .jpg opacas, então não vazam o fundo.
    list.forEach(function (p) {
      var b = bottleFor(p.canonical_name) || (S.prodImg && S.prodImg[p.id]) || null; // PNG local → imagem EMS → ?
      var thumb = b
        ? '<span style="flex:none; width:34px; height:34px; border-radius:10px; background:rgba(15,40,90,.07); display:flex; align-items:center; justify-content:center; overflow:hidden; position:relative; color:#5a6e87;"><span style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center;">' + fallbackIcon + '</span><img src="' + esc(b) + '" loading="lazy" width="30" height="30" alt="" style="position:relative; width:30px; height:30px; object-fit:contain;" onerror="this.style.display=\'none\'"></span>'
        : '<span style="flex:none; width:34px; height:34px; border-radius:10px; display:flex; align-items:center; justify-content:center; background:rgba(15,40,90,.07); color:#5a6e87;">' + fallbackIcon + '</span>';
      rows += '<button data-act="pickSupp" data-arg="' + esc(p.canonical_name) + '" data-pid="' + esc(p.id != null ? p.id : '') + '" style="display:flex; align-items:center; gap:12px; width:100%; text-align:left; cursor:pointer; padding:13px 15px; border-radius:14px; border:1px solid rgba(15,40,90,.1); background:rgba(255,255,255,.7); font-family:\'Manrope\',sans-serif;">' + thumb + '<span style="flex:1; min-width:0; font-weight:600; font-size:16px; color:#0c2545;">' + esc(p.canonical_name) + '</span></button>';
    });
    return '<div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:clamp(19px,2.4vw,24px); color:#0c2545; margin-bottom:16px;">Qual suplemento?</div>'
      + '<div style="position:relative; margin-bottom:14px;"><span style="position:absolute; left:16px; top:50%; transform:translateY(-50%); color:#566681;">' + svgr('<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line>', 20, 2) + '</span><input value="' + esc(S.flow.query || '') + '" data-input="query" data-focus="query" placeholder="Digite o nome do suplemento…" style="width:100%; min-height:58px; font-size:17px; padding:12px 16px 12px 46px; border:1px solid rgba(15,40,90,.16); border-radius:16px; background:rgba(255,255,255,.9); color:#0c2545; outline:none;"></div>'
      + '<div class="hf-scroll" style="display:flex; flex-direction:column; gap:8px; max-height:378px; overflow-y:auto;">' + rows + '</div>'
      + '<div style="display:flex; gap:11px; margin-top:18px;">' + backBtn() + '</div>';
  }
  function relDate(iso) {
    if (!iso) return '';
    var then = new Date(iso).getTime(); if (isNaN(then)) return '';
    var days = Math.floor((Date.now() - then) / 86400000);
    if (days <= 0) return 'hoje';
    if (days === 1) return 'ontem';
    if (days < 7) return 'há ' + days + ' dias';
    if (days < 14) return 'semana passada';
    if (days < 30) return 'há ' + Math.floor(days / 7) + ' semanas';
    if (days < 60) return 'mês passado';
    return 'há ' + Math.floor(days / 30) + ' meses';
  }
  function flowBatch() {
    var list = S.flow.recentBatches; // null=carregando, []=nenhum, [...]=lotes do produto
    var rec = '';
    if (list == null) {
      rec = '<span style="font-size:13px; color:#566681;">Carregando lotes recentes…</span>';
    } else if (list.length === 0) {
      rec = '<span style="font-size:13px; color:#566681;">Sem lotes recentes deste produto — digite o número acima.</span>';
    } else {
      list.slice(0, 8).forEach(function (r) {
        var bn = r.batch_number || r;
        var rel = relDate(r.last_seen);
        var tip = [r.last_operator ? 'Por ' + r.last_operator : '', r.status_in_ems ? 'EMS: ' + r.status_in_ems : ''].filter(Boolean).join(' · ');
        rec += '<button data-act="pickBatch" data-arg="' + esc(bn) + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + ' style="display:flex; flex-direction:column; align-items:flex-start; gap:1px; border:1px solid rgba(15,40,90,.14); background:rgba(255,255,255,.7); color:#0c2545; border-radius:13px; padding:9px 15px; cursor:pointer; font-family:\'Sora\',sans-serif;"><span style="font-weight:700; font-size:15px;">' + esc(bn) + '</span>' + (rel ? '<span style="font-weight:600; font-size:11px; color:#566681;">' + esc(rel) + '</span>' : '') + '</button>';
      });
    }
    return '<div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:clamp(19px,2.4vw,24px); color:#0c2545; margin-bottom:6px;">Qual lote?</div><div style="font-size:14px; color:#5a6e87; margin-bottom:16px;">Digite os 4 números (ex: 0190) ou escolha um recente.</div>'
      + '<input value="' + esc(S.flow.batchInput || '') + '" data-input="batch" data-focus="batch" inputmode="numeric" placeholder="0190" style="width:100%; min-height:62px; font-size:24px; font-weight:700; letter-spacing:.08em; text-align:center; padding:12px 16px; border:1px solid rgba(15,40,90,.16); border-radius:16px; background:rgba(255,255,255,.9); color:#0c2545; outline:none; margin-bottom:14px; font-family:\'Sora\',sans-serif;">'
      + '<div style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:#566681; margin-bottom:10px;">Recentes' + (S.flow.supplement ? ' de ' + esc(S.flow.supplement) : '') + '</div><div style="display:flex; flex-wrap:wrap; gap:9px; align-items:center;">' + rec + '</div>'
      + '<div style="display:flex; gap:11px; margin-top:22px;">' + backBtn() + '<button data-act="skipBatch" style="flex:1; border:1px solid rgba(15,40,90,.14); background:rgba(255,255,255,.6); color:#42566f; border-radius:16px; padding:15px; font-weight:700; font-size:15px; cursor:pointer;">Sem lote</button><button data-act="batchOk" style="flex:1.4; border:0; background:linear-gradient(135deg, color-mix(in srgb, var(--accent) 88%, #19c277), var(--accent)); color:#fff; border-radius:16px; padding:15px; font-weight:700; font-size:15px; cursor:pointer; box-shadow:0 12px 26px -14px color-mix(in srgb, var(--accent) 60%, transparent);">Confirmar lote</button></div>';
  }
  function chip(kind, txt, inner) { var c = kind === 'blue' ? '#1f5fd0' : '#0e7a4e'; var bg = kind === 'blue' ? 'rgba(47,122,224,.1)' : 'rgba(14,122,78,.1)'; return '<span style="display:inline-flex; align-items:center; gap:5px; font-size:12.5px; font-weight:700; color:' + c + '; background:' + bg + '; padding:4px 10px; border-radius:8px;">' + svgr(inner, 13, 2) + esc(txt) + '</span>'; }
  function flowConfirm() {
    var f = S.flow; var meta = typeMeta(f.slug);
    var noteReq = !!meta.note_required; var ordersReq = !!meta.orders_required;
    var ac = accent();
    var h = '<div style="display:flex; align-items:center; gap:14px; background:rgba(255,255,255,.66); border:1px solid rgba(15,40,90,.1); border-left:4px solid var(--accent); border-radius:20px; padding:16px; margin-bottom:20px;"><span style="flex:none; width:50px; height:50px; border-radius:15px; background:color-mix(in srgb, var(--accent) 13%, white); color:var(--accent); display:flex; align-items:center; justify-content:center;">' + svg(iconPath(f.slug), 26, 1.7) + '</span><div style="flex:1; min-width:0;"><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:18px; color:#0c2545;">' + esc(labelOf(f.slug)) + '</div><div style="display:flex; flex-wrap:wrap; gap:7px; margin-top:6px;">' + (f.supplement ? chip('blue', f.supplement, '<path d="M21 8l-9-5-9 5 9 5 9-5z"></path><path d="M3 8v8l9 5 9-5V8"></path>') : '') + (f.batch ? chip('green', f.batch, '<line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line>') : '') + '</div></div></div>';
    h += sectionLabel('Quando começou?', CLOCK, 2.1);
    h += '<div style="display:flex; gap:11px; margin-bottom:14px;"><button data-act="modeNow" style="' + segBtn(!f.forgot, ac) + '">' + svgr(PLAY, 14, 0, 'currentColor') + 'Agora</button><button data-act="modeForgot" style="' + segBtn(f.forgot, ac) + '">' + svgr(CLOCK, 15, 2.1) + 'Esqueci de marcar</button></div>';
    if (f.forgot) {
      normalizeAP(f);
      var ss = startStatus(f); var sw = startWindow();
      h += '<div style="background:rgba(15,40,90,.04); border-radius:16px; padding:14px; margin-bottom:18px;"><div style="display:flex; gap:9px; align-items:center;">' + timeSelect('tpH', f.tpH, 'h', sw, f.tpAP) + timeSelect('tpM', f.tpM, 'm') + apButton('toggleAP', f.tpAP, sw) + '</div><div style="min-height:20px; margin-top:9px; font-size:14px; font-weight:700; color:' + ss.color + ';">' + esc(ss.text) + '</div></div>';
    }
    h += sectionLabel('Tem alguém junto?', PEOPLE, 2);
    h += '<div style="display:flex; flex-direction:column; gap:8px; margin-bottom:18px;">';
    (S.team || []).filter(function (o) { return o.id !== S.session.person.id; }).forEach(function (o) {
      var on = (f.cowork || []).indexOf(o.id) >= 0;
      var chipS = 'display:flex; align-items:center; gap:11px; width:100%; cursor:pointer; text-align:left; padding:11px 14px; border-radius:16px; transition:all .12s; font-family:\'Manrope\',sans-serif; border:' + (on ? '2px solid ' + ac : '1px solid rgba(15,40,90,.12)') + '; background:' + (on ? 'color-mix(in srgb, ' + ac + ' 9%, white)' : 'rgba(255,255,255,.6)') + ';';
      var boxS = 'flex:none; width:24px; height:24px; border-radius:8px; display:flex; align-items:center; justify-content:center; border:' + (on ? '0' : '2px solid rgba(15,40,90,.25)') + '; background:' + (on ? ac : 'transparent') + '; color:#fff;';
      h += '<button data-act="toggleCowork" data-arg="' + o.id + '" style="' + chipS + '"><span style="' + boxS + '">' + (on ? svgr(CHECK, 15, 3.4) : '') + '</span><span style="position:relative; flex:none; width:34px; height:34px; border-radius:50%; background:linear-gradient(140deg,#5a6e87,#42566f); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:12px;">' + esc(D.initials(o.display_name)) + '<span style="position:absolute; right:-1px; bottom:-1px; width:11px; height:11px; border-radius:50%; border:2px solid #fff; background:' + (o.online ? '#21a85b' : '#b3bccb') + ';"></span></span><span style="flex:1; min-width:0; text-align:left;"><span style="display:block; font-weight:700; font-size:14.5px; color:#0c2545;">' + esc(o.display_name) + '</span><span style="display:block; font-size:12px; color:#566681;">' + esc(o.current_slug ? labelOf(o.current_slug) : (o.online ? 'disponível' : 'offline')) + '</span></span></button>';
    });
    h += '</div>';
    // clinic_shipment: campo de quantidade OPCIONAL no início (regra Bruno). Se não
    // informar aqui, é pedido no fim. Demais (impressão de ordens) = obrigatório.
    var isClinicStart = f.slug === 'clinic_shipment';
    if (ordersReq || isClinicStart) {
      var ordLabel = isClinicStart ? ('Quantas ordens da clínica?' + (ordersReq ? '' : ' (opcional)')) : 'Quantas ordens vai imprimir?';
      h += sectionLabel(ordLabel, '<path d="M6 9V3.5h12V9M6 18.5H4.5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H18M6.5 14.5h11V21h-11z"></path>', 2);
      h += '<input value="' + esc(f.ordersInput || '') + '" data-input="orders" data-focus="orders" inputmode="numeric" placeholder="' + (isClinicStart && !ordersReq ? 'opcional — pode informar no fim' : 'ex: 206') + '" style="width:100%; min-height:56px; font-size:18px; padding:12px 16px; border:1px solid rgba(15,40,90,.16); border-radius:14px; background:rgba(255,255,255,.9); color:#0c2545; outline:none; margin-bottom:18px;">';
    }
    // ── Ajuste de ordens do dia (só no "Outro (Embalagem)" / packaging_other) ──
    // Corrige ordens entradas erradas: adicionar OU reajustar o total (reajustar
    // avisa todo mundo no Slack). Regra Bruno.
    if (f.slug === 'packaging_other') {
      h += sectionLabel('Ajuste de ordens entradas? (opcional)', '<path d="M6 9V3.5h12V9M6 18.5H4.5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H18M6.5 14.5h11V21h-11z"></path>', 2);
      var adjOn = !!f.adjOn;
      h += '<button data-act="adjToggle" style="display:flex; align-items:center; gap:11px; width:100%; cursor:pointer; text-align:left; padding:12px 14px; margin-bottom:' + (adjOn ? '12px' : '18px') + '; border-radius:16px; border:' + (adjOn ? '2px solid ' + ac : '1px solid rgba(15,40,90,.12)') + '; background:' + (adjOn ? 'color-mix(in srgb, ' + ac + ' 9%, white)' : 'rgba(255,255,255,.6)') + ';"><span style="flex:none; width:24px; height:24px; border-radius:8px; display:flex; align-items:center; justify-content:center; border:' + (adjOn ? '0' : '2px solid rgba(15,40,90,.25)') + '; background:' + (adjOn ? ac : 'transparent') + '; color:#fff;">' + (adjOn ? svgr(CHECK, 15, 3.4) : '') + '</span><span style="flex:1; font-weight:700; font-size:14.5px; color:#0c2545;">Ajustar contagem de ordens do dia</span></button>';
      if (adjOn) {
        var mAdd = (f.adjMode || 'additional') === 'additional';
        h += '<div style="display:flex; gap:11px; margin-bottom:12px;"><button data-act="adjModeAdd" style="' + segBtn(mAdd, ac) + '">Ordens adicionais</button><button data-act="adjModeReset" style="' + segBtn(!mAdd, ac) + '">Reajustar total</button></div>';
        h += '<input value="' + esc(f.adjQty || '') + '" data-input="adjQty" inputmode="numeric" placeholder="' + (mAdd ? 'quantas ordens A MAIS' : 'novo TOTAL de ordens do dia') + '" style="width:100%; min-height:56px; font-size:18px; padding:12px 16px; border:1px solid rgba(15,40,90,.16); border-radius:14px; background:rgba(255,255,255,.9); color:#0c2545; outline:none; margin-bottom:8px;">';
        if (!mAdd) h += '<div style="display:flex; align-items:center; gap:8px; margin-bottom:18px; background:rgba(192,53,43,.08); border-left:3px solid #c0352b; padding:10px 12px; border-radius:10px; font-size:12px; color:#8a2018; font-weight:600;">' + svgr(WARN, 16, 2) + 'Reajustar o total substitui a contagem do dia e avisa todo mundo no Slack.</div>';
        else h += '<div style="margin-bottom:18px;"></div>';
      }
    }
    h += sectionLabel(noteReq ? 'Motivo (obrigatório)' : 'Notas (opcional)', EDITP, 2);
    h += '<textarea data-input="note" data-focus="note" placeholder="' + (noteReq ? 'Conte o que está acontecendo, ou use a voz…' : 'Escreva ou use o microfone…') + '" style="width:100%; min-height:84px; font-size:16px; padding:13px 15px; border:1px solid rgba(15,40,90,.16); border-radius:14px; background:rgba(255,255,255,.9); color:#0c2545; outline:none;">' + esc(f.note || '') + '</textarea>';
    h += '<div style="display:flex; justify-content:flex-end; margin-top:10px;">' + voiceBtn('flow') + '</div>';
    var st = startStatus(f);
    var goLabel = (f.forgot && st.ok) ? ('Começar às ' + st.label) : 'Começar';
    h += '<div style="display:flex; gap:11px; margin-top:24px;">' + backBtn() + '<button data-act="confirmStart" style="flex:2; position:relative; overflow:hidden; white-space:nowrap; border:0; background:linear-gradient(135deg, color-mix(in srgb, var(--accent) 86%, #19c277), var(--accent)); color:#fff; border-radius:16px; padding:16px; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; cursor:pointer; box-shadow:0 16px 34px -14px color-mix(in srgb, var(--accent) 64%, transparent); display:flex; align-items:center; justify-content:center; gap:9px;">' + svgr(PLAY, 20, 0, 'currentColor') + esc(goLabel) + '</button></div>';
    return h;
  }
  function flowFinished() {
    var f = S.flow; var st = startStatus(f);
    var h = '<div style="background:rgba(255,255,255,.66); border:1px solid rgba(15,40,90,.1); border-radius:18px; padding:16px; margin-bottom:20px;"><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:17px; color:#0c2545;">' + esc(labelOf(f.slug)) + '</div><div style="font-size:14px; color:#5a6e87; margin-top:4px;">Começou às ' + esc(st.label) + '</div></div>';
    h += '<div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:clamp(18px,2.2vw,22px); color:#0c2545; margin-bottom:14px;">Você já terminou essa tarefa?</div>';
    h += '<div style="display:flex; gap:11px; margin-bottom:14px;"><button data-act="finishedNo" style="' + segBtn(f.finished === 'no', accent()) + '">Não — ainda fazendo</button><button data-act="finishedYes" style="' + segBtn(f.finished === 'yes', accent()) + '">Sim — escolher fim</button></div>';
    if (f.finished === 'yes') {
      normalizeAP(f);
      var es = endStatus(f); var ew = endWindow(f);
      h += '<div style="background:rgba(15,40,90,.04); border-radius:16px; padding:14px; margin-bottom:18px;"><div style="display:flex; gap:9px; align-items:center;">' + timeSelect('endH', f.endH, 'h', ew, f.endAP) + timeSelect('endM', f.endM, 'm') + apButton('toggleEndAP', f.endAP, ew) + '</div><div style="min-height:20px; margin-top:9px; font-size:14px; font-weight:700; color:' + es.color + ';">' + esc(es.text) + '</div></div>';
    }
    h += '<div style="display:flex; gap:11px; margin-top:8px;">' + backBtn() + '<button data-act="commitRetro" style="flex:2; border:0; background:linear-gradient(135deg, color-mix(in srgb, var(--accent) 86%, #19c277), var(--accent)); color:#fff; border-radius:16px; padding:16px; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; cursor:pointer; box-shadow:0 16px 34px -14px color-mix(in srgb, var(--accent) 64%, transparent); display:flex; align-items:center; justify-content:center; gap:9px;">' + svgr(CHECK, 18, 2.6) + 'Adicionar tarefa</button></div>';
    return h;
  }
  function sectionLabel(txt, inner, sw) { return '<div style="font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:#6c819b; margin-bottom:10px; display:flex; align-items:center; gap:7px;">' + svgr(inner, 15, sw || 2) + esc(txt) + '</div>'; }
  function segBtn(on, ac) { return 'flex:1; display:flex; align-items:center; justify-content:center; gap:8px; cursor:pointer; border-radius:16px; padding:15px 12px; font-family:\'Sora\',sans-serif; font-weight:700; font-size:15px; transition:all .12s; border:' + (on ? '0' : '1px solid rgba(15,40,90,.14)') + '; background:' + (on ? 'linear-gradient(135deg, color-mix(in srgb,' + ac + ' 88%, #19c277), ' + ac + ')' : 'rgba(255,255,255,.66)') + '; color:' + (on ? '#fff' : '#42566f') + '; box-shadow:' + (on ? '0 12px 26px -14px color-mix(in srgb,' + ac + ' 60%, transparent)' : 'none') + ';'; }
  function backBtn() { return '<button data-act="flowBack" style="flex:1; border:1px solid rgba(15,40,90,.14); background:rgba(255,255,255,.6); color:#42566f; border-radius:16px; padding:15px; font-weight:700; font-size:15px; cursor:pointer;">← Voltar</button>'; }
  // ── Regras de horário do "Esqueci de marcar" (retroativo) ──────────────
  // Tudo em horário local do quiosque (NY). Espelhado no backend
  // (/api/v3/op/event/retroactive) e no guard do cascade. Princípios:
  //   • nunca no futuro, nunca de outro dia (não dá pra esquecer o que ainda
  //     não aconteceu, nem marcar amanhã);
  //   • início >= 6h (a linha abre 8h, às vezes 6h) — antes das 6h bloqueia,
  //     entre 6h e 8h confirma; início > 2h atrás confirma;
  //   • fim sempre DEPOIS do início e <= agora; teto 11pm (depois bloqueia),
  //     depois das 21h (9pm) confirma (fechamos 8pm).
  // O AM/PM e as horas travam sozinhos pra nunca deixar escolher um valor
  // impossível (foi o "8:33am" trocado da Ana). Min em minutos-do-dia.
  var RETRO_RULES = { earlyHard: 6 * 60, earlySoft: 8 * 60, lateSoft: 21 * 60, lateHard: 23 * 60, bigGap: 120 };
  function nowMinLocal() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function minOfDay(iso) { var d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); }
  function hourTo24(h12, ap) { return (parseInt(h12, 10) % 12) + (ap === 'PM' ? 12 : 0); }
  // janela dura (minutos-do-dia) de valores aceitáveis p/ cada campo.
  function startWindow() { return [RETRO_RULES.earlyHard, nowMinLocal()]; }
  function endWindow(f) {
    var st = startStatus(f);
    var lo = (st.iso && !st.block) ? minOfDay(st.iso) + 1 : RETRO_RULES.earlyHard;
    return [lo, Math.min(nowMinLocal(), RETRO_RULES.lateHard)];
  }
  function hourOk(h12, ap, win) { var w0 = hourTo24(h12, ap) * 60; return (w0 + 55) >= win[0] && w0 <= win[1]; }
  function apAllowed(ap, win) { for (var h = 1; h <= 12; h++) if (hourOk(h, ap, win)) return true; return false; }
  // normaliza o AM/PM guardado pro lado que ainda é válido (chamado no render
  // antes de desenhar o picker, p/ um botão travado nunca mostrar valor impossível).
  function normalizeAP(f) {
    var ws = startWindow();
    if (!apAllowed(f.tpAP, ws) && apAllowed(f.tpAP === 'AM' ? 'PM' : 'AM', ws)) f.tpAP = f.tpAP === 'AM' ? 'PM' : 'AM';
    var we = endWindow(f);
    if (!apAllowed(f.endAP, we) && apAllowed(f.endAP === 'AM' ? 'PM' : 'AM', we)) f.endAP = f.endAP === 'AM' ? 'PM' : 'AM';
  }
  function timeSelect(name, val, kind, win, ap) {
    var opts = '';
    if (kind === 'h') {
      opts = '<option value="">hora</option>';
      for (var i = 1; i <= 12; i++) {
        var dis = (win && ap) ? !hourOk(i, ap, win) : false;
        opts += '<option value="' + i + '"' + (String(val) === String(i) ? ' selected' : '') + (dis ? ' disabled' : '') + '>' + i + '</option>';
      }
    } else { ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'].forEach(function (m) { opts += '<option value="' + m + '"' + (String(val) === m ? ' selected' : '') + '>:' + m + '</option>'; }); }
    return '<select data-change="' + name + '" style="flex:1; min-height:52px; font-size:17px; padding:10px; border:1px solid rgba(15,40,90,.16); border-radius:13px; background:#fff; color:#0c2545;">' + opts + '</select>';
  }
  // botão AM/PM: alterna normalmente quando os dois lados são válidos; trava
  // (disabled + 🔒) quando só um meridiano cabe na janela (ex.: ainda é de
  // manhã → não dá pra começar/terminar "PM").
  function apButton(act, ap, win) {
    var both = apAllowed('AM', win) && apAllowed('PM', win);
    var bg = both ? '#2c505f' : '#9fb0bf';
    return '<button' + (both ? ' data-act="' + act + '"' : ' disabled') + ' title="' + (both ? 'Tocar pra alternar AM/PM' : 'Travado: só ' + esc(ap) + ' é possível agora') + '" style="flex:none; min-width:70px; min-height:52px; font-size:16px; font-weight:800; font-family:\'Sora\',sans-serif; background:' + bg + '; color:#fff; border:0; border-radius:13px; cursor:' + (both ? 'pointer' : 'default') + '; opacity:' + (both ? '1' : '.8') + ';">' + esc(ap) + (both ? '' : ' 🔒') + '</button>';
  }
  function isoFromHMA(h, m, ap) { if (!h) return null; var hh = (parseInt(h, 10) % 12) + (ap === 'PM' ? 12 : 0); var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate(), hh, parseInt(m || '0', 10), 0, 0).toISOString(); }
  function fmt12(iso) { var d = new Date(iso); var h = d.getHours(); var m = d.getMinutes(); var ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + ' ' + ap; }
  // status retornam { ok, block, confirm, color, text, label, iso, confirmMsg }.
  //   block   = quebra regra dura (não dá pra salvar de jeito nenhum);
  //   confirm = válido mas incomum (pede "tem certeza?" antes de salvar);
  //   ok      = !block (o iso é utilizável, talvez após confirmar).
  function startStatus(f) {
    if (!f.tpH) return { ok: false, block: false, confirm: false, color: '#566681', text: '', label: '' };
    var iso = isoFromHMA(f.tpH, f.tpM, f.tpAP); var lbl = fmt12(iso); var mo = minOfDay(iso); var now = nowMinLocal();
    var base = { label: lbl, iso: iso };
    if (new Date(iso).getTime() > Date.now()) return Object.assign(base, { ok: false, block: true, confirm: false, color: '#c0352b', text: 'Não pode ser no futuro', future: true });
    if (mo < RETRO_RULES.earlyHard) return Object.assign(base, { ok: false, block: true, confirm: false, color: '#c0352b', text: 'Cedo demais — a linha não abre antes das 6h', tooEarly: true });
    var why = [];
    if (mo < RETRO_RULES.earlySoft) why.push('é antes das 8h da manhã');
    if (now - mo > RETRO_RULES.bigGap) why.push('faz mais de 2 horas');
    if (why.length) return Object.assign(base, { ok: true, block: false, confirm: true, color: '#b35c00', text: 'Início ' + lbl + ' — confirme', confirmMsg: 'O início ' + lbl + ' ' + why.join(' e ') + '. Foi isso mesmo?' });
    return Object.assign(base, { ok: true, block: false, confirm: false, color: '#0e7a4e', text: 'Início ' + lbl });
  }
  function endStatus(f) {
    if (!f.endH) return { ok: false, block: false, confirm: false, color: '#566681', text: '', label: '' };
    var iso = isoFromHMA(f.endH, f.endM, f.endAP); var st = startStatus(f); var lbl = fmt12(iso); var mo = minOfDay(iso);
    var base = { label: lbl, iso: iso };
    if (new Date(iso).getTime() > Date.now()) return Object.assign(base, { ok: false, block: true, confirm: false, color: '#c0352b', text: 'Não pode ser no futuro', future: true });
    if (st.iso && !st.block && new Date(iso).getTime() <= new Date(st.iso).getTime()) return Object.assign(base, { ok: false, block: true, confirm: false, color: '#c0352b', text: 'Tem que ser depois do início', before: true });
    if (mo > RETRO_RULES.lateHard) return Object.assign(base, { ok: false, block: true, confirm: false, color: '#c0352b', text: 'Tarde demais — no máximo 11pm', tooLate: true });
    if (mo > RETRO_RULES.lateSoft) return Object.assign(base, { ok: true, block: false, confirm: true, color: '#b35c00', text: 'Fim ' + lbl + ' — confirme', confirmMsg: 'O fim ' + lbl + ' passou das 9pm (fechamos às 8pm). Foi isso mesmo?' });
    return Object.assign(base, { ok: true, block: false, confirm: false, color: '#0e7a4e', text: 'Fim ' + lbl });
  }

  // ── voz (botão; estado "gravando" via CSS, timer/transcript cirúrgicos) ──
  function voiceBtn(target) {
    var on = S.voice.on && S.voice.target === target;
    var st = 'flex:none; display:flex; align-items:center; gap:9px; cursor:pointer; border-radius:14px; padding:12px 16px; font-weight:700; font-size:14px; transition:all .12s; border:' + (on ? '0' : '1px solid rgba(15,40,90,.14)') + '; background:' + (on ? 'linear-gradient(135deg,#cf463c,#b3261e)' : 'rgba(255,255,255,.7)') + '; color:' + (on ? '#fff' : '#42566f') + ';';
    var mic = '<span style="display:inline-flex;' + (on ? 'animation:hfPulse 1s ease-in-out infinite;' : '') + '">' + svgr(MIC, 18, 1.9) + '</span>';
    var label = on ? ('● Gravando <span id="voice-timer">' + S.voice.secs + '</span>s') : 'Ditar';
    return '<button data-act="voice" data-arg="' + target + '" style="' + st + '">' + mic + label + '</button>';
  }
  // troca SÓ o botão de voz no lugar (sem render → sem re-pop do modal)
  function refreshVoiceBtn(target) {
    var scope = target === 'flow' ? LYR.flow.el : LYR.overlay.el;
    var btn = scope && scope.querySelector('[data-act="voice"][data-arg="' + target + '"]');
    if (btn) { var tmp = document.createElement('div'); tmp.innerHTML = voiceBtn(target); if (tmp.firstElementChild) btn.replaceWith(tmp.firstElementChild); }
  }

  // ════════════════════════════════════════════════════════════
  // OVERLAYS (card; #lyr-overlay dá backdrop + centro)
  // ════════════════════════════════════════════════════════════
  function overlayKey() {
    var o = S.overlay; if (!o) return '';
    if (o.type === 'reclassify') return 'reclassify:' + (o.eventId || '');
    if (o.type === 'clock') return 'clock:' + (o.missing || []).length + ':' + JSON.stringify(o.unknown || {});
    if (o.type === 'finish') return 'finish:' + (o.eventId || '') + ':' + (o.exc ? 1 : 0) + ':' + (o.cowork ? 1 : 0) + ':' + (o.lastFinisher ? 1 : 0) + ':' + (o.needsOrders ? 1 : 0); // exc/cowork/último/orders re-montam
    if (o.type === 'gap') return 'gap:' + (o.jtype || ''); // re-monta ao escolher o motivo (highlight)
    if (o.type === 'eod') return 'eod:' + (o.products || []).length;
    if (o.type === 'detectWhen') return 'detectWhen:' + (o.pickTime ? 1 : 0) + ':' + (o.tpH || '') + ':' + (o.tpM || '') + ':' + (o.tpAP || '') + ':' + (S.detectBusy ? 1 : 0); // FASE FORM Parte 2
    return o.type + ':' + (o.eventId || '') + ':' + ((o.prompt && o.prompt.person_id) || '');
  }
  function ghostBtn(act, label) { return '<button data-act="' + act + '" style="flex:1; border:1px solid rgba(15,40,90,.14); background:rgba(255,255,255,.6); color:#42566f; border-radius:15px; padding:15px; font-weight:700; font-size:15px; cursor:pointer;">' + esc(label) + '</button>'; }
  function cardOpen(maxw, center, extra) { return '<div class="hf-scroll" style="width:' + maxw + 'px; max-width:94%; max-height:828px; overflow-y:auto; background:rgba(255,255,255,.86); backdrop-filter:blur(28px) saturate(1.5); border:1px solid rgba(255,255,255,.85); border-radius:28px; box-shadow:0 50px 110px -40px rgba(12,37,69,.6); padding:clamp(22px,3vw,30px); animation:hfPop .3s ease both;' + (center ? 'text-align:center;' : '') + (extra || '') + '">'; }
  // overlay RECLASSIFY — trocar o tipo de uma task ao vivo (escolheu errado). Regra Bruno.
  function reclassifyInner(o) {
    var h = cardOpen(520);
    h += '<div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:19px; color:#0c2545; margin-bottom:6px;">Trocar tipo da tarefa</div>';
    h += '<div style="font-size:13px; color:#5a6e87; margin-bottom:14px;">Escolheu o tipo errado? Pegue o certo abaixo — a tarefa continua aberta, só muda o tipo.</div>';
    (DATA.groups || []).forEach(function (g) {
      h += '<div style="font-size:11.5px; font-weight:800; text-transform:uppercase; letter-spacing:.05em; color:#566681; margin:12px 0 7px;">' + esc(g.label) + '</div>';
      h += '<div style="display:flex; flex-wrap:wrap; gap:8px;">';
      (g.types || []).forEach(function (t) {
        h += '<button data-act="doReclassify" data-arg="' + esc(t.slug) + '" style="display:flex; align-items:center; gap:8px; cursor:pointer; border:1px solid rgba(15,40,90,.14); background:rgba(255,255,255,.72); border-radius:13px; padding:9px 13px; font-weight:600; font-size:13.5px; color:#0c2545;"><span style="color:#0f4c92;">' + svg(iconPath(t.slug), 18, 1.7) + '</span>' + esc(t.label) + '</button>';
      });
      h += '</div>';
    });
    h += '<div style="display:flex; gap:11px; margin-top:22px;">' + ghostBtn('closeOverlay', 'Cancelar') + '</div></div>';
    return h;
  }
  // overlay FINISH cowork (membro NÃO-último): "terminei minha parte", sem contagem
  function finishCoworkInner(o) {
    var sub = (o.product ? esc(o.product) : esc(o.label || '')) + (o.batch ? ' · ' + esc(o.batch) : '');
    var rem = o.coworkRemaining || 0;
    var h = cardOpen(460);
    h += '<div style="display:flex; align-items:center; gap:13px; margin-bottom:16px;"><span style="flex:none; width:48px; height:48px; border-radius:15px; background:rgba(47,122,224,.12); color:#1f5fd0; display:flex; align-items:center; justify-content:center;">' + svgr(PEOPLE, 26, 1.8) + '</span><div style="min-width:0;"><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:19px; color:#0c2545;">Terminar sua parte</div>' + (sub ? '<div style="font-size:13px; color:#5a6e87; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + sub + (rem ? ' · ' + rem + ' colega(s) ainda na tarefa' : '') + '</div>' : '') + '</div></div>';
    h += '<div style="font-size:14px; font-weight:600; color:#42566f; margin-bottom:8px;">Nota da sua parte (opcional)</div>';
    h += '<textarea data-input="finNote" placeholder="Observações (opcional)…" style="width:100%; min-height:72px; font-size:16px; padding:13px 15px; border:1px solid rgba(15,40,90,.16); border-radius:14px; background:#fff; color:#0c2545; outline:none;">' + esc(o.note || '') + '</textarea>';
    // FASE FIX: a mensagem "último informa contagem do grupo" SÓ aparece se a task
    // do cowork pede contagem — bottles p/ produção, ordens p/ P&P. Cowork de
    // limpeza/formulação/etc NÃO mostra (não há contagem a informar).
    var coworkCountMsg = '';
    if (o.slug === 'production_line' || o.requiresBottleCount) coworkCountMsg = 'Quem terminar por último vai informar o total de bottles do grupo.';
    else if (o.needsOrders) coworkCountMsg = 'Quem terminar por último vai informar o total de ordens do grupo.';
    if (coworkCountMsg) h += '<div style="display:flex; align-items:center; gap:8px; margin-top:12px; background:rgba(47,122,224,.07); border-left:3px solid #1f5fd0; padding:12px; border-radius:12px; font-size:12.5px; color:#42566f; font-weight:600;">' + svgr(PEOPLE, 16, 2) + coworkCountMsg + '</div>';
    h += '<div style="display:flex; gap:11px; margin-top:20px;">' + ghostBtn('closeOverlay', 'Cancelar') + '<button data-act="doFinish" style="flex:1.6; border:0; background:linear-gradient(135deg,#3a86ee,#1f5fd0); color:#fff; border-radius:15px; padding:15px; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; cursor:pointer; box-shadow:0 14px 30px -14px rgba(31,95,208,.7); display:flex; align-items:center; justify-content:center; gap:8px;">' + svgr(CHECK, 19, 2.6) + 'Terminei minha parte</button></div>';
    h += '</div>';
    return h;
  }
  // overlay FINISH da production_line E do FNSKU: contagem obrigatória OU exceção.
  // FNSKU conta LABELS colados; produção conta bottles. Mesma tela, wording variável.
  function finishProdInner(o) {
    var sub = (o.product ? esc(o.product) : '') + (o.batch ? (o.product ? ' · ' : '') + esc(o.batch) : '');
    var fn = !!o.needsFnsku;
    var titleTxt = fn ? 'FNSKU / Código de Barras' : 'Linha de Produção';
    var noun = fn ? 'FNSKU / labels' : 'bottles';
    var askTxt = fn ? 'Quantos FNSKU / labels foram colados?' : 'Quantas bottles foram produzidas?';
    var btnTxt = fn ? 'Finalizar FNSKU' : 'Finalizar Linha';
    var checkBox = '<span style="flex:none; width:24px; height:24px; border-radius:7px; display:flex; align-items:center; justify-content:center; border:2px solid ' + (o.exc ? '#b35c00' : 'rgba(15,40,90,.3)') + '; background:' + (o.exc ? '#b35c00' : 'transparent') + '; color:#fff;">' + (o.exc ? svgr(CHECK, 15, 3.4) : '') + '</span>';
    var goBg = o.exc ? 'linear-gradient(135deg,#d97712,#b35c00)' : 'linear-gradient(135deg,#cf463c,#b3261e)';
    var h = cardOpen(480);
    h += '<div style="display:flex; align-items:center; gap:13px; margin-bottom:16px;"><span style="flex:none; width:48px; height:48px; border-radius:15px; background:rgba(179,38,30,.1); color:#b3261e; display:flex; align-items:center; justify-content:center;">' + svg(ICONS.factory, 26, 1.7) + '</span><div style="min-width:0;"><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:19px; color:#0c2545;">Finalizar: ' + titleTxt + '</div>' + (sub ? '<div style="font-size:13px; color:#5a6e87; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + sub + '</div>' : '') + '</div></div>';
    if (o.lastFinisher) h += '<div style="margin-bottom:14px; padding:12px 14px; border-radius:12px; background:rgba(217,145,0,.12); border-left:3px solid #d99100; font-size:13px; font-weight:700; color:#8a5a00;">Você é o último a finalizar — informe o TOTAL de ' + noun + ' do grupo.</div>';
    var estLine = o.estimatedBottles ? '<div style="font-size:12.5px; color:#1f5fd0; font-weight:700; margin-bottom:6px;">📦 Estimado: ' + o.estimatedBottles + (fn ? ' labels' : ' frascos') + '</div>' : '';
    h += '<div style="opacity:' + (o.exc ? '.5' : '1') + '; transition:opacity .2s;"><div style="font-size:14px; font-weight:600; color:#42566f; margin-bottom:8px;">' + askTxt + '</div>' + estLine + '<input value="' + esc(o.bottles || '') + '" data-input="finBottles" inputmode="numeric" ' + (o.exc ? 'disabled' : '') + ' placeholder="' + (o.estimatedBottles ? 'ex: ' + o.estimatedBottles : 'ex: 754') + '" style="width:100%; min-height:56px; font-size:18px; padding:12px 16px; border:1px solid rgba(15,40,90,.16); border-radius:14px; background:#fff; color:#0c2545; outline:none;"></div>';
    h += '<button data-act="toggleExc" style="display:flex; align-items:center; gap:11px; width:100%; text-align:left; cursor:pointer; margin-top:14px; padding:12px 14px; border-radius:14px; border:1px solid ' + (o.exc ? 'rgba(179,92,0,.35)' : 'rgba(15,40,90,.12)') + '; background:' + (o.exc ? 'rgba(179,92,0,.08)' : 'rgba(255,255,255,.6)') + ';">' + checkBox + '<span style="flex:1; min-width:0;"><span style="display:block; font-weight:700; font-size:14.5px; color:' + (o.exc ? '#b35c00' : '#0c2545') + ';">Exceção: não tenho o número</span><span style="display:block; font-size:12px; color:#566681;">(será notificado em Orders &amp; Inventory)</span></span></button>';
    if (o.exc) {
      h += '<div style="margin-top:14px; animation:hfRise .3s ease both;">'
        + '<div style="font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:#b35c00; margin-bottom:8px;">Explique por que você não tem a contagem *</div>'
        + '<textarea data-input="finReason" data-focus="finReason" placeholder="Ex: a balança quebrou no meio do lote…" style="width:100%; min-height:80px; font-size:16px; padding:13px 15px; border:1px solid rgba(179,92,0,.3); border-radius:14px; background:#fff; color:#0c2545; outline:none;">' + esc(o.reason || '') + '</textarea>'
        + '<div style="display:flex; justify-content:flex-end; margin-top:8px;">' + voiceBtn('finishReason') + '</div>'
        + '<div style="display:flex; align-items:center; gap:8px; margin-top:10px; background:rgba(179,92,0,.08); border-left:3px solid #b35c00; padding:12px; border-radius:12px; font-size:12.5px; color:#8a5a00; font-weight:600;">' + svgr(WARN, 16, 2) + 'Esta mensagem será enviada para Orders &amp; Inventory automaticamente.</div>'
        + '</div>';
    }
    h += '<div style="font-size:14px; font-weight:600; color:#42566f; margin:16px 0 8px;">Nota final adicional (opcional)</div>';
    h += '<textarea data-input="finNote" placeholder="Observações finais…" style="width:100%; min-height:64px; font-size:16px; padding:13px 15px; border:1px solid rgba(15,40,90,.16); border-radius:14px; background:#fff; color:#0c2545; outline:none;">' + esc(o.note || '') + '</textarea>';
    h += '<div style="display:flex; gap:11px; margin-top:20px;">' + ghostBtn('closeOverlay', 'Cancelar') + '<button data-act="doFinish" style="flex:1.6; border:0; background:' + goBg + '; color:#fff; border-radius:15px; padding:15px; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; cursor:pointer; box-shadow:0 14px 30px -14px rgba(179,38,30,.7); display:flex; align-items:center; justify-content:center; gap:8px;">' + (o.exc ? svgr(WARN, 18, 2) + 'Finalizar com Exceção' : svgr(CHECK, 19, 2.6) + btnTxt) + '</button></div>';
    h += '</div>';
    return h;
  }
  // FASE 5 — overlay FINISH de P&P/Embalagem: ordens obrigatório OU exceção + marketplace
  var MARKETPLACES = ['Amazon', 'eBay', 'Walmart', 'Site próprio', 'TikTok', 'Clínica', 'Misto', 'Outro'];
  function finishOrdersInner(o) {
    var sub = (o.product ? esc(o.product) : '') + (o.batch ? (o.product ? ' · ' : '') + esc(o.batch) : '');
    var checkBox = '<span style="flex:none; width:24px; height:24px; border-radius:7px; display:flex; align-items:center; justify-content:center; border:2px solid ' + (o.exc ? '#b35c00' : 'rgba(15,40,90,.3)') + '; background:' + (o.exc ? '#b35c00' : 'transparent') + '; color:#fff;">' + (o.exc ? svgr(CHECK, 15, 3.4) : '') + '</span>';
    var goBg = o.exc ? 'linear-gradient(135deg,#d97712,#b35c00)' : 'linear-gradient(135deg,#2f7ae0,#0f4c92)';
    var h = cardOpen(480);
    h += '<div style="display:flex; align-items:center; gap:13px; margin-bottom:16px;"><span style="flex:none; width:48px; height:48px; border-radius:15px; background:rgba(15,76,146,.1); color:#0f4c92; display:flex; align-items:center; justify-content:center;">' + svgr('<path d="M21 8l-9-5-9 5 9 5 9-5z"></path><path d="M3 8v8l9 5 9-5V8"></path>', 26, 1.7) + '</span><div style="min-width:0;"><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:19px; color:#0c2545;">Finalizar: ' + esc(o.label) + '</div>' + (sub ? '<div style="font-size:13px; color:#5a6e87; margin-top:2px;">' + sub + '</div>' : '') + '</div></div>';
    h += '<div style="opacity:' + (o.exc ? '.5' : '1') + '; transition:opacity .2s;"><div style="font-size:14px; font-weight:600; color:#42566f; margin-bottom:8px;">Quantas ordens foram empacotadas?</div><input value="' + esc(o.orders || '') + '" data-input="finOrders" inputmode="numeric" ' + (o.exc ? 'disabled' : '') + ' placeholder="ex: 48" style="width:100%; min-height:56px; font-size:18px; padding:12px 16px; border:1px solid rgba(15,40,90,.16); border-radius:14px; background:#fff; color:#0c2545; outline:none;">';
    h += '<div style="font-size:13px; font-weight:600; color:#42566f; margin:14px 0 7px;">Marketplace principal (opcional)</div><select data-change="marketplace" ' + (o.exc ? 'disabled' : '') + ' style="width:100%; min-height:48px; font-size:15px; padding:10px 14px; border:1px solid rgba(15,40,90,.16); border-radius:12px; background:#fff; color:#0c2545;"><option value="">— escolher —</option>' + MARKETPLACES.map(function (m) { return '<option value="' + m + '"' + (o.marketplace === m ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select></div>';
    h += '<button data-act="toggleExc" style="display:flex; align-items:center; gap:11px; width:100%; text-align:left; cursor:pointer; margin-top:14px; padding:12px 14px; border-radius:14px; border:1px solid ' + (o.exc ? 'rgba(179,92,0,.35)' : 'rgba(15,40,90,.12)') + '; background:' + (o.exc ? 'rgba(179,92,0,.08)' : 'rgba(255,255,255,.6)') + ';">' + checkBox + '<span style="flex:1; min-width:0;"><span style="display:block; font-weight:700; font-size:14.5px; color:' + (o.exc ? '#b35c00' : '#0c2545') + ';">Exceção: não tenho o número</span><span style="display:block; font-size:12px; color:#566681;">(será notificado em Orders &amp; Inventory)</span></span></button>';
    if (o.exc) {
      h += '<div style="margin-top:14px; animation:hfRise .3s ease both;"><div style="font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:#b35c00; margin-bottom:8px;">Explique por que não tem a contagem *</div><textarea data-input="finReason" data-focus="finReason" placeholder="Ex: sistema do marketplace fora do ar…" style="width:100%; min-height:80px; font-size:16px; padding:13px 15px; border:1px solid rgba(179,92,0,.3); border-radius:14px; background:#fff; color:#0c2545; outline:none;">' + esc(o.reason || '') + '</textarea><div style="display:flex; justify-content:flex-end; margin-top:8px;">' + voiceBtn('finishReason') + '</div></div>';
    }
    h += '<div style="font-size:14px; font-weight:600; color:#42566f; margin:16px 0 8px;">Nota final (opcional)</div><textarea data-input="finNote" placeholder="Observações…" style="width:100%; min-height:60px; font-size:16px; padding:13px 15px; border:1px solid rgba(15,40,90,.16); border-radius:14px; background:#fff; color:#0c2545; outline:none;">' + esc(o.note || '') + '</textarea>';
    h += '<div style="display:flex; gap:11px; margin-top:20px;">' + ghostBtn('closeOverlay', 'Cancelar') + '<button data-act="doFinish" style="flex:1.6; border:0; background:' + goBg + '; color:#fff; border-radius:15px; padding:15px; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; cursor:pointer; box-shadow:0 14px 30px -14px rgba(15,76,146,.6); display:flex; align-items:center; justify-content:center; gap:8px;">' + (o.exc ? svgr(WARN, 18, 2) + 'Finalizar com Exceção' : svgr(CHECK, 19, 2.6) + 'Finalizar') + '</button></div>';
    h += '</div>';
    return h;
  }
  // FASE FORM Parte 2 — "Quando começou?" pra detecção passiva (Agora / outra hora).
  // Reusa o time picker do retroativo (timeSelect/apButton/startStatus) — mesma infra.
  function detectWhenInner(o) {
    var d = o.det || {}; var ac = accent();
    var ctx = d.is_machine ? (d.machine_label || 'máquina') : (STAGE_PT[d.stage] || d.stage || '');
    var sub = [ctx, d.product_name, d.batch_number].filter(Boolean).map(esc).join(' · ');
    var h = cardOpen(460);
    h += '<div style="display:flex; align-items:center; gap:13px; margin-bottom:16px;"><span style="flex:none; width:48px; height:48px; border-radius:15px; background:rgba(47,122,224,.12); color:#1f5fd0; display:flex; align-items:center; justify-content:center; font-size:24px;">🏭</span><div style="min-width:0;"><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:19px; color:#0c2545;">Quando você começou?</div>' + (sub ? '<div style="font-size:13px; color:#5a6e87; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + sub + '</div>' : '') + '</div></div>';
    h += '<div style="display:flex; gap:11px; margin-bottom:14px;"><button data-act="detectModeNow" style="' + segBtn(!o.pickTime, ac) + '">' + svgr(PLAY, 14, 0, 'currentColor') + 'Agora</button><button data-act="detectPickTime" style="' + segBtn(o.pickTime, ac) + '">' + svgr(CLOCK, 15, 2.1) + 'Marcar outra hora</button></div>';
    if (o.pickTime) {
      normalizeAP(o); var ss = startStatus(o); var sw = startWindow();
      h += '<div style="background:rgba(15,40,90,.04); border-radius:16px; padding:14px; margin-bottom:8px;"><div style="display:flex; gap:9px; align-items:center;">' + timeSelect('dtH', o.tpH, 'h', sw, o.tpAP) + timeSelect('dtM', o.tpM, 'm') + apButton('toggleDetectAP', o.tpAP, sw) + '</div><div style="min-height:20px; margin-top:9px; font-size:14px; font-weight:700; color:' + ss.color + ';">' + esc(ss.text) + '</div></div>';
    }
    var st = startStatus(o);
    var goAct = o.pickTime ? 'doRegisterDetectedAt' : 'doRegisterDetectedNow';
    var goLabel = o.pickTime ? (st.ok ? 'Registrar às ' + st.label : 'Escolha a hora') : 'Registrar agora';
    h += '<div style="display:flex; gap:11px; margin-top:14px;">' + ghostBtn('closeOverlay', 'Cancelar') + '<button data-act="' + goAct + '" ' + (S.detectBusy ? 'disabled' : '') + ' style="flex:1.6; border:0; background:linear-gradient(135deg,#3a86ee,#1f5fd0); color:#fff; border-radius:15px; padding:15px; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; cursor:pointer; box-shadow:0 14px 30px -14px rgba(31,95,208,.7); display:flex; align-items:center; justify-content:center; gap:8px;">' + svgr(CHECK, 18, 2.6) + (S.detectBusy ? 'Registrando…' : esc(goLabel)) + '</button></div>';
    h += '</div>';
    return h;
  }
  function overlayInner() {
    var o = S.overlay; if (!o) return '';
    if (o.type === 'reclassify') return reclassifyInner(o);
    if (o.type === 'detectWhen') return detectWhenInner(o);
    if (o.type === 'finish' && o.cowork && !o.lastFinisher) return finishCoworkInner(o);
    if (o.type === 'finish' && (o.slug === 'production_line' || o.needsFnsku)) return finishProdInner(o);
    if (o.type === 'finish' && o.needsOrders) return finishOrdersInner(o); // FASE 5 — P&P
    if (o.type === 'finish') {
      var inner = cardOpen(460) + '<div style="display:flex; align-items:center; gap:13px; margin-bottom:18px;"><span style="flex:none; width:48px; height:48px; border-radius:15px; background:rgba(179,38,30,.1); color:#b3261e; display:flex; align-items:center; justify-content:center;">' + svg(iconPath(o.slug), 26, 1.7) + '</span><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:19px; color:#0c2545;">Finalizar: ' + esc(o.label) + '</div></div>';
      if (o.needsCount) inner += '<div style="font-size:14px; font-weight:600; color:#42566f; margin-bottom:8px;">Quantos bottles saíram? (pode deixar vazio)</div><input value="' + esc(o.bottles || '') + '" data-input="finBottles" inputmode="numeric" placeholder="ex: 746" style="width:100%; min-height:56px; font-size:18px; padding:12px 16px; border:1px solid rgba(15,40,90,.16); border-radius:14px; background:#fff; color:#0c2545; outline:none; margin-bottom:14px;">';
      inner += '<textarea data-input="finNote" placeholder="Nota final (opcional)" style="width:100%; min-height:78px; font-size:16px; padding:13px 15px; border:1px solid rgba(15,40,90,.16); border-radius:14px; background:#fff; color:#0c2545; outline:none;">' + esc(o.note || '') + '</textarea>';
      inner += '<div style="display:flex; gap:11px; margin-top:20px;">' + ghostBtn('closeOverlay', 'Cancelar') + '<button data-act="doFinish" style="flex:1.5; border:0; background:linear-gradient(135deg,#cf463c,#b3261e); color:#fff; border-radius:15px; padding:15px; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; cursor:pointer; box-shadow:0 14px 30px -14px rgba(179,38,30,.7); display:flex; align-items:center; justify-content:center; gap:8px;">' + svgr(CHECK, 19, 2.6) + 'Finalizar</button></div></div>';
      return inner;
    }
    if (o.type === 'join') {
      return cardOpen(420, true) + '<span style="display:inline-flex; width:56px; height:56px; border-radius:50%; background:rgba(47,122,224,.12); color:#1f5fd0; align-items:center; justify-content:center; margin-bottom:14px;">' + svgr(PEOPLE, 28, 1.8) + '</span><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:20px; color:#0c2545; margin-bottom:6px;">Entrar junto com ' + esc(o.name) + '?</div><div style="font-size:14px; color:#5a6e87; margin-bottom:22px;">' + esc(o.sub || '') + '</div><div style="display:flex; gap:11px;">' + ghostBtn('closeOverlay', 'Cancelar') + '<button data-act="doJoin" style="flex:1.5; border:0; background:linear-gradient(135deg,#3a86ee,#1f5fd0); color:#fff; border-radius:15px; padding:15px; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; cursor:pointer; box-shadow:0 14px 30px -14px rgba(31,95,208,.7); display:flex; align-items:center; justify-content:center; gap:8px;">' + svgr(PEOPLE, 17, 2) + 'Entrar</button></div></div>';
    }
    if (o.type === 'note') {
      return cardOpen(460) + '<div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:19px; color:#0c2545; margin-bottom:16px; display:flex; align-items:center; gap:9px;"><span style="color:#0f4c92;">' + svgr(EDITP, 19, 1.9) + '</span>Nota rápida</div><textarea data-input="ovNote" data-focus="ovNote" placeholder="Fale ou escreva a nota…" style="width:100%; min-height:96px; font-size:16px; padding:13px 15px; border:1px solid rgba(15,40,90,.16); border-radius:14px; background:#fff; color:#0c2545; outline:none;">' + esc(o.note || '') + '</textarea><div style="display:flex; justify-content:flex-end; margin-top:10px;">' + voiceBtn('note') + '</div><div style="display:flex; gap:11px; margin-top:18px;">' + ghostBtn('closeOverlay', 'Fechar') + '<button data-act="saveNote" style="flex:1.5; border:0; background:linear-gradient(135deg, color-mix(in srgb, var(--accent) 86%, #19c277), var(--accent)); color:#fff; border-radius:15px; padding:15px; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; cursor:pointer; box-shadow:0 14px 30px -14px color-mix(in srgb, var(--accent) 60%, transparent);">Salvar</button></div></div>';
    }
    if (o.type === 'clock') {
      var ci = cardOpen(520) + '<div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;"><span style="flex:none; width:46px; height:46px; border-radius:14px; background:rgba(179,92,0,.12); color:#b35c00; display:flex; align-items:center; justify-content:center;">' + svgr(DOOR, 24, 1.8) + '</span><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:20px; color:#0c2545;">Fim do dia</div></div>';
      if ((o.missing || []).length) {
        ci += '<div style="font-size:14px; color:#5a6e87; margin-bottom:16px;">Antes de sair, confirme as contagens das produções de hoje:</div><div style="display:flex; flex-direction:column; gap:10px;">';
        o.missing.forEach(function (m) {
          var unk = (o.unknown || {})[m.event_id];
          var us = 'flex:none; cursor:pointer; border-radius:12px; padding:12px 14px; font-weight:700; font-size:13px; white-space:nowrap; border:' + (unk ? '0' : '1px solid rgba(15,40,90,.14)') + '; background:' + (unk ? '#42566f' : 'rgba(255,255,255,.7)') + '; color:' + (unk ? '#fff' : '#42566f') + ';';
          ci += '<div style="background:rgba(255,255,255,.7); border:1px solid rgba(15,40,90,.12); border-radius:16px; padding:14px;"><div style="font-weight:700; font-size:15px; color:#0c2545; margin-bottom:9px;">' + esc((m.product || '?') + ' · ' + (m.batch_number || '')) + '</div><div style="display:flex; gap:10px; align-items:center;"><input value="' + esc((o.counts || {})[m.event_id] || '') + '" data-input="clockCount" data-arg="' + m.event_id + '" inputmode="numeric" ' + (unk ? 'disabled' : '') + ' placeholder="Quantos bottles?" style="flex:1; min-height:50px; font-size:16px; padding:10px 14px; border:1px solid rgba(15,40,90,.16); border-radius:12px; background:#fff; color:#0c2545; outline:none;"><button data-act="clockUnknown" data-arg="' + m.event_id + '" style="' + us + '">Não sei</button></div></div>';
        });
        ci += '</div>';
        if (o.is_last && !o.can_skip) ci += '<div style="margin-top:12px; font-size:13px; color:#b35c00; font-weight:600;">Você é o último a sair: preencha os números ou marque "Não sei".</div>';
      } else {
        ci += '<div style="background:rgba(14,122,78,.08); border-radius:16px; padding:18px; text-align:center; color:#0e7a4e; font-weight:700; font-size:15px; display:flex; align-items:center; justify-content:center; gap:9px;">' + svgr(CHECK, 19, 2.4) + 'Todas as produções de hoje têm contagem. Pode sair tranquilo!</div>';
      }
      ci += '<div style="display:flex; gap:11px; margin-top:22px;">' + ghostBtn('closeOverlay', 'Voltar') + '<button data-act="doClockOut" style="flex:1.5; border:0; background:linear-gradient(135deg,#d97712,#b35c00); color:#fff; border-radius:15px; padding:15px; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; cursor:pointer; box-shadow:0 14px 30px -14px rgba(179,92,0,.7); display:flex; align-items:center; justify-content:center; gap:8px;">' + svgr(DOOR, 17, 2) + 'Confirmar e sair</button></div></div>';
      return ci;
    }
    if (o.type === 'forgotten') {
      var p = o.prompt;
      var meta = [p.last_activity_at ? 'última atividade ' + p.last_activity_at : '', p.expected_end_time ? 'saída prevista ' + p.expected_end_time : ''].filter(Boolean).join(' · ');
      return cardOpen(440, true) + '<span style="display:inline-flex; width:60px; height:60px; border-radius:50%; background:rgba(179,92,0,.12); color:#b35c00; align-items:center; justify-content:center; margin-bottom:16px;">' + svgr(CLOCK, 30, 1.7) + '</span><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:21px; color:#0c2545; margin-bottom:6px;">' + esc(p.person_name) + ' ainda está trabalhando?</div><div style="font-size:13px; color:#566681; margin-bottom:22px;">' + esc(meta) + '</div><div style="display:flex; flex-direction:column; gap:11px;"><button data-act="forgottenYes" style="border:0; background:linear-gradient(135deg, color-mix(in srgb, var(--accent) 86%, #19c277), var(--accent)); color:#fff; border-radius:15px; padding:16px; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; cursor:pointer; box-shadow:0 14px 30px -14px color-mix(in srgb, var(--accent) 60%, transparent); display:flex; align-items:center; justify-content:center; gap:8px;">' + svgr(CHECK, 17, 2.6) + 'Sim, ainda está na linha</button><button data-act="forgottenNo" style="border:1px solid rgba(179,38,30,.25); background:rgba(255,255,255,.6); color:#b3261e; border-radius:15px; padding:16px; font-weight:700; font-size:15px; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px;">' + svgr('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>', 16, 2.6) + 'Não, fazer checkout dela</button></div></div>';
    }
    if (o.type === 'gap') return gapInner(o);
    if (o.type === 'eod') return eodInner(o);
    return '';
  }
  // PASSADA 2 — overlay de GAP (amarelo): justifica >20min sem atividade antes de iniciar
  var GAP_REASONS = [
    ['bathroom', '🚻 Banheiro'], ['food', '💧 Água/Comida'], ['meeting', '👥 Reunião'],
    ['help', '🆘 Ajudando colega'], ['outside', '🚪 Saí do prédio'], ['phone', '📞 Telefonema'],
    ['cleaning', '🧹 Limpeza rápida'], ['machine', '⚙️ Ajuste máquina'], ['other', '⋯ Outro'],
  ];
  function gapInner(o) {
    var h = cardOpen(520);
    h += '<div style="display:flex; align-items:center; gap:13px; margin-bottom:6px;"><span style="flex:none; width:48px; height:48px; border-radius:15px; background:rgba(217,145,0,.14); color:#b35c00; display:flex; align-items:center; justify-content:center;">' + svgr(CLOCK, 26, 1.8) + '</span><div><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:19px; color:#0c2545;">⏱️ Gap de atividade detectado</div><div style="font-size:13px; color:#8a5a00; font-weight:600; margin-top:2px;">Você ficou ' + (o.gapMinutes || '?') + ' min sem registrar atividade</div></div></div>';
    h += '<div style="display:grid; grid-template-columns:repeat(3,1fr); gap:9px; margin:16px 0 14px;">';
    GAP_REASONS.forEach(function (r) {
      var on = o.jtype === r[0];
      h += '<button data-act="gapReason" data-arg="' + r[0] + '" style="cursor:pointer; border-radius:13px; padding:13px 8px; font-weight:700; font-size:12.5px; text-align:center; border:' + (on ? '0' : '1px solid rgba(15,40,90,.14)') + '; background:' + (on ? 'linear-gradient(135deg,#d99100,#b35c00)' : 'rgba(255,255,255,.7)') + '; color:' + (on ? '#fff' : '#42566f') + ';">' + esc(r[1]) + '</button>';
    });
    h += '</div>';
    h += '<div style="font-size:13px; font-weight:700; color:#8a5a00; margin-bottom:8px;">📝 Explique (obrigatório)</div>';
    h += '<textarea data-input="gapNote" data-focus="gapNote" placeholder="O que aconteceu nesse tempo…" style="width:100%; min-height:80px; font-size:16px; padding:13px 15px; border:1px solid rgba(217,145,0,.35); border-radius:14px; background:#fff; color:#0c2545; outline:none;">' + esc(o.note || '') + '</textarea>';
    h += '<div style="display:flex; justify-content:flex-end; margin-top:8px;">' + voiceBtn('gap') + '</div>';
    h += '<div style="display:flex; gap:11px; margin-top:18px;">' + ghostBtn('cancelGap', 'Cancelar') + '<button data-act="doGapJustify" style="flex:1.6; border:0; background:linear-gradient(135deg,#d99100,#b35c00); color:#fff; border-radius:15px; padding:15px; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; cursor:pointer; box-shadow:0 14px 30px -14px rgba(179,92,0,.6); display:flex; align-items:center; justify-content:center; gap:8px;">' + svgr(CHECK, 18, 2.6) + 'Justificar e iniciar</button></div>';
    h += '</div>';
    return h;
  }
  // PASSADA 2 — overlay FIM DO DIA: confirma os totais produzidos
  function eodInner(o) {
    var h = cardOpen(540);
    h += '<div style="display:flex; align-items:center; gap:13px; margin-bottom:6px;"><span style="flex:none; width:48px; height:48px; border-radius:15px; background:rgba(15,76,146,.12); color:#0f4c92; display:flex; align-items:center; justify-content:center;">' + svgr('<path d="M3 3v18h18"></path><rect x="7" y="11" width="3" height="6"></rect><rect x="12" y="7" width="3" height="10"></rect><rect x="17" y="13" width="3" height="4"></rect>', 26, 1.9) + '</span><div><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:19px; color:#0c2545;">📊 Totais do dia</div><div style="font-size:13px; color:#5a6e87; margin-top:2px;">Confirme quantas bottles saíram de cada produto hoje.</div></div></div>';
    h += '<div class="hf-scroll" style="display:flex; flex-direction:column; gap:10px; margin:14px 0; max-height:340px; overflow-y:auto;">';
    if (!(o.products || []).length) h += '<div style="font-size:14px; color:#566681; text-align:center; padding:16px;">Nenhuma produção registrada hoje. Pode confirmar mesmo assim.</div>';
    (o.products || []).forEach(function (p) {
      var v = (o.totals && o.totals[p.product_id]) || '';
      h += '<div style="background:rgba(255,255,255,.7); border:1px solid rgba(15,40,90,.12); border-radius:14px; padding:12px 14px;"><div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;"><span style="font-weight:700; font-size:15px; color:#0c2545;">' + esc(p.product) + '</span><span style="font-size:12px; color:#566681;">já registrados: ' + (p.count_so_far || 0) + '</span></div><input value="' + esc(v) + '" data-input="eodBottles" data-arg="' + p.product_id + '" inputmode="numeric" placeholder="Total de bottles do dia" style="width:100%; min-height:50px; font-size:16px; padding:10px 14px; border:1px solid rgba(15,40,90,.16); border-radius:12px; background:#fff; color:#0c2545; outline:none;"></div>';
    });
    h += '</div>';
    h += '<textarea data-input="eodNote" placeholder="Observação do dia (opcional)" style="width:100%; min-height:60px; font-size:16px; padding:12px 15px; border:1px solid rgba(15,40,90,.16); border-radius:14px; background:#fff; color:#0c2545; outline:none;">' + esc(o.note || '') + '</textarea>';
    h += '<div style="display:flex; gap:11px; margin-top:18px;">' + ghostBtn('closeOverlay', 'Mais tarde') + '<button data-act="doEodSubmit" style="flex:1.6; border:0; background:linear-gradient(135deg,#2f7ae0,#0f4c92); color:#fff; border-radius:15px; padding:15px; font-weight:800; font-size:16px; font-family:\'Sora\',sans-serif; cursor:pointer; box-shadow:0 14px 30px -14px rgba(15,76,146,.6); display:flex; align-items:center; justify-content:center; gap:8px;">' + svgr(CHECK, 18, 2.6) + 'Salvar Totais</button></div>';
    h += '</div>';
    return h;
  }

  // ── ALERT vermelho central (BUG 3) ─────────────────────────
  function alertKey() { var a = S.alert; return a ? 'alert:' + a.title + '|' + a.message : ''; }
  function alertInner() {
    var a = S.alert || {};
    var okBtn = '<button data-act="alertOk" id="hf-alert-ok" style="' + (a.cancel ? 'flex:1.5;' : 'width:100%;') + ' min-height:56px; border:0; border-radius:16px; background:linear-gradient(135deg,#cf463c,#b3261e); color:#fff; font-family:\'Sora\',sans-serif; font-weight:700; font-size:18px; cursor:pointer; box-shadow:0 14px 30px -14px rgba(179,38,30,.7);">' + esc(a.okLabel || 'Entendi') + '</button>';
    var btns = a.cancel
      ? '<div style="display:flex; gap:11px; margin-top:24px;"><button data-act="alertCancel" style="flex:1; border:1px solid rgba(15,40,90,.14); background:rgba(255,255,255,.6); color:#42566f; border-radius:16px; padding:15px; font-weight:700; font-size:15px; cursor:pointer;">' + esc(a.cancel) + '</button>' + okBtn + '</div>'
      : '<div style="margin-top:24px;">' + okBtn + '</div>';
    return '<div style="width:min(94vw,460px); background:rgba(255,255,255,.95); backdrop-filter:blur(28px) saturate(1.5); border:3px solid #b3261e; border-radius:28px; padding:clamp(28px,4vw,40px); box-shadow:0 50px 110px -40px rgba(179,38,30,.5); text-align:center; animation:hfPop .35s cubic-bezier(.2,.8,.2,1) both, hfShake .4s .1s both;">'
      + '<span style="display:inline-flex; align-items:center; justify-content:center; color:#b3261e; margin-bottom:6px;">' + svgr(WARN, 64, 2) + '</span>'
      + '<div style="font-family:\'Sora\',sans-serif; font-weight:800; font-size:24px; color:#b3261e;">' + esc(a.title || 'Atenção') + '</div>'
      + '<div style="font-family:\'Manrope\',sans-serif; font-weight:500; font-size:17px; color:#0c2545; line-height:1.5; margin-top:16px;">' + esc(a.message || '') + '</div>'
      + btns
      + '</div>';
  }
  var alertResolve = null;
  // showAlert resolve(true) = confirmou (OK/Enter); resolve(false) = cancelou/dismiss.
  function showAlert(opts) { S.alert = opts || {}; render(); return new Promise(function (res) { alertResolve = res; }); }
  function closeAlert(result) { if (!S.alert) return; S.alert = null; render(); var r = alertResolve; alertResolve = null; if (r) r(result === true); }

  // ── SETTINGS (admin) ───────────────────────────────────────
  function settingsKey() { return 'settings:' + JSON.stringify(S.settings); }
  function toggle(act, on, color) { return '<button data-act="' + act + '" style="flex:none; position:relative; width:48px; height:28px; border-radius:999px; border:0; cursor:pointer; transition:background .2s; background:' + (on ? (color || accent()) : 'rgba(15,40,90,.18)') + ';"><span style="position:absolute; top:3px; left:' + (on ? '23px' : '3px') + '; width:22px; height:22px; border-radius:50%; background:#fff; transition:left .2s; box-shadow:0 2px 6px rgba(0,0,0,.2);"></span></button>'; }
  function seg(act, arg, label, on) { var ac = accent(); return '<button data-act="' + act + '" data-arg="' + arg + '" style="flex:1; cursor:pointer; border-radius:11px; padding:9px 4px; font-weight:700; font-size:12.5px; transition:all .12s; border:' + (on ? '0' : '1px solid rgba(15,40,90,.12)') + '; background:' + (on ? ac : 'rgba(255,255,255,.6)') + '; color:' + (on ? '#fff' : '#5a6e87') + ';">' + esc(label) + '</button>'; }
  function settingsInner() {
    var st = S.settings;
    var h = '<div data-act="toggleSettings" style="position:fixed; inset:0;"></div><div style="position:fixed; top:74px; right:clamp(14px,2.6vw,30px); width:min(92vw,320px); background:rgba(255,255,255,.9); backdrop-filter:blur(30px) saturate(1.5); border:1px solid rgba(255,255,255,.85); border-radius:24px; box-shadow:0 40px 90px -34px rgba(12,37,69,.55); padding:20px;">';
    h += '<div style="display:flex; align-items:center; gap:9px; margin-bottom:16px;"><span style="color:#0f4c92;">' + svg(ICONS.gear, 18, 1.8) + '</span><div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:16px; color:#0c2545;">Ajustes do admin</div></div>';
    h += '<div style="display:flex; align-items:center; justify-content:space-between; padding:11px 0; border-bottom:1px solid rgba(15,40,90,.08);"><div><div style="font-weight:700; font-size:14px; color:#0c2545;">Frases inspiradoras</div><div style="font-size:12px; color:#566681;">Mensagens flutuantes</div></div>' + toggle('toggleMantras', st.mantras) + '</div>';
    h += '<div style="padding:12px 0 6px;"><div style="font-weight:700; font-size:13px; color:#42566f; margin-bottom:8px;">Idioma das frases</div><div style="display:flex; gap:6px;">' + seg('setLang', 'rotate', 'Girar', st.mantraLang === 'rotate') + seg('setLang', 'pt', 'PT', st.mantraLang === 'pt') + seg('setLang', 'es', 'ES', st.mantraLang === 'es') + seg('setLang', 'en', 'EN', st.mantraLang === 'en') + '</div></div>';
    h += '<div style="padding:12px 0 6px;"><div style="font-weight:700; font-size:13px; color:#42566f; margin-bottom:8px;">Fase do dia (cor do ambiente)</div><div style="display:flex; gap:6px;">' + seg('setPhase', 'auto', 'Auto', st.dayPhase === 'auto') + seg('setPhase', 'morning', 'Manhã', st.dayPhase === 'morning') + seg('setPhase', 'afternoon', 'Tarde', st.dayPhase === 'afternoon') + seg('setPhase', 'evening', 'Noite', st.dayPhase === 'evening') + '</div></div>';
    h += '<div style="padding:12px 0 4px;"><div style="font-weight:700; font-size:13px; color:#42566f; margin-bottom:8px;">Densidade do ambiente</div><div style="display:flex; gap:6px;">' + seg('setDens', 'low', 'Leve', st.density === 'low') + seg('setDens', 'medium', 'Médio', st.density === 'medium') + seg('setDens', 'high', 'Cheio', st.density === 'high') + '</div></div>';
    h += '<div style="margin-top:8px; padding-top:14px; border-top:1px solid rgba(15,40,90,.1);"><div style="display:flex; align-items:center; justify-content:space-between; gap:10px;"><div><div style="display:flex; align-items:center; gap:7px; font-weight:700; font-size:14px; color:#0c2545;">Alerta de duração<span style="font-size:9.5px; font-weight:800; letter-spacing:.04em; color:#b35c00; background:rgba(217,145,0,.14); padding:2px 6px; border-radius:6px;">BETA</span></div><div style="font-size:12px; color:#566681; margin-top:2px;">A tarefa muda de cor se demorar demais</div></div>' + toggle('toggleAging', st.aging, '#d97712') + '</div>';
    if (st.aging) { h += '<div style="margin-top:13px; display:flex; flex-direction:column; gap:9px;">' + stepper('Avisar após', 'warn', st.warnMin) + stepper('Marcar atrasada após', 'over', st.overMin) + '</div>'; }
    h += '</div></div>';
    return h;
  }
  function stepper(label, key, val) { return '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px;"><span style="font-size:13px; font-weight:600; color:#42566f;">' + esc(label) + '</span><span style="display:flex; align-items:center; gap:8px;"><button data-act="agingStep" data-arg="' + key + ':-" style="width:30px; height:30px; border-radius:9px; border:1px solid rgba(15,40,90,.16); background:rgba(255,255,255,.7); color:#42566f; font-weight:800; font-size:17px; cursor:pointer; line-height:1;">−</button><span style="min-width:58px; text-align:center; font-family:\'Sora\',sans-serif; font-weight:700; font-size:14px; color:#0c2545;">' + val + ' min</span><button data-act="agingStep" data-arg="' + key + ':+" style="width:30px; height:30px; border-radius:9px; border:1px solid rgba(15,40,90,.16); background:rgba(255,255,255,.7); color:#42566f; font-weight:800; font-size:17px; cursor:pointer; line-height:1;">+</button></span></div>'; }

  // ════════════════════════════════════════════════════════════
  // DADOS
  // ════════════════════════════════════════════════════════════
  // dia EDT (NY) atual — usado pra detectar virada de dia com a página aberta
  function edtDay() { try { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); } catch (e) { return ''; } }
  function loadData() {
    if (!S.session) return Promise.resolve();
    S.dataDay = edtDay(); // carimba o dia dos dados (rollover detecta virada)
    loadProductImages(); // Bug 3: imagens dos produtos (uma vez)
    return Promise.all([
      api('/api/v3/architect/person/' + S.session.person.id + '/today', { headers: { 'X-Operator-Id': String(S.session.person.id) } }).catch(function () { return { events: [] }; }),
      api('/api/v3/op/active-operators').catch(function () { return { operators: [] }; }),
      api('/api/v3/op/ems/my-activity').catch(function () { return { detected: null }; }), // FASE FORM: detecção passiva
    ]).then(function (r) {
      var mine = r[0] || { events: [] }; var ops = r[1] || { operators: [] };
      var evs = mine.events || [];
      S.myTasks = evs.filter(function (e) { return !e.ended_at && !e.is_unfinished; }); // FASE PAUSA: unfinished some
      S.completedToday = evs.filter(function (e) { return e.ended_at; }).length;
      S.goal = mine.goal || Math.max(8, evs.length);
      S.team = ops.operators || [];
      S.emsDetected = (r[2] && r[2].detected) || null;
      render();
    });
  }
  // Bug 3: mapa product_id→imagem (EMS), uma vez por sessão. Falha = thumbs '?'.
  function loadProductImages() {
    if (S.prodImg) return;
    S.prodImg = {}; // evita refetch concorrente
    api('/api/v3/op/products/images').then(function (r) { S.prodImg = (r && r.by_id) || {}; render(); }).catch(function () {});
  }
  // FASE 4: lotes disponíveis no EMS pro slug (production_line/revisão).
  function loadAvailableLots(slug) {
    api('/api/v3/op/lots/available?slug=' + encodeURIComponent(slug)).then(function (r) {
      if (S.flow && S.flow.slug === slug && S.flow.step === 'pipeline') { S.flow.lots = (r && r.lots) || []; S.flow.emsStale = !!(r && r.ems_stale); render(); }
    }).catch(function () { if (S.flow && S.flow.step === 'pipeline') { S.flow.lots = []; render(); } });
  }
  // Bug 2: lotes recentes filtrados pelo produto escolhido (local + status EMS).
  function loadRecentBatches(pid) {
    if (!pid) { if (S.flow) { S.flow.recentBatches = []; render(); } return; }
    api('/api/v3/op/batches/recent?product_id=' + pid + '&limit=8').then(function (r) {
      if (S.flow && S.flow.supplementId === pid) { S.flow.recentBatches = (r && r.batches) || []; render(); }
    }).catch(function () { if (S.flow && S.flow.supplementId === pid) { S.flow.recentBatches = []; render(); } });
  }

  // ── voz (Web Speech → nota; timer/transcript CIRÚRGICOS, sem render) ──
  var voiceTimer = null, sr = null;
  function startVoice(target) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    S.voice = { on: true, secs: 0, target: target }; refreshVoiceBtn(target); // só o botão entra em "gravando"
    voiceTimer = setInterval(function () {
      S.voice.secs += 1;
      if (S.voice.secs >= 60) { stopVoice(); return; }
      var t = document.getElementById('voice-timer'); if (t) t.textContent = String(S.voice.secs); // cirúrgico
    }, 1000);
    if (SR) {
      try {
        var r = new SR(); r.lang = 'pt-BR'; r.continuous = true; r.interimResults = true;
        var base = target === 'flow' ? (S.flow && S.flow.note || '') : (target === 'finishReason' ? (S.overlay && S.overlay.reason || '') : (S.overlay && S.overlay.note || ''));
        r.onresult = function (e) {
          var t = ''; for (var i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
          var val = (base ? base + ' ' : '') + t;
          // cirúrgico: atualiza o textarea-alvo direto, mantém estado, SEM render
          if (target === 'flow' && S.flow) { S.flow.note = val; var ta = LYR.flow.el.querySelector('[data-input="note"]'); if (ta) ta.value = val; }
          else if (target === 'finishReason' && S.overlay) { S.overlay.reason = val; var tr = LYR.overlay.el.querySelector('[data-input="finReason"]'); if (tr) tr.value = val; }
          else if (S.overlay) { S.overlay.note = val; var ta2 = LYR.overlay.el.querySelector('[data-input="ovNote"], [data-input="gapNote"]'); if (ta2) ta2.value = val; }
        };
        r.onerror = function () {}; r.start(); sr = r;
      } catch (e) { sr = null; }
    } else { toast('Neste aparelho a voz não está disponível — escreva a nota'); }
  }
  function stopVoice() { clearInterval(voiceTimer); try { sr && sr.stop(); } catch (e) {} sr = null; var target = S.voice.target; S.voice = { on: false, secs: 0, target: null }; refreshVoiceBtn(target); }

  // ════════════════════════════════════════════════════════════
  // HANDLERS (delegação)
  // ════════════════════════════════════════════════════════════
  function flowDefaults(extra) { var n = new Date(); var ap = n.getHours() >= 12 ? 'PM' : 'AM'; var m = String(Math.floor(n.getMinutes() / 5) * 5).padStart(2, '0'); return Object.assign({ step: 'group', cowork: [], note: '', forgot: false, tpH: '', tpM: m, tpAP: ap, endH: '', endM: m, endAP: ap, finished: 'no', ordersInput: '', adjOn: false, adjMode: 'additional', adjQty: '', requires_product: false }, extra || {}); }
  function bump() { if (S.session && S.session.auto_logoff_seconds) S.logoffLeft = S.session.auto_logoff_seconds; }
  function flowNoteHighlight() { var ta = LYR.flow.el.querySelector('[data-focus="note"]'); if (ta) { ta.focus(); ta.style.boxShadow = '0 0 0 3px rgba(179,38,30,.45)'; ta.style.animation = 'hfShake .4s'; setTimeout(function () { ta.style.boxShadow = ''; ta.style.animation = ''; }, 1200); } }
  function flowOrdersHighlight() { var inp = LYR.flow.el.querySelector('[data-focus="orders"]'); if (inp) { inp.focus(); inp.style.boxShadow = '0 0 0 3px rgba(179,38,30,.45)'; inp.style.animation = 'hfShake .4s'; setTimeout(function () { inp.style.boxShadow = ''; inp.style.animation = ''; }, 1200); } }

  var ACT = {
    pinkey: function (k) {
      if (k === '⌫') S.pin = S.pin.slice(0, -1);
      else if (k === '✓') { if (S.pin.length === 4) return submitPin(); }
      else if (S.pin.length < 4) S.pin += k;
      if (S.pin.length === 4 && k !== '✓') { render(); return submitPin(); }
      render();
    },
    toggleSettings: function () { S.settingsOpen = !S.settingsOpen; render(); },
    logout: function () { doLogout('manual'); },
    clockout: function () { openClock(); },
    startFlow: function () { S.flow = flowDefaults(); render(); },
    cancelFlow: function () { S.flow = null; render(); },
    flowBack: function () {
      var f = S.flow; if (!f) return;
      var isPipe = usesLotList(f.slug);
      if (f.step === 'type') f.step = 'group';
      else if (f.step === 'pipeline') f.step = 'type';
      else if (f.step === 'supp') f.step = isPipe ? 'pipeline' : 'type'; // catálogo volta pra lista EMS
      else if (f.step === 'batch') f.step = 'supp';
      else if (f.step === 'confirm') f.step = f.viaPipeline ? 'pipeline' : (f.requires_product ? 'batch' : 'type');
      else if (f.step === 'finished') f.step = 'confirm';
      else { S.flow = null; }
      render();
    },
    pickGroup: function (key) { S.flow.groupKey = key; S.flow.step = 'type'; render(); },
    quickLunch: function (slug) { S.flow.slug = slug; S.flow.requires_product = false; S.flow.step = 'confirm'; render(); },
    pickType: function (slug) {
      var m = typeMeta(slug); S.flow.slug = slug; S.flow.requires_product = !!m.requires_product; S.flow.viaPipeline = false;
      // FASE 4 + FASE FORM — linha/revisão/formulação: lista LOTE+PRODUTO do EMS
      // (não pede suplemento direto; lista vazia → operador usa o catálogo).
      if (usesLotList(slug)) {
        S.flow.step = 'pipeline'; S.flow.lots = null; S.flow.lotQuery = ''; S._focus = 'lotQuery'; render();
        loadAvailableLots(slug); return;
      }
      S.flow.step = m.requires_product ? 'supp' : 'confirm'; S._focus = m.requires_product ? 'query' : null; render();
    },
    pickLot: function (batch, el) {
      S.flow.batch = batch || null;
      S.flow.supplement = el ? (el.getAttribute('data-prod') || null) : null;
      S.flow.supplementId = null; // veio do EMS; sem product_id local (auto-create v19 cobre)
      S.flow.viaPipeline = true; S.flow.step = 'confirm'; S._focus = null; render();
    },
    pickCatalog: function () { S.flow.viaPipeline = false; S.flow.step = 'supp'; S._focus = 'query'; render(); }, // fallback catálogo
    // FASE PAUSA — "Voltar ao trabalho": termina a pausa → backend descongela tudo
    resumeWork: function (id) {
      if (S.resumeBusy) return;
      S.resumeBusy = true; render();
      api('/api/v3/op/event/' + id + '/end', { method: 'POST', body: {} }).then(function (res) {
        S.resumeBusy = false; S.pulse = 0.8; loadData();
        // regra Bruno: ao voltar da pausa, pergunta CONTINUAR ou FINALIZAR cada tarefa
        // que estava congelada (se finalizar e pedir quantidade, o finish já cobra).
        var tasks = (res && res.resumed_tasks) || [];
        if (tasks.length) resumePrompt(tasks, 0); else toast('De volta ao trabalho ✓');
      }).catch(function () { S.resumeBusy = false; toast('Não consegui retomar — tente Finalizar a pausa'); render(); });
    },
    // FASE FORM — tocar "Registrar" abre a pergunta "Quando começou?" (Parte 2):
    // Agora (toque) OU marcar outra hora (esqueceu de registrar). Nunca cria sem confirmar.
    registerDetected: function () {
      var d = S.emsDetected; if (!d || S.detectBusy) return;
      var n = new Date(); var ap = n.getHours() >= 12 ? 'PM' : 'AM';
      S.overlay = { type: 'detectWhen', det: d, pickTime: false, tpH: '', tpM: String(Math.floor(n.getMinutes() / 5) * 5).padStart(2, '0'), tpAP: ap };
      render();
    },
    detectPickTime: function () { var o = S.overlay; if (!o) return; o.pickTime = true; if (!o.tpH) { var n = new Date(); o.tpH = String(n.getHours() % 12 || 12); o.tpAP = n.getHours() >= 12 ? 'PM' : 'AM'; } render(); },
    detectModeNow: function () { var o = S.overlay; if (!o) return; o.pickTime = false; render(); },
    toggleDetectAP: function () { var o = S.overlay; if (!o) return; var t = o.tpAP === 'AM' ? 'PM' : 'AM'; if (apAllowed(t, startWindow())) { o.tpAP = t; render(); } },
    doRegisterDetectedNow: function () { doRegisterDetected(null); },
    doRegisterDetectedAt: function () { var o = S.overlay; if (!o) return; var st = startStatus(o); if (!st.iso || st.block) { toast(st.text || 'Escolha uma hora válida'); return; } doRegisterDetected(st.iso); },
    setLotQuery: function () {},
    pickSupp: function (name, el) {
      S.flow.supplement = name;
      var pid = el ? parseInt(el.getAttribute('data-pid'), 10) : NaN;
      S.flow.supplementId = Number.isFinite(pid) ? pid : null;
      S.flow.recentBatches = null; // estado "carregando"
      S.flow.step = 'batch'; S._focus = 'batch'; render();
      loadRecentBatches(S.flow.supplementId);
    },
    pickBatch: function (b) { S.flow.batch = b; S.flow.step = 'confirm'; S._focus = null; render(); },
    skipBatch: function () { S.flow.batch = null; S.flow.step = 'confirm'; S._focus = null; render(); },
    batchOk: function () { var v = (S.flow.batchInput || '').trim(); S.flow.batch = v || null; S.flow.step = 'confirm'; S._focus = null; render(); },
    // "Agora" INICIA a tarefa direto (regra Bruno: o botão Agora começa o processo).
    // Valida campos obrigatórios (quantidade/motivo) como o "Começar"; se faltar,
    // alerta e foca o campo. "Esqueci de marcar" (modeForgot) segue usando o Começar.
    modeNow: function () { S.flow.forgot = false; confirmStart(); },
    modeForgot: function () { S.flow.forgot = true; if (!S.flow.tpH) { var n = new Date(); S.flow.tpH = String(n.getHours() % 12 || 12); S.flow.tpAP = n.getHours() >= 12 ? 'PM' : 'AM'; } render(); },
    toggleAP: function () { var t = S.flow.tpAP === 'AM' ? 'PM' : 'AM'; if (apAllowed(t, startWindow())) { S.flow.tpAP = t; render(); } },
    toggleEndAP: function () { var t = S.flow.endAP === 'AM' ? 'PM' : 'AM'; if (apAllowed(t, endWindow(S.flow))) { S.flow.endAP = t; render(); } },
    toggleCowork: function (id) { id = parseInt(id, 10); var i = S.flow.cowork.indexOf(id); if (i >= 0) S.flow.cowork.splice(i, 1); else S.flow.cowork.push(id); render(); },
    adjToggle: function () { S.flow.adjOn = !S.flow.adjOn; render(); },
    adjModeAdd: function () { S.flow.adjMode = 'additional'; render(); },
    adjModeReset: function () { S.flow.adjMode = 'reset'; render(); },
    reclassify: function (id) { S.overlay = { type: 'reclassify', eventId: id }; render(); },
    doReclassify: function (slug) {
      var o = S.overlay; if (!o || o.type !== 'reclassify') return;
      api('/api/v3/op/event/' + o.eventId + '/reclassify', { method: 'POST', body: { activity_slug: slug } })
        .then(function (r) { S.overlay = null; toast(r && r.unchanged ? 'Já era esse tipo' : 'Tipo trocado ✓'); loadData(); })
        .catch(function (e) { toast(e.message); });
    },
    confirmStart: function () { confirmStart(); },
    finishedNo: function () { S.flow.finished = 'no'; render(); },
    finishedYes: function () { S.flow.finished = 'yes'; if (!S.flow.endH) { S.flow.endH = String(new Date().getHours() % 12 || 12); S.flow.endAP = new Date().getHours() >= 12 ? 'PM' : 'AM'; } render(); },
    commitRetro: function () { commitRetro(); },
    finish: function (id) {
      var t = S.myTasks.find(function (x) { return String(x.id) === String(id); }) || {};
      t.id = id;
      openFinishTask(t);
    },
    doFinish: function () { doFinish(); },
    join: function (id, el) { S.overlay = { type: 'join', eventId: id, name: el.getAttribute('data-name') || 'colega', sub: el.getAttribute('data-sub') || '' }; render(); },
    doJoin: function () { var o = S.overlay; api('/api/v3/op/event/' + o.eventId + '/join', { method: 'POST', body: {} }).then(function () { S.overlay = null; S.pulse = 0.8; toast('Você entrou junto!'); loadData(); }).catch(function (e) { toast(e.message); }); },
    note: function () { S.overlay = { type: 'note', note: '' }; S._focus = 'ovNote'; render(); },
    saveNote: function () { var o = S.overlay; var txt = (o.note || '').trim(); if (!txt) { showAlert({ title: 'Nota vazia', message: 'Escreva ou grave algo antes de salvar a nota.', okLabel: 'Entendi' }); return; } api('/api/v3/op/note', { method: 'POST', body: { text: txt } }).then(function () { S.overlay = null; toast('Nota salva'); }).catch(function (e) { toast(e.message); }); },
    closeOverlay: function () { if (S.voice.on) stopVoice(); S.overlay = null; render(); },
    // PASSADA 2 — gap
    gapReason: function (type) { if (S.overlay) { S.overlay.jtype = type; render(); } },
    cancelGap: function () { if (S.voice.on) stopVoice(); S.overlay = null; S.flow = null; S.gapPending = null; render(); }, // NÃO inicia, volta home
    doGapJustify: function () { doGapJustify(); },
    // PASSADA 2 — fim do dia
    doEodSubmit: function () { doEodSubmit(); },
    doClockOut: function () { doClockOut(); },
    clockUnknown: function (id) {
      var o = S.overlay; o.unknown = o.unknown || {}; o.unknown[id] = !o.unknown[id]; if (o.unknown[id]) { o.counts = o.counts || {}; delete o.counts[id]; }
      // cirúrgico: atualiza botão + input sem rebuild (sem re-pop do modal)
      var lyr = LYR.overlay.el; var unk = o.unknown[id];
      var btn = lyr.querySelector('[data-act="clockUnknown"][data-arg="' + id + '"]'); var inp = lyr.querySelector('[data-input="clockCount"][data-arg="' + id + '"]');
      if (btn) { btn.style.border = unk ? '0' : '1px solid rgba(15,40,90,.14)'; btn.style.background = unk ? '#42566f' : 'rgba(255,255,255,.7)'; btn.style.color = unk ? '#fff' : '#42566f'; }
      if (inp) { inp.disabled = unk; if (unk) inp.value = ''; }
      LYR.overlay.key = overlayKey(); // mantém key coerente (evita rebuild no próximo render)
    },
    forgottenYes: function () { resolveForgotten(true); },
    forgottenNo: function () { resolveForgotten(false); },
    voice: function (target) { if (S.voice.on) stopVoice(); else startVoice(target); },
    alertOk: function () { closeAlert(true); },
    alertCancel: function () { closeAlert(false); },
    toggleExc: function () { if (S.overlay) { S.overlay.exc = !S.overlay.exc; render(); } },
    toggleMantras: function () { S.settings.mantras = !S.settings.mantras; saveSettings(); render(); },
    setLang: function (v) { S.settings.mantraLang = v; saveSettings(); render(); },
    setPhase: function (v) { S.settings.dayPhase = v; saveSettings(); render(); },
    setDens: function (v) { S.settings.density = v; saveSettings(); render(); },
    toggleAging: function () { S.settings.aging = !S.settings.aging; saveSettings(); render(); },
    agingStep: function (arg) { var p = arg.split(':'); var key = p[0] === 'warn' ? 'warnMin' : 'overMin'; var d = p[1] === '+' ? 5 : -5; S.settings[key] = Math.max(5, Math.min(600, (S.settings[key] || 45) + d)); saveSettings(); render(); },
  };

  function submitPin() {
    var pin = S.pin; S.pin = '';
    api('/api/v3/op/auth/login', { method: 'POST', body: { pin: pin } }).then(function (r) {
      S.session = { token: r.session_token, person: r.person, auto_logoff_seconds: r.auto_logoff_seconds };
      S.pinError = ''; S.screen = 'home'; S.pulse = 0.7; bump(); render();
      loadData();
      if (r.forgotten_check_prompts && r.forgotten_check_prompts.length) { forgottenQueue = r.forgotten_check_prompts.slice(); nextForgotten('login'); }
      startTimers();
    }).catch(function (e) {
      S.pinError = e.status === 429 ? 'Muitas tentativas — espera 1 min' : 'PIN incorreto'; S.shake = true; render();
      setTimeout(function () { S.shake = false; render(); }, 650);
    });
  }
  function endSession() { S.session = null; S.screen = 'login'; S.pin = ''; S.myTasks = []; S.team = []; S.overlay = null; S.flow = null; S.settingsOpen = false; S.alert = null; stopTimers(); render(); }
  function doLogout(reason) { api('/api/v3/op/auth/logout', { method: 'POST', body: { reason: reason } }).catch(function () {}); endSession(); }

  function confirmStart() {
    var f = S.flow; var m = typeMeta(f.slug);
    if (m.note_required && !(f.note || '').trim()) { showAlert({ title: 'Motivo obrigatório', message: 'Essa tarefa precisa de um motivo. Escreva ou grave por voz antes de começar.', okLabel: 'Entendi' }).then(flowNoteHighlight); return; }
    if (m.orders_required && !(parseInt(f.ordersInput, 10) > 0)) { showAlert({ title: 'Quantidade obrigatória', message: 'Informe quantas ordens vai imprimir (um número maior que 0) antes de começar.', okLabel: 'Entendi' }).then(flowOrdersHighlight); return; }
    if (f.forgot) {
      var st = startStatus(f);
      if (!f.tpH || !st.iso) { showAlert({ title: 'Escolha a hora', message: 'Selecione quando a tarefa começou.', okLabel: 'Entendi' }); return; }
      if (st.block) { showAlert({ title: 'Hora inválida', message: st.text + '.', okLabel: 'Entendi' }); return; }
      // confirmação (cedo/>2h) fica pro commitRetro, que junta início+fim num diálogo só.
      f.step = 'finished'; render(); return;
    }
    postStart(null, null);
  }
  // FASE FORM Parte 2 — registra a detecção com a hora escolhida (NOW se null).
  function doRegisterDetected(startedAt) {
    var o = S.overlay; var d = (o && o.det) || S.emsDetected; if (!d || S.detectBusy) return;
    S.detectBusy = true; render();
    var body = { ems_key: d.ems_key }; if (startedAt) body.started_at = startedAt;
    api('/api/v3/op/ems/register-detected', { method: 'POST', body: body }).then(function (r) {
      S.detectBusy = false; S.overlay = null; S.emsDetected = null; S.pulse = 1;
      toast((r && r.late_flag) ? 'Registrada — início antigo, admin avisado' : 'Tarefa registrada ✓'); loadData();
    }).catch(function (e) {
      S.detectBusy = false;
      var code = (e && e.body && e.body.error) || ''; // api() põe detail em e.message; code em e.body.error
      if (code === 'not_detected') { S.overlay = null; S.emsDetected = null; toast('O sistema não mostra mais essa atividade.'); }
      else if (code === 'started_at_future') toast('A hora não pode ser no futuro.');
      else toast('Não consegui registrar. Tente Iniciar Tarefa.');
      render();
    });
  }
  function commitRetro() {
    var f = S.flow; var st = startStatus(f);
    if (!f.tpH || !st.iso) { showAlert({ title: 'Hora de início inválida', message: 'Escolha quando a tarefa começou.', okLabel: 'Entendi' }); return; }
    if (st.block) { showAlert({ title: 'Hora de início inválida', message: st.text + '.', okLabel: 'Entendi' }); return; }
    var es = null;
    if (f.finished === 'yes') {
      es = endStatus(f);
      if (!f.endH || !es.iso) { showAlert({ title: 'Hora de fim inválida', message: 'Escolha a hora de fim (ou marque "ainda fazendo").', okLabel: 'Entendi' }); return; }
      if (es.block) { showAlert({ title: 'Hora de fim inválida', message: es.text + '.', okLabel: 'Entendi' }); return; }
    }
    var ended = es ? es.iso : null;
    // junta os avisos "confirme" (início incomum + fim incomum) num diálogo só.
    var asks = [];
    if (st.confirm) asks.push(st.confirmMsg);
    if (es && es.confirm) asks.push(es.confirmMsg);
    if (asks.length) {
      showAlert({ title: 'Confirmar horário', message: asks.join('\n\n'), okLabel: 'Sim, foi isso', cancel: 'Voltar' })
        .then(function (okc) { if (okc) postStart(st.iso, ended); });
      return;
    }
    postStart(st.iso, ended);
  }
  function postStart(startedAt, endedAt) {
    var f = S.flow; var m = typeMeta(f.slug);
    var body = { activity_slug: f.slug, batch_number: f.batch || null, cowork_with: f.cowork || [], note: (f.note || '').trim() || null,
      product_id: f.supplementId || null, product_name: f.supplement || null }; // p/ auto-criar lote desconhecido sem bloquear
    if (m.orders_required || (f.slug === 'clinic_shipment' && parseInt(f.ordersInput, 10) > 0)) body.orders_printed = parseInt(f.ordersInput, 10);
    // ajuste de ordens (packaging_other): aplicado APÓS criar o event (precisa do id).
    var adj = (f.slug === 'packaging_other' && f.adjOn && parseInt(f.adjQty, 10) > 0)
      ? { mode: (f.adjMode === 'reset' ? 'reset' : 'additional'), quantity: parseInt(f.adjQty, 10) } : null;
    var path = startedAt ? '/api/v3/op/event/retroactive' : '/api/v3/op/event/start';
    if (startedAt) { body.started_at = startedAt; body.ended_at = endedAt || null; }
    var onOk = function (res) {
      if (adj && res && res.event && res.event.id) {
        api('/api/v3/op/orders/adjust', { method: 'POST', body: { mode: adj.mode, quantity: adj.quantity, source_event_id: res.event.id } })
          .then(function (r) { toast(adj.mode === 'reset' ? ('Total de ordens: ' + r.old_total + ' → ' + r.new_total) : ('+' + adj.quantity + ' ordens adicionadas')); })
          .catch(function (e) { toast('Erro no ajuste de ordens: ' + (e.message || e)); });
      }
      S.flow = null; S.pulse = 1; if (S.voice.on) stopVoice();
      toast(res && res.queued ? 'Salvo offline — sincroniza ao voltar' : (startedAt ? 'Tarefa adicionada' : 'Tarefa iniciada!'));
      loadData();
    };
    var onErr = function (e) {
      var M = { note_required: 'Precisa de nota', orders_printed_required: 'Precisa da quantidade', started_at_future: 'Hora no futuro', started_at_not_today: 'Só dá pra hoje', ended_at_invalid: 'Hora de fim inválida', unknown_batch: 'Lote não encontrado' };
      toast(M[e.message] || e.message);
    };
    // recama o start com o ack de exclusividade ('close' | 'both' | 'end_lunch')
    var resend = function (ack) {
      var b = Object.assign({}, body, { concurrent_ack: ack });
      api(path, { method: 'POST', body: b }).then(onOk).catch(onErr);
    };
    api(path, { method: 'POST', body: body }).then(function (res) {
      // PASSADA 2 — gap detectado: pausa pra justificar ANTES de iniciar (só start ao vivo)
      if (res && res.gap_detected) {
        S.gapPending = { path: path, body: body };
        S.overlay = { type: 'gap', gapMinutes: res.gap_minutes, gapStartedAt: res.gap_started_at, jtype: null, note: '' };
        render(); return;
      }
      // FASE OVERLAP — almoço aberto: não pode trabalhar até encerrar o almoço.
      if (res && res.lunch_active) {
        showAlert({ title: 'Você está em almoço 🍽️', message: 'Não dá pra trabalhar durante o almoço. Quer encerrar o almoço e começar esta tarefa agora?', okLabel: 'Encerrar almoço e começar', cancel: 'Voltar' })
          .then(function (ok) { if (ok) resend('end_lunch'); });
        return;
      }
      // FASE OVERLAP — já tem outra task de foreground aberta: fechar a anterior OU
      // confirmar 2 ao mesmo tempo (exatamente o pedido do Bruno).
      if (res && res.concurrent_open) {
        // Pergunta DIRETA (regra Bruno 06-24): "tá fazendo as 2 ao mesmo tempo?".
        // SIM → mantém as 2 abertas (simultâneo → fica rosa no dashboard).
        // NÃO → fecha a anterior e começa só a nova.
        var jaAberta = (res.open_tasks || []).map(function (t) { return '• ' + (t.activity || labelOf(t.slug)); }).join('\n');
        var nova = labelOf((body && body.activity_slug) || '');
        showAlert({
          title: 'VOCÊ ESTÁ FAZENDO AS 2 TAREFAS AO MESMO TEMPO?',
          message: 'Já aberta:\n' + jaAberta + '\n\nNova:\n• ' + nova + '\n\nVocê vai fazer as DUAS ao mesmo tempo?',
          okLabel: 'SIM — as 2 juntas', cancel: 'NÃO — fechar a outra',
        }).then(function (both) { resend(both ? 'both' : 'close'); });
        return;
      }
      onOk(res);
    }).catch(onErr);
  }
  // PASSADA 2 — justifica o gap e RECAMA o start com gap_ack (cascade no frontend)
  function doGapJustify() {
    var o = S.overlay; if (!o) return;
    if ((o.note || '').trim().length < 3) { showAlert({ title: 'Explicação obrigatória', message: 'Diga rapidinho o que aconteceu nesse tempo (pode usar a voz).', okLabel: 'Entendi' }); return; }
    if (S.voice.on) stopVoice();
    api('/api/v3/op/gap/justify', { method: 'POST', body: { gap_started_at: o.gapStartedAt, justification_type: o.jtype || 'other', justification_note: (o.note || '').trim() } })
      .then(function () {
        var pend = S.gapPending; S.gapPending = null; S.overlay = null;
        if (!pend) { render(); loadData(); return; }
        var body = Object.assign({}, pend.body, { gap_ack: true }); // recama o start já justificado
        api(pend.path, { method: 'POST', body: body }).then(function () {
          S.flow = null; S.pulse = 1; toast('Tarefa iniciada!'); loadData();
        }).catch(function (e) { toast(e.message); loadData(); });
      })
      .catch(function (e) { toast((e.body && e.body.error) === 'justification_required' ? 'Explique o gap' : e.message); });
  }
  // PASSADA 2 — fim do dia: depois de finalizar uma task, pergunta se precisa dos totais
  function checkEndOfDay() {
    api('/api/v3/op/end-of-day/check').then(function (r) {
      if (r && r.pending && r.should_prompt_user && !r.already_submitted && !S.overlay) {
        S.overlay = { type: 'eod', products: r.products || [], totals: {}, note: '' };
        render();
      }
    }).catch(function () {});
  }
  function doEodSubmit() {
    var o = S.overlay; if (!o) return;
    var totals = {};
    Object.keys(o.totals || {}).forEach(function (pid) { var n = parseInt(o.totals[pid], 10); if (Number.isFinite(n) && n >= 0) totals[pid] = { bottles: n }; });
    api('/api/v3/op/end-of-day/submit', { method: 'POST', body: { totals: totals, general_note: (o.note || '').trim() || null } })
      .then(function () { S.overlay = null; S.pulse = 1; toast('Totais do dia salvos · obrigado!'); render(); })
      .catch(function (e) { if ((e.body && e.body.error) === 'already_submitted') { S.overlay = null; toast('Totais já confirmados hoje'); render(); } else toast(e.message); });
  }
  // Abre o fluxo de FINALIZAR a partir de um objeto-tarefa (usado pelo botão Finalizar
  // E pela pergunta de volta-da-pausa). Resolve o lastFinisher/contagem via finish-preview.
  function openFinishTask(t) {
    var id = t.id;
    var isCw = !!t.cowork_group_id;
    var tm = typeMeta(t.slug) || {};
    S.overlay = { type: 'finish', eventId: id, slug: t.slug, label: t.label || labelOf(t.slug), product: t.product || t.supplement || t.supplement_name || null, batch: t.batch_number || null, needsCount: ['production_line', 'encapsulation'].indexOf(t.slug) >= 0, needsFnsku: t.slug === 'fnsku_labeling', needsOrders: !!tm.requires_order_count && ['order_printing', 'order_printing_2'].indexOf(t.slug) < 0, bottles: '', orders: '', marketplace: '', note: '', exc: false, reason: '', cowork: isCw, coworkRemaining: Array.isArray(t.cowork_with) ? t.cowork_with.length : 0, lastFinisher: false, previewing: isCw };
    render();
    api('/api/v3/op/event/' + id + '/finish-preview').then(function (pv) {
      var o = S.overlay; if (!o || o.type !== 'finish' || String(o.eventId) !== String(id)) return;
      o.cowork = !!pv.is_cowork;
      o.lastFinisher = !!(pv.is_cowork && pv.is_last_finisher);
      o.requiresBottleCount = !!pv.requires_bottle_count;
      if (typeof pv.requires_fnsku_count === 'boolean') o.needsFnsku = pv.requires_fnsku_count;
      if (typeof pv.needs_order_count === 'boolean') o.needsOrders = pv.needs_order_count;
      o.estimatedBottles = pv.estimated_bottles != null ? pv.estimated_bottles : null;
      if (pv.cowork_remaining != null) o.coworkRemaining = pv.cowork_remaining;
      o.previewing = false; render();
    }).catch(function () {
      var o = S.overlay; if (!o || o.type !== 'finish' || String(o.eventId) !== String(id)) return;
      o.previewing = false; render();
    });
  }
  // Volta-da-pausa: pra cada tarefa descongelada, "Continuar" ou "Finalizar" (regra Bruno).
  function resumePrompt(tasks, i) {
    if (!tasks || i >= tasks.length) { toast('De volta ao trabalho ✓'); return; }
    var t = tasks[i];
    var sub = (t.product ? t.product + (t.batch_number ? ' · ' + t.batch_number : '') : (t.batch_number || ''));
    showAlert({
      title: 'Você voltou da pausa',
      message: 'Você estava em: ' + (t.label || labelOf(t.slug)) + (sub ? ' (' + sub + ')' : '') + '.\n\nQuer CONTINUAR essa tarefa ou FINALIZAR?',
      okLabel: 'Continuar trabalhando',
      cancel: 'Finalizar' + (t.needs_count ? ' (informar quantidade)' : ''),
    }).then(function (cont) {
      if (cont) { resumePrompt(tasks, i + 1); return; } // continua → próxima tarefa congelada
      openFinishTask({ id: t.id, slug: t.slug, label: t.label, product: t.product, batch_number: t.batch_number }); // finalizar (cobra qtd se precisar)
    });
  }
  function doFinish() {
    var o = S.overlay;
    // cowork: membro NÃO-último fecha SÓ a parte dele (sem contagem). Se o backend
    // disser que ele é o último de production_line, abre a tela de contagem.
    if (o.cowork && !o.lastFinisher) { postFinishCowork(o); return; }
    if (o.slug === 'production_line' || o.needsFnsku) {
      var nounF = o.needsFnsku ? 'FNSKU / labels foram colados' : 'bottles foram produzidas';
      if (!o.exc) {
        if (!(parseInt(o.bottles, 10) >= 1)) {
          showAlert({ title: 'Contagem obrigatória', message: 'Você precisa informar quantos ' + nounF + '. Se não souber, marque a exceção e explique por quê.', okLabel: 'Entendi' }).then(function () { var i = LYR.overlay.el.querySelector('[data-input="finBottles"]'); if (i) i.focus(); });
          return;
        }
      } else {
        if ((o.reason || '').trim().length < 10) {
          showAlert({ title: 'Motivo obrigatório', message: 'Como você não tem a contagem, é obrigatório explicar o motivo (mín. 10 caracteres). Esta mensagem será enviada para Orders & Inventory.', okLabel: 'Entendi' }).then(function () { var t = LYR.overlay.el.querySelector('[data-input="finReason"]'); if (t) t.focus(); });
          return;
        }
        showAlert({ title: 'Confirmar exceção', message: 'Você está fechando SEM contagem. Uma mensagem será enviada para Orders & Inventory com o seu motivo. Confirmar?', okLabel: 'Sim, finalizar com exceção', cancel: 'Voltar' }).then(function (ok) { if (ok) postFinish(o); });
        return;
      }
    }
    // FASE 5 — P&P/Embalagem: ordens obrigatório OU exceção
    if (o.needsOrders) {
      if (!o.exc) {
        if (!(parseInt(o.orders, 10) >= 1)) {
          showAlert({ title: 'Contagem obrigatória', message: 'Informe quantas ordens foram empacotadas. Se não souber, marque a exceção e explique por quê.', okLabel: 'Entendi' }).then(function () { var i = LYR.overlay.el.querySelector('[data-input="finOrders"]'); if (i) i.focus(); });
          return;
        }
      } else {
        if ((o.reason || '').trim().length < 10) {
          showAlert({ title: 'Motivo obrigatório', message: 'Como você não tem o número, explique o motivo (mín. 10 caracteres). Será enviado para Orders & Inventory.', okLabel: 'Entendi' }).then(function () { var t = LYR.overlay.el.querySelector('[data-input="finReason"]'); if (t) t.focus(); });
          return;
        }
        showAlert({ title: 'Confirmar exceção', message: 'Fechando SEM contagem de ordens. Uma mensagem vai pro Orders & Inventory com seu motivo. Confirmar?', okLabel: 'Sim, finalizar com exceção', cancel: 'Voltar' }).then(function (ok) { if (ok) postFinish(o); });
        return;
      }
    }
    postFinish(o);
  }
  function postFinishCowork(o) {
    api('/api/v3/op/event/' + o.eventId + '/end', { method: 'POST', body: { note: (o.note || '').trim() || null } }).then(function (res) {
      if (res && res.is_last_finisher === false) {
        S.overlay = null; S.pulse = 1; if (S.voice.on) stopVoice();
        toast('Você terminou sua parte' + (res.remaining != null ? ' — falta(m) ' + res.remaining + ' colega(s)' : ''));
        loadData(); return;
      }
      // backend fechou (último de tarefa sem contagem)
      S.overlay = null; S.pulse = 1; if (S.voice.on) stopVoice();
      toast('Tarefa finalizada!'); loadData(); checkEndOfDay(); // PASSADA 2
    }).catch(function (e) {
      // checa o CÓDIGO em e.body.error (api() põe o detail em e.message, não o code)
      var code = (e && e.body && e.body.error) || e.message;
      if (code === 'bottles_required') {
        // corrida: virou o último de production_line entre o preview e o POST →
        // abre a tela de contagem (fallback; o caminho normal já detecta upfront).
        if (S.overlay) { S.overlay.lastFinisher = true; render(); }
      } else { toast(e.message); }
    });
  }
  function postFinish(o) {
    var body;
    if (o.exc && (o.slug === 'production_line' || o.needsFnsku || o.needsOrders)) {
      body = { exception_no_count: true, exception_reason: (o.reason || '').trim(), note: (o.note || '').trim() || null };
    } else if (o.needsOrders) {
      body = { orders_count: parseInt(o.orders, 10), marketplace: o.marketplace || null, note: (o.note || '').trim() || null };
    } else if (o.needsFnsku) {
      // FNSKU usa o mesmo campo (o.bottles) mas manda como fnsku_labels (kind='fnsku')
      body = { fnsku_labels: (o.bottles !== '' && parseInt(o.bottles, 10) >= 0) ? parseInt(o.bottles, 10) : null, note: (o.note || '').trim() || null };
    } else {
      body = { bottles: (o.bottles !== '' && parseInt(o.bottles, 10) >= 0) ? parseInt(o.bottles, 10) : null, note: (o.note || '').trim() || null };
    }
    if (o._dupAck) body.dup_count_ack = true; // operador confirmou que NÃO é dobra
    api('/api/v3/op/event/' + o.eventId + '/end', { method: 'POST', body: body }).then(function (res) {
      // PROTEÇÃO contagem dobrada: o lote já tem contagem hoje (de outro evento) →
      // confirma antes de somar de novo. Cancelar = não conta (provável dobra).
      if (res && res.dup_count_warning) {
        var msg = 'Esse lote JÁ tem ' + res.existing_total + ' bottles contados hoje' + (res.existing_by ? ' por ' + res.existing_by : '') + '.\n\nVocê quer MESMO adicionar mais ' + res.attempted + '? (Se vocês contaram juntos, NÃO adicione — seria contagem dobrada.)';
        if (window.confirm(msg)) { postFinish(Object.assign({}, o, { _dupAck: true })); }
        return;
      }
      S.overlay = null; S.pulse = 1; if (S.voice.on) stopVoice();
      // ITEM 1 — divergência vs estimado: alerta o operador (já avisou a produção no backend)
      var w = res && res.bottle_warning;
      if (w) toast('⚠️ ' + w.actual + ' bottles vs estimado ' + w.target + ' (' + (w.pct > 0 ? '+' : '') + w.pct + '%) — produção avisada');
      else toast(o.exc ? 'Finalizada com exceção — Orders & Inventory avisado' : 'Tarefa finalizada · +1 hoje');
      loadData(); checkEndOfDay(); // PASSADA 2 — pergunta os totais do dia se for a hora
    }).catch(function (e) {
      var code = (e && e.body && e.body.error) || e.message;
      var M = { bottles_required: 'Informe quantas bottles', orders_required: 'Informe quantas ordens', exception_reason_required: 'Explique o motivo (mín. 10 caracteres)' };
      toast(M[code] || e.message);
    });
  }
  function openClock() {
    api('/api/v3/op/missing-bottle-counts').then(function (info) {
      S.overlay = { type: 'clock', missing: info.missing || [], is_last: info.is_last_operator, can_skip: info.can_skip, counts: {}, unknown: {} }; render();
    }).catch(function (e) { toast(e.message); });
  }
  function doClockOut() {
    var o = S.overlay; var counts = []; var unknown = []; var incomplete = false;
    (o.missing || []).forEach(function (m) {
      if ((o.unknown || {})[m.event_id]) unknown.push(m.event_id);
      else { var v = (o.counts || {})[m.event_id]; if (v !== undefined && v !== '' && parseInt(v, 10) >= 0) counts.push({ event_id: m.event_id, bottles: parseInt(v, 10) }); else incomplete = true; }
    });
    if (incomplete && o.is_last && !o.can_skip && (o.missing || []).length) { showAlert({ title: 'Faltam contagens', message: 'Preencha quantos bottles saíram em cada produção, ou marque "Não sei".', okLabel: 'Entendi' }); return; }
    api('/api/v3/op/clock-out', { method: 'POST', body: { counts: counts, unknown_event_ids: unknown } }).then(function () { S.overlay = null; toast('Até amanhã!'); endSession(); }).catch(function (e) {
      if (e.status === 422 && e.body && e.body.missing) { S.overlay = { type: 'clock', missing: e.body.missing, is_last: true, can_skip: false, counts: o.counts || {}, unknown: o.unknown || {} }; render(); }
      else toast(e.message);
    });
  }
  var forgottenQueue = [];
  function nextForgotten(via) { if (!forgottenQueue.length) { return; } S.overlay = { type: 'forgotten', prompt: forgottenQueue.shift(), via: via }; render(); }
  function resolveForgotten(still) {
    var o = S.overlay; var p = o.prompt; var via = o.via;
    if (!still && !window.confirm('Tem certeza? ' + p.person_name + ' será deslogada.')) return;
    api('/api/v3/op/forgotten-checkout/resolve', { method: 'POST', body: { person_id: p.person_id, still_working: still, discovered_via: via } }).catch(function () {});
    S.overlay = null; toast(still ? 'Ok — ' + p.person_name + ' segue na linha' : 'Checkout de ' + p.person_name + ' registrado'); render();
    nextForgotten(via);
  }

  // ── delegação de eventos (uma vez, no ROOT) ────────────────
  ROOT.addEventListener('click', function (e) { var el = e.target.closest('[data-act]'); if (!el) return; bump(); var fn = ACT[el.dataset.act]; if (fn) fn(el.dataset.arg, el); });
  ROOT.addEventListener('input', function (e) {
    var el = e.target.closest('[data-input]'); if (!el) return; bump(); var k = el.dataset.input; var v = el.value;
    if (k === 'query') { S.flow.query = v; S._focus = 'query'; render(); }
    else if (k === 'lotQuery') { S.flow.lotQuery = v; S._focus = 'lotQuery'; render(); }
    else if (k === 'batch') { S.flow.batchInput = v; }
    else if (k === 'orders') { S.flow.ordersInput = v; }
    else if (k === 'adjQty') { S.flow.adjQty = v; }
    else if (k === 'note') { S.flow.note = v; }
    else if (k === 'ovNote') { S.overlay.note = v; }
    else if (k === 'finBottles') { S.overlay.bottles = v; }
    else if (k === 'finOrders') { S.overlay.orders = v; }
    else if (k === 'finReason') { S.overlay.reason = v; }
    else if (k === 'finNote') { S.overlay.note = v; }
    else if (k === 'clockCount') { S.overlay.counts = S.overlay.counts || {}; S.overlay.counts[el.dataset.arg] = v; }
    else if (k === 'gapNote') { S.overlay.note = v; }
    else if (k === 'eodNote') { S.overlay.note = v; }
    else if (k === 'eodBottles') { S.overlay.totals = S.overlay.totals || {}; S.overlay.totals[el.dataset.arg] = v; }
  });
  ROOT.addEventListener('change', function (e) {
    var el = e.target.closest('[data-change]'); if (!el) return; bump(); var k = el.dataset.change;
    if (k === 'marketplace' && S.overlay) { S.overlay.marketplace = el.value; return; } // FASE 5 (sem render: não perde foco)
    if ((k === 'dtH' || k === 'dtM') && S.overlay && S.overlay.type === 'detectWhen') { S.overlay[k === 'dtH' ? 'tpH' : 'tpM'] = el.value; render(); return; } // FASE FORM hora
    if (S.flow) { S.flow[k] = el.value; render(); }
  });
  // teclado p/ o ALERT: Enter / Esc / qualquer tecla 3x em 1.5s
  var keyCount = 0, keyTimer = null;
  document.addEventListener('keydown', function (e) {
    if (!S.alert) return;
    if (e.key === 'Enter') { e.preventDefault(); closeAlert(true); return; }   // Enter = confirma
    if (e.key === 'Escape') { e.preventDefault(); closeAlert(false); return; } // Esc = cancela/fecha
    keyCount++; clearTimeout(keyTimer); keyTimer = setTimeout(function () { keyCount = 0; }, 1500);
    if (keyCount >= 3) { closeAlert(false); keyCount = 0; } // qualquer tecla 3x = fecha
  });

  // ── timers (tick CIRÚRGICO — sem render() → sem flicker) ───
  var tClock = null, tBeat = null, tMantra = null;
  function startTimers() {
    stopTimers();
    tClock = setInterval(function () {
      S.now = Date.now();
      S.pulse = Math.max(0, S.pulse - 0.06);
      document.documentElement.style.setProperty('--pulse', S.pulse.toFixed(3));
      if (S.session && S.logoffLeft != null) {
        S.logoffLeft -= 1;
        if (S.logoffLeft <= 0) { doLogout('auto_timeout'); return; }
        var lg = document.getElementById('hf-logoff'); if (lg) lg.textContent = (S.logoffLeft <= 120 ? 'sai em ' + S.logoffLeft + 's' : '');
      }
      var ck = document.getElementById('hf-clock'); if (ck) ck.textContent = clockNow();
      // Saudação/data ao vivo: "Boa noite" vira "Bom dia" sozinho quando o
      // dia/horário muda (página aberta de um dia pro outro não trava mais).
      if (S.session) {
        var gr = document.getElementById('hf-greet');
        if (gr) { var ng = greetingTxt() + ', ' + S.session.person.display_name; if (gr.textContent !== ng) gr.textContent = ng; }
        var dt = document.getElementById('hf-date'); if (dt) { var nd = dateNow(); if (dt.textContent !== nd) dt.textContent = nd; }
      }
    }, 1000);
    tBeat = setInterval(function () {
      if (!S.session) return;
      // VIRADA DE DIA: página aberta de ontem pro novo dia → recarrega (não trava
      // mais nas tarefas de ontem). Só na home, sem overlay/flow aberto pra não
      // interromper algo em andamento.
      if (S.dataDay && edtDay() !== S.dataDay && S.screen === 'home' && !S.overlay && !S.flow) { loadData(); return; }
      api('/api/v3/op/auth/heartbeat', { method: 'POST' }).then(function (r) {
        if (!r || !r.version) return;
        if (!S.appVersion) { S.appVersion = r.version; return; }   // 1ª resposta: guarda a versão atual
        // DEPLOY NOVO no servidor → recarrega sozinho (só na home, sem nada aberto,
        // pra não interromper um registro em andamento). Resolve "página aberta o
        // dia todo não pega atualização".
        if (r.version !== S.appVersion && S.screen === 'home' && !S.overlay && !S.flow) location.reload();
      }).catch(function () {});
    }, 45000);
    tMantra = setInterval(function () {
      S.mantraIdx = (S.mantraIdx + 1) % MANTRAS.length; S.mantraLangTick += 1;
      if (S.settings.mantras && S.screen === 'home' && MANTRA) { var m = document.getElementById('hf-mantra-text'); if (m) { m.textContent = curMantra(); m.style.animation = 'none'; void m.offsetWidth; m.style.animation = 'hfMantra 7s ease-in-out infinite'; } }
    }, 7000);
  }
  function stopTimers() { clearInterval(tClock); clearInterval(tBeat); clearInterval(tMantra); S.logoffLeft = null; }

  // operador volta de manhã e foca a aba (deixada aberta de ontem) → se virou o
  // dia, recarrega na hora em vez de mostrar o estado congelado de ontem.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !S.session) return;
    if (S.dataDay && edtDay() !== S.dataDay && !S.overlay && !S.flow) loadData();
  });
  window.addEventListener('online', function () { S.online = true; if (Q && Q.flush) Q.flush(function (item) { return fetch(item.path, { method: 'POST', headers: { Authorization: 'Bearer ' + CFG.pageToken, 'X-Session-Token': item.sessionToken || (S.session && S.session.token), 'Content-Type': 'application/json' }, body: JSON.stringify(item.body) }).then(function (r) { return r.ok; }); }).then(function () { loadData(); }); });
  window.addEventListener('offline', function () { S.online = false; });

  // ── FIT-TO-VIEWPORT: escala o canvas 1440x900 pra caber 100% (sem scroll) ──
  var DESIGN_W = 1440, DESIGN_H = 900, SCALE_MAX = 1.25, SCALE_MIN = 0.35;
  // REGRA #0: o sistema NUNCA bloqueia o operador — não existe mais "gire o aparelho".
  // Celular EM PÉ (vw < 600 e portrait): canvas FLUIDO (100vw×100vh, sem scale) e o
  // conteúdo — que já é responsivo (clamp + grids auto-fit) — reflui em coluna, rolável.
  // Desktop / tablet landscape: canvas FIXO 1440×900 escalado (fit-to-viewport, igual antes).
  function isPortraitPhone() {
    var vw = window.innerWidth, vh = window.innerHeight;
    return vw < 600 && vh >= vw;
  }
  function fitCanvas() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var html = document.documentElement;
    if (isPortraitPhone()) {
      html.classList.add('hf-portrait');
      if (ROOT) { ROOT.style.transform = 'none'; ROOT.style.width = '100vw'; ROOT.style.height = '100vh'; }
      html.setAttribute('data-hf-scale', '1');
    } else {
      html.classList.remove('hf-portrait');
      if (ROOT) { ROOT.style.width = DESIGN_W + 'px'; ROOT.style.height = DESIGN_H + 'px'; }
      var scale = Math.min(vw / DESIGN_W, vh / DESIGN_H);
      var f = Math.min(Math.max(scale, SCALE_MIN), SCALE_MAX);
      if (ROOT) ROOT.style.transform = 'scale(' + f + ')';
      html.setAttribute('data-hf-scale', f.toFixed(2));
    }
    html.setAttribute('data-hf-viewport', vw + 'x' + vh);
  }
  var _fitT = null;
  window.addEventListener('resize', function () { clearTimeout(_fitT); _fitT = setTimeout(fitCanvas, 50); });
  window.addEventListener('orientationchange', function () { setTimeout(fitCanvas, 200); });

  // boot
  render();
  fitCanvas();
}());
