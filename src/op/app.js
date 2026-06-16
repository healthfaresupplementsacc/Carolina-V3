'use strict';
/* ============================================================
   HEALTHFARE Operator Page — app v4 (redesign HealthFare).
   Tradução vanilla do design (HealthFare Linha.dc.html) — sem x-dc.
   Render-on-state (innerHTML em #hf-root) + delegação de eventos.
   Backend/endpoints INTOCADOS — usa os mesmos do app.js atual:
     auth/login·logout·heartbeat, architect/person/:id/today,
     active-operators, event/start·retroactive·:id/end·:id/join,
     missing-bottle-counts, clock-out, voice/upload, forgotten-checkout/resolve.
   Reaproveita: window.HF_DATA (fuse-data), HFOfflineQueue, HFStateMachine
   (searchSupplements), HFDesign (helpers). ============================================================ */
(function () {
  var CFG = window.HF_OP_CONFIG || { pageToken: '' };
  var DATA = window.HF_DATA || { groups: [], quick: [], supplements: [], recent_batches: [] };
  var SM = window.HFStateMachine; var D = window.HFDesign;
  var Q = window.HFOfflineQueue || null;
  var ROOT = document.getElementById('hf-root');

  // ── ícones (paths SVG do design) ───────────────────────────
  var ICONS = {
    factory: 'M3 21h18M5 21V10l4 2.5V10l4 2.5V7l5 3v11', flask: 'M9 3h6M10 3v5.5L5.5 17a2 2 0 0 0 1.8 3h9.4a2 2 0 0 0 1.8-3L14 8.5V3M7.5 14h9',
    spray: 'M8 21h6M9 21v-4M6.5 17h9v-2a4.5 4.5 0 0 0-9 0zM16 4h3M16 7h4M16 10h3M14.5 3v9', package: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13.2V21',
    truck: 'M3 6.5h11v9H3zM14 9.5h3.5l3 3v3H17M7 19a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 7 19zM17.5 19a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', sparkle: 'M12 3l1.7 5.1L19 10l-5.3 1.9L12 17l-1.7-5.1L5 10l5.3-1.9z',
    tag: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-7-7a2 2 0 0 1-.6-1.4V5a2 2 0 0 1 2-2h6.6a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 .2 2.8zM8 8h.01',
    printer: 'M6 9V3.5h12V9M6 18.5H4.5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H18M6.5 14.5h11V21h-11z',
    wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.5V21H7l6-6a4 4 0 0 0 5.2-5.4l-2.8 2.8-2-2 2.7-2.7z', search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20.5 20.5l-4-4',
    coffee: 'M4 8.5h13v4.5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM17 9.5h2a2 2 0 0 1 0 4h-2M7 3v1.5M10 3v1.5M13 3v1.5', chat: 'M21 11.5a8 8 0 0 1-11.6 7.1L4 20.5l1.9-5.3A8 8 0 1 1 21 11.5z',
    book: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15.5H6.5A1.5 1.5 0 0 0 5 20zM19 3v15.5', bowl: 'M4 11h16a8 8 0 0 1-16 0zM9 11V7.5a3 3 0 0 1 6 0V11',
    pause: 'M9.5 4.5H6.5v15h3zM17.5 4.5h-3v15h3z', edit: 'M12 20h9M16.8 3.6a2 2 0 0 1 2.8 2.8L7.5 18.5 3 19.5l1-4.5z',
    swap: 'M7 7h11l-3.2-3.2M17 17H6l3.2 3.2', box: 'M3.5 7.5l8.5-4 8.5 4-8.5 4zM3.5 7.5v9l8.5 4 8.5-4v-9M12 11.5V21', cross: 'M9.5 3h5v5.5H20v5h-5.5V19h-5v-5.5H4v-5h5.5z',
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

  // produtos → bottle (carregado de products.json)
  var PRODUCTS = { exact: {}, aliases: {} };
  fetch('/op/products.json').then(function (r) { return r.json(); }).then(function (j) { PRODUCTS = j; }).catch(function () {});
  function bottleFor(name) {
    if (!name) return null; var n = String(name).toLowerCase();
    for (var k in (PRODUCTS.exact || {})) if (k.toLowerCase() === n) return '/op/assets/bottles/' + PRODUCTS.exact[k];
    for (var a in (PRODUCTS.aliases || {})) if (n.indexOf(a) >= 0) return '/op/assets/bottles/' + PRODUCTS.aliases[a];
    return null;
  }

  // ── settings (localStorage por device) ─────────────────────
  var SKEY = 'hf_op_settings_v4';
  function loadSettings() { try { return Object.assign({ mantras: false, mantraLang: 'pt', dayPhase: 'auto', density: 'medium', aging: false, warnMin: 45, overMin: 90 }, JSON.parse(localStorage.getItem(SKEY) || '{}')); } catch (e) { return { mantras: false, mantraLang: 'pt', dayPhase: 'auto', density: 'medium', aging: false, warnMin: 45, overMin: 90 }; } }
  function saveSettings() { try { localStorage.setItem(SKEY, JSON.stringify(S.settings)); } catch (e) {} }

  // ── estado ─────────────────────────────────────────────────
  var S = {
    screen: 'login', pin: '', pinError: '', shake: false,
    session: null, now: Date.now(), logoffLeft: null,
    myTasks: [], team: [], completedToday: 0, goal: 8, online: navigator.onLine,
    flow: null, overlay: null, settingsOpen: false, settings: loadSettings(),
    mantraIdx: 0, toast: '', voice: { on: false, secs: 0, target: null }, _focus: null,
  };
  function setState(patch) { Object.assign(S, typeof patch === 'function' ? patch(S) : patch); render(); }

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
      // offline: enfileira POSTs de event/note (não voz/login)
      if (e._net && Q && init.method === 'POST' && /\/event\/(start|retroactive)|\/note/.test(path)) {
        Q.enqueue({ path: path, body: opts.body, sessionToken: S.session && S.session.token });
        return { ok: true, queued: true };
      }
      throw e;
    });
  }
  function mkErr(msg, status, body) { var e = new Error(msg); e.status = status; e.body = body; return e; }
  // marca erros de rede
  var _fetch = window.fetch;
  window.fetch = function () { return _fetch.apply(this, arguments).catch(function (err) { err._net = true; throw err; }); };

  function toast(m) { S.toast = m; render(); clearTimeout(toast._t); toast._t = setTimeout(function () { S.toast = ''; render(); }, 2600); }

  // ── helpers de markup ──────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function svg(path, sz, sw) { sz = sz || 24; sw = sw || 1.8; return '<svg width="' + sz + '" height="' + sz + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"></path></svg>'; }
  function accent() { return S.session ? D.operatorAccent(S.session.person.display_name) : '#0e7a4e'; }

  function curMantra() {
    var lang = S.settings.mantraLang; if (lang === 'rotate') lang = ['pt', 'es', 'en'][S.mantraIdx % 3];
    return (MANTRAS[S.mantraIdx % MANTRAS.length])[lang] || MANTRAS[S.mantraIdx % MANTRAS.length].pt;
  }
  function densityMul() { return ({ low: 0.5, medium: 1, high: 1.5 })[S.settings.density] || 1; }

  // ── RENDER raiz ────────────────────────────────────────────
  function render() {
    var bg = S.screen === 'login' ? 'hf-bg-login' : 'hf-bg-app';
    var amb = D.ambientVars(new Date(), S.myTasks.length);
    var rootStyle = '--accent:' + accent() + ';--day:' + amb['--day'] + ';--energy:' + amb['--energy'] + ';--hf-ambient:' + densityMul() + ';';
    var html = '<div class="' + bg + '" style="position:relative;min-height:100dvh;display:flex;flex-direction:column;' + rootStyle + '">';
    html += ambientHTML();
    if (S.settings.mantras && S.screen === 'home') html += '<div style="position:fixed;bottom:clamp(14px,2.4vh,24px);left:0;right:0;z-index:4;display:flex;justify-content:center;pointer-events:none;padding:0 16px;"><div class="hf-mantra">' + esc(curMantra()) + '</div></div>';
    if (S.session) html += topbarHTML();
    if (S.screen === 'login') html += loginHTML();
    if (S.screen === 'home') html += homeHTML();
    if (S.flow) html += flowHTML();
    if (S.overlay) html += overlayHTML();
    if (S.settingsOpen) html += settingsHTML();
    if (S.toast) html += '<div style="position:fixed;bottom:26px;left:50%;transform:translateX(-50%);z-index:90;background:#0c2545;color:#fff;padding:14px 24px;border-radius:16px;font-weight:600;font-size:15px;box-shadow:0 20px 50px -16px rgba(12,37,69,.7);animation:hfPop .3s ease both;max-width:92vw;text-align:center;">' + esc(S.toast) + '</div>';
    html += '</div>';
    ROOT.innerHTML = html;
    if (S._focus) { var f = ROOT.querySelector('[data-focus="' + S._focus + '"]'); if (f) { f.focus(); try { var v = f.value; f.value = ''; f.value = v; } catch (e) {} } }
  }
  function ambientHTML() {
    return '<div class="hf-ambient"><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div><div class="blob b4"></div></div>';
  }

  function topbarHTML() {
    var p = S.session.person;
    var logoff = S.logoffLeft != null ? '<span style="font-size:12px;color:#5a6e87;font-weight:600;margin-right:4px;">logoff ' + S.logoffLeft + 's</span>' : '';
    return '<div style="position:relative;z-index:6;display:flex;align-items:center;gap:14px;padding:clamp(12px,1.6vw,18px) clamp(14px,2.6vw,30px);">'
      + '<span style="display:inline-flex;align-items:center;padding:9px 17px;border-radius:17px;background:rgba(255,255,255,.8);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.9);box-shadow:0 12px 30px -16px rgba(15,40,90,.5);"><img src="/op/assets/healthfare-logo.png" alt="HealthFare" style="height:clamp(34px,3.2vw,46px);width:auto;display:block;"></span>'
      + '<div style="flex:1;"></div>' + logoff
      + '<div style="display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.7);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.8);border-radius:999px;padding:7px 14px 7px 9px;box-shadow:0 8px 24px -14px rgba(15,40,90,.4);"><div style="width:30px;height:30px;border-radius:50%;background:linear-gradient(140deg,#2f7ae0,#0f4c92);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;">' + esc(D.initials(p.display_name)) + '</div><span style="font-weight:700;font-size:14px;color:#0c2545;white-space:nowrap;">' + esc(p.display_name) + '</span><span style="width:8px;height:8px;border-radius:50%;background:#21a85b;box-shadow:0 0 0 3px rgba(33,168,91,.18);animation:hfPulse 2.4s ease-in-out infinite;margin-left:2px;"></span></div>'
      + iconBtn('toggleSettings', 'Ajustes', ICONS.gear || 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z', '#42566f', 'rgba(255,255,255,.62)')
      + iconBtn('clockout', 'Sair (fim do dia)', 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', '#b35c00', 'rgba(255,247,234,.82)')
      + iconBtn('logout', 'Trocar operador', 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3', '#42566f', 'rgba(255,255,255,.62)')
      + '</div>';
  }
  function iconBtn(act, title, path, color, bg) {
    return '<button data-act="' + act + '" title="' + esc(title) + '" aria-label="' + esc(title) + '" style="width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.8);background:' + bg + ';backdrop-filter:blur(14px);color:' + color + ';cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 22px -14px rgba(15,40,90,.4);">' + svg(path, 20) + '</button>';
  }

  // ── LOGIN ──────────────────────────────────────────────────
  function loginHTML() {
    var dots = ''; for (var i = 0; i < 4; i++) { var on = i < S.pin.length; dots += '<div class="hf-pin-dot" style="background:' + (on ? accent() : 'rgba(15,40,90,.12)') + ';border:2px solid ' + (on ? 'rgba(255,255,255,.9)' : 'rgba(15,40,90,.22)') + ';transform:scale(' + (on ? 1.05 : 1) + ');"></div>'; }
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'];
    var kp = ''; keys.forEach(function (k) { var fn = k === '⌫' || k === '✓'; kp += '<button class="hf-key' + (fn ? ' hf-key-fn' : '') + '" data-act="pinkey" data-arg="' + k + '">' + k + '</button>'; });
    return '<div style="position:relative;z-index:5;flex:1;display:flex;align-items:center;justify-content:center;padding:24px;">'
      + '<div class="hf-glass" style="animation:hfPop .5s cubic-bezier(.2,.8,.2,1) both;width:min(94vw,420px);border-radius:34px;padding:clamp(26px,4vw,40px) clamp(22px,3.6vw,36px);text-align:center;">'
      + '<img src="/op/assets/healthfare-logo.png" alt="HealthFare" style="height:clamp(46px,7vw,58px);width:auto;margin:0 auto 10px;">'
      + '<div style="font-family:var(--hf-font-display);font-weight:600;font-size:14px;letter-spacing:.16em;text-transform:uppercase;color:#6c819b;margin-bottom:22px;">Linha de Produção</div>'
      + '<div style="' + (S.shake ? 'animation:hfShake .6s ease both;' : '') + '"><div style="display:flex;justify-content:center;gap:16px;margin-bottom:10px;">' + dots + '</div></div>'
      + '<div style="min-height:22px;color:#c0352b;font-weight:700;font-size:14px;margin-bottom:14px;">' + esc(S.pinError) + '</div>'
      + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:clamp(10px,1.8vw,15px);max-width:320px;margin:0 auto;">' + kp + '</div>'
      + '<div style="margin-top:22px;font-size:12.5px;color:#8195ab;font-weight:500;">Toque seu PIN de 4 dígitos para entrar</div>'
      + '</div></div>';
  }

  // ── HOME ───────────────────────────────────────────────────
  function homeHTML() {
    var p = S.session.person; var ph = D.phaseOfDay(new Date());
    var ringR = 52, circ = 2 * Math.PI * ringR; var frac = Math.min(1, S.goal ? S.completedToday / S.goal : 0);
    var dash = (circ * frac).toFixed(1) + ' ' + circ.toFixed(1);
    var h = '<div class="hf-scroll" style="position:relative;z-index:3;flex:1;overflow-y:auto;padding:clamp(6px,1vw,12px) clamp(14px,3vw,32px) clamp(60px,8vh,90px);">'
      + '<div style="width:min(100%,1120px);margin:0 auto;display:flex;flex-direction:column;gap:clamp(16px,2vw,22px);">';
    // hero
    h += '<div class="hf-glass" style="animation:hfRise .5s ease both;display:grid;grid-template-columns:1fr auto;gap:24px;align-items:center;border-radius:30px;padding:clamp(22px,3vw,34px) clamp(22px,3.2vw,38px);">'
      + '<div style="min-width:0;"><div style="font-size:14px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:' + accent() + ';opacity:.9;">' + esc(ph) + ' · ' + D.clockStr(new Date()) + '</div>'
      + '<div style="font-family:var(--hf-font-display);font-weight:700;font-size:clamp(28px,4.4vw,46px);line-height:1.05;margin:6px 0 4px;color:#0c2545;">' + esc(D.greeting(ph)) + ', ' + esc(p.display_name) + '</div>'
      + '<div style="font-size:15px;color:#5a6e87;text-transform:capitalize;font-weight:500;">' + esc(D.dateStr(new Date())) + '</div></div>'
      + '<div style="position:relative;width:clamp(118px,13vw,150px);height:clamp(118px,13vw,150px);display:flex;align-items:center;justify-content:center;"><svg viewBox="0 0 120 120" style="width:100%;height:100%;transform:rotate(-90deg);"><circle cx="60" cy="60" r="52" fill="none" stroke="rgba(15,40,90,.1)" stroke-width="11"></circle><circle cx="60" cy="60" r="52" fill="none" stroke="' + accent() + '" stroke-width="11" stroke-linecap="round" stroke-dasharray="' + dash + '" style="transition:stroke-dasharray .8s;"></circle></svg><div style="position:absolute;text-align:center;"><div style="font-family:var(--hf-font-display);font-weight:800;font-size:clamp(26px,3vw,34px);color:#0c2545;line-height:1;">' + S.completedToday + '</div><div style="font-size:12px;font-weight:600;color:#8195ab;">de ' + S.goal + ' hoje</div></div></div></div>';
    // CTA
    h += '<button data-act="startFlow" style="animation:hfRise .55s ease both;position:relative;overflow:hidden;border:0;cursor:pointer;border-radius:26px;padding:clamp(22px,2.8vw,30px) 28px;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 88%,#19c277),var(--accent));color:#fff;box-shadow:0 26px 50px -18px color-mix(in srgb,var(--accent) 60%,transparent),inset 0 1px 0 rgba(255,255,255,.3);display:flex;align-items:center;justify-content:center;gap:16px;"><span class="hf-sheen"></span><span style="display:flex;align-items:center;justify-content:center;width:clamp(40px,4.4vw,52px);height:clamp(40px,4.4vw,52px);border-radius:50%;background:rgba(255,255,255,.2);">' + svg('M12 5v14M5 12h14', 26, 2.4) + '</span><span style="font-family:var(--hf-font-display);font-weight:700;font-size:clamp(20px,2.6vw,27px);">Iniciar Tarefa</span></button>';
    // 2 colunas
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:clamp(16px,2vw,22px);">';
    // mine
    h += '<div style="animation:hfRise .6s ease both;"><div style="display:flex;align-items:center;gap:10px;margin:0 4px 12px;"><span style="color:#0f4c92;">' + svg('M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11', 19, 1.9) + '</span><h2 style="font-family:var(--hf-font-display);font-weight:700;font-size:17px;color:#0c2545;">Minhas tarefas</h2></div><div style="display:flex;flex-direction:column;gap:11px;">';
    if (!S.myTasks.length) h += '<div style="background:rgba(255,255,255,.5);border:1px dashed rgba(15,40,90,.18);border-radius:18px;padding:22px;text-align:center;color:#8195ab;font-weight:500;font-size:14px;">Nenhuma tarefa aberta. Toque em Iniciar Tarefa.</div>';
    S.myTasks.forEach(function (t) {
      var ab = S.settings.aging ? D.ageBadge(t.started_at, new Date(), { warnMin: S.settings.warnMin, overMin: S.settings.overMin }) : null;
      h += '<div class="hf-card" style="display:flex;align-items:center;gap:13px;padding:14px;border-radius:18px;"><span style="flex:none;width:44px;height:44px;border-radius:13px;background:color-mix(in srgb,var(--accent) 12%,white);color:var(--accent);display:flex;align-items:center;justify-content:center;">' + svg(iconPath(t.slug), 24) + '</span><div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:16px;color:#0c2545;">' + esc(labelOf(t.slug)) + '</div><div class="hf-ellipsis" style="font-size:13px;color:#5a6e87;margin-top:2px;">' + esc((t.batch_number ? t.batch_number + ' · ' : '') + 'há ' + fmtDur(t.started_at)) + '</div>'
        + (ab ? '<div style="display:inline-flex;align-items:center;gap:5px;margin-top:5px;font-size:11.5px;font-weight:700;color:' + ab.color + ';"><span style="width:6px;height:6px;border-radius:50%;background:' + ab.color + ';' + (ab.level !== 'ok' ? 'animation:hfPulse 1.6s infinite;' : '') + '"></span>' + esc(ab.text) + '</div>' : '')
        + '</div><button data-act="finish" data-arg="' + t.id + '" style="flex:none;border:0;cursor:pointer;border-radius:14px;padding:13px 18px;background:linear-gradient(135deg,#cf463c,#b3261e);color:#fff;font-weight:700;font-size:14px;box-shadow:0 12px 26px -14px rgba(179,38,30,.7);display:flex;align-items:center;gap:7px;">' + svg('M20 6L9 17l-5-5', 17, 2.4) + 'Finalizar</button></div>';
    });
    h += '</div></div>';
    // team
    h += '<div style="animation:hfRise .65s ease both;"><div style="display:flex;align-items:center;gap:10px;margin:0 4px 12px;"><span style="color:#0f4c92;">' + svg('M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0 0M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75', 19, 1.9) + '</span><h2 style="font-family:var(--hf-font-display);font-weight:700;font-size:17px;color:#0c2545;">Equipe agora</h2></div><div style="display:flex;flex-direction:column;gap:11px;">';
    var others = (S.team || []).filter(function (o) { return o.id !== p.id && o.current_event_id; });
    if (!others.length) h += '<div style="background:rgba(255,255,255,.5);border:1px dashed rgba(15,40,90,.18);border-radius:18px;padding:22px;text-align:center;color:#8195ab;font-weight:500;font-size:14px;">Ninguém com tarefa aberta agora.</div>';
    others.forEach(function (o) {
      var inCw = Array.isArray(o.current_cowork) && o.current_cowork.indexOf(p.id) >= 0;
      h += '<div class="hf-card" style="display:flex;align-items:center;gap:12px;padding:14px;border-radius:18px;"><span style="position:relative;flex:none;width:44px;height:44px;border-radius:50%;background:linear-gradient(140deg,#5a6e87,#42566f);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;">' + esc(D.initials(o.display_name)) + '<span style="position:absolute;right:-1px;bottom:-1px;width:13px;height:13px;border-radius:50%;border:2px solid #fff;background:' + (o.online ? '#21a85b' : '#8195ab') + ';"></span></span><div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:15px;color:#0c2545;">' + esc(o.display_name) + '</div><div class="hf-ellipsis" style="font-size:12.5px;color:#5a6e87;margin-top:2px;">' + esc(labelOf(o.current_slug) + (o.current_batch ? ' · ' + o.current_batch : '') + ' · há ' + fmtDur(o.current_started_at)) + '</div></div>'
        + (inCw ? '<span style="flex:none;font-size:13px;font-weight:700;color:#8195ab;padding:0 6px;">Já junto</span>' : '<button data-act="join" data-arg="' + o.current_event_id + '" data-name="' + esc(o.display_name) + '" style="flex:none;border:0;cursor:pointer;border-radius:13px;padding:12px 16px;background:linear-gradient(135deg,#3a86ee,#1f5fd0);color:#fff;font-weight:700;font-size:14px;box-shadow:0 12px 26px -14px rgba(31,95,208,.6);">+ Entrar</button>')
        + '</div>';
    });
    h += '</div></div></div>';
    // quick note
    h += '<button data-act="note" style="align-self:center;margin-top:2px;border:1px solid rgba(255,255,255,.8);cursor:pointer;border-radius:16px;padding:13px 22px;background:rgba(255,255,255,.55);backdrop-filter:blur(14px);color:#42566f;font-weight:600;font-size:14px;display:flex;align-items:center;gap:10px;box-shadow:0 10px 26px -18px rgba(15,40,90,.4);">' + svg('M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z', 18) + 'Nota rápida / Voz</button>';
    h += '</div></div>';
    return h;
  }

  // (flowHTML, overlayHTML, settingsHTML + handlers + timers definidos abaixo)
  // ============================================================
  // Helpers de domínio
  function labelOf(slug) {
    var q = (DATA.quick || []).find(function (x) { return x.slug === slug; }); if (q) return q.label;
    for (var i = 0; i < (DATA.groups || []).length; i++) { var t = (DATA.groups[i].types || []).find(function (x) { return x.slug === slug; }); if (t) return t.label; }
    return slug || '—';
  }
  function typeMeta(slug) {
    for (var i = 0; i < (DATA.groups || []).length; i++) { var t = (DATA.groups[i].types || []).find(function (x) { return x.slug === slug; }); if (t) return t; }
    var qq = (DATA.quick || []).find(function (x) { return x.slug === slug; }); return qq || { slug: slug };
  }
  function fmtDur(iso) { var m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000)); return m >= 60 ? Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') : m + 'min'; }

  // ============================================================
  // FLOW (group → type → supplement → batch → confirm → finished)
  function flowHTML() {
    var f = S.flow; var body = '';
    if (f.step === 'group') body = flowGroup();
    else if (f.step === 'type') body = flowType();
    else if (f.step === 'supp') body = flowSupp();
    else if (f.step === 'batch') body = flowBatch();
    else if (f.step === 'confirm') body = flowConfirm();
    else if (f.step === 'finished') body = flowFinished();
    var steps = ['group', f.requires_product ? 'supp' : null, f.requires_product ? 'batch' : null, 'confirm'].filter(Boolean);
    // breadcrumb simplificado
    return '<div style="position:fixed;inset:0;z-index:40;background:rgba(12,30,55,.42);backdrop-filter:blur(7px);display:flex;align-items:center;justify-content:center;padding:clamp(10px,3vw,28px);animation:hfFade .25s ease both;">'
      + '<div class="hf-scroll hf-glass-strong" style="position:relative;width:min(97vw,800px);max-height:94dvh;overflow-y:auto;animation:hfPop .35s cubic-bezier(.2,.8,.2,1) both;">'
      + '<div style="position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:14px;padding:clamp(16px,2.4vw,22px) clamp(18px,2.8vw,28px);background:linear-gradient(rgba(255,255,255,.86),rgba(255,255,255,.5));backdrop-filter:blur(10px);border-bottom:1px solid rgba(15,40,90,.07);border-radius:30px 30px 0 0;"><div style="flex:1;font-family:var(--hf-font-display);font-weight:700;font-size:14px;color:#6c819b;">' + esc(crumbLabel(f.step)) + '</div><button data-act="cancelFlow" title="Cancelar" aria-label="Cancelar" style="flex:none;width:40px;height:40px;border-radius:50%;border:1px solid rgba(15,40,90,.12);background:rgba(255,255,255,.7);color:#6c819b;cursor:pointer;display:flex;align-items:center;justify-content:center;">' + svg('M18 6L6 18M6 6l12 12', 20, 2.2) + '</button></div>'
      + '<div style="padding:clamp(18px,2.6vw,28px);">' + body + '</div></div></div>';
  }
  function crumbLabel(step) { return ({ group: 'Escolher tarefa', type: 'Escolher tarefa', supp: 'Suplemento', batch: 'Lote', confirm: 'Confirmar', finished: 'Já terminou?' })[step] || ''; }

  function tile(act, arg, iconp, label, accentc) {
    return '<button data-act="' + act + '" data-arg="' + esc(arg) + '" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:11px;padding:20px 12px;border-radius:22px;cursor:pointer;min-height:116px;text-align:center;border:1px solid rgba(15,40,90,.1);background:rgba(255,255,255,.66);"><span style="flex:none;width:56px;height:56px;border-radius:18px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,' + accentc + ' 13%,white);color:' + accentc + ';">' + svg(iconp, 28, 1.7) + '</span><span style="font-family:var(--hf-font-display);font-weight:600;font-size:15px;line-height:1.2;color:#0c2545;">' + esc(label) + '</span></button>';
  }
  function flowGroup() {
    var h = '<div style="font-family:var(--hf-font-display);font-weight:700;font-size:clamp(20px,2.6vw,26px);color:#0c2545;margin-bottom:18px;">O que você vai fazer?</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:clamp(10px,1.4vw,14px);">';
    (DATA.groups || []).forEach(function (g) { var ac = GROUP_ACCENT[g.key] || '#0f4c92'; h += tile('pickGroup', g.key, ICONS[GROUP_ICON[g.key] || 'grid'], g.label, ac); });
    (DATA.quick || []).forEach(function (q) { h += '<button data-act="quickLunch" data-arg="' + esc(q.slug) + '" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:11px;padding:20px 12px;border-radius:22px;cursor:pointer;min-height:116px;text-align:center;border:0;background:linear-gradient(135deg,#3cc878,#0e7a4e);color:#fff;box-shadow:0 18px 38px -18px rgba(14,122,78,.7);"><span style="flex:none;width:56px;height:56px;border-radius:18px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.22);">' + svg(ICONS.coffee, 28, 1.7) + '</span><span style="font-family:var(--hf-font-display);font-weight:600;font-size:15px;">' + esc(q.label) + '</span></button>'; });
    h += '</div>'; return h;
  }
  function flowType() {
    var g = (DATA.groups || []).find(function (x) { return x.key === S.flow.groupKey; }) || { types: [] };
    var ac = GROUP_ACCENT[g.key] || '#0f4c92';
    var h = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;"><span style="flex:none;width:42px;height:42px;border-radius:13px;background:rgba(15,40,90,.07);color:#0f4c92;display:flex;align-items:center;justify-content:center;">' + svg(ICONS[GROUP_ICON[g.key] || 'grid'], 24, 1.7) + '</span><div style="font-family:var(--hf-font-display);font-weight:700;font-size:clamp(19px,2.4vw,24px);color:#0c2545;">' + esc(g.label) + '</div></div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:clamp(10px,1.4vw,14px);">';
    (g.types || []).forEach(function (t) { h += tile('pickType', t.slug, iconPath(t.slug), t.label, ac); });
    h += '</div><div style="display:flex;gap:11px;margin-top:22px;">' + backBtn() + '</div>'; return h;
  }
  function flowSupp() {
    var list = SM.searchSupplements(DATA.supplements, S.flow.query || '');
    var rows = '';
    var qnorm = (S.flow.query || '').trim();
    if (qnorm && !list.some(function (p) { return p.canonical_name.toLowerCase() === qnorm.toLowerCase(); })) {
      rows += '<button data-act="pickSupp" data-arg="' + esc(qnorm) + '" data-new="1" style="display:flex;align-items:center;gap:12px;padding:14px;border-radius:14px;border:1px dashed rgba(15,40,90,.2);background:rgba(255,255,255,.6);cursor:pointer;"><span style="flex:none;width:34px;height:34px;border-radius:10px;background:rgba(14,122,78,.12);color:#0e7a4e;display:flex;align-items:center;justify-content:center;">' + svg('M12 5v14M5 12h14', 18, 2.2) + '</span><span style="flex:1;text-align:left;font-weight:600;font-size:16px;color:#0c2545;">Novo: "' + esc(qnorm) + '"</span></button>';
    }
    list.forEach(function (p) {
      var b = bottleFor(p.canonical_name);
      var thumb = b ? '<img src="' + b + '" loading="lazy" width="34" height="34" alt="" style="flex:none;width:34px;height:34px;object-fit:contain;border-radius:8px;background:#fff;">' : '<span style="flex:none;width:34px;height:34px;border-radius:10px;background:rgba(47,122,224,.1);color:#1f5fd0;display:flex;align-items:center;justify-content:center;">' + svg('M5 8l7-4 7 4-7 4zM5 8v8l7 4 7-4V8', 18) + '</span>';
      rows += '<button data-act="pickSupp" data-arg="' + esc(p.canonical_name) + '" style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:14px;border:1px solid rgba(15,40,90,.1);background:rgba(255,255,255,.66);cursor:pointer;">' + thumb + '<span style="flex:1;min-width:0;text-align:left;font-weight:600;font-size:16px;color:#0c2545;">' + esc(p.canonical_name) + '</span></button>';
    });
    return '<div style="font-family:var(--hf-font-display);font-weight:700;font-size:clamp(19px,2.4vw,24px);color:#0c2545;margin-bottom:16px;">Qual suplemento?</div>'
      + '<div style="position:relative;margin-bottom:14px;"><span style="position:absolute;left:16px;top:50%;transform:translateY(-50%);color:#8195ab;">' + svg('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20.5 20.5l-4-4', 20, 2) + '</span><input value="' + esc(S.flow.query || '') + '" data-input="query" data-focus="query" placeholder="Digite o nome do suplemento…" style="width:100%;min-height:58px;font-size:17px;padding:12px 16px 12px 46px;border:1px solid rgba(15,40,90,.16);border-radius:16px;background:rgba(255,255,255,.9);color:#0c2545;outline:none;"></div>'
      + '<div class="hf-scroll" style="display:flex;flex-direction:column;gap:8px;max-height:42dvh;overflow-y:auto;">' + rows + '</div>'
      + '<div style="display:flex;gap:11px;margin-top:18px;">' + backBtn() + '</div>';
  }
  function flowBatch() {
    var rec = '';
    (DATA.recent_batches || []).slice(0, 6).forEach(function (r) { var bn = r.batch_number || r; rec += '<button data-act="pickBatch" data-arg="' + esc(bn) + '" style="border:1px solid rgba(15,40,90,.14);background:rgba(255,255,255,.7);color:#0c2545;border-radius:13px;padding:11px 16px;font-weight:700;font-size:14px;cursor:pointer;font-family:var(--hf-font-display);">' + esc(bn) + '</button>'; });
    return '<div style="font-family:var(--hf-font-display);font-weight:700;font-size:clamp(19px,2.4vw,24px);color:#0c2545;margin-bottom:6px;">Qual lote?</div><div style="font-size:14px;color:#5a6e87;margin-bottom:16px;">Digite os 4 números (ex: 0190) ou escolha um recente.</div>'
      + '<input value="' + esc(S.flow.batchInput || '') + '" data-input="batch" data-focus="batch" inputmode="numeric" placeholder="0190" style="width:100%;min-height:62px;font-size:24px;font-weight:700;letter-spacing:.08em;text-align:center;padding:12px 16px;border:1px solid rgba(15,40,90,.16);border-radius:16px;background:rgba(255,255,255,.9);color:#0c2545;outline:none;margin-bottom:14px;font-family:var(--hf-font-display);">'
      + '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#8195ab;margin-bottom:10px;">Recentes</div><div style="display:flex;flex-wrap:wrap;gap:9px;">' + rec + '</div>'
      + '<div style="display:flex;gap:11px;margin-top:22px;">' + backBtn() + '<button data-act="skipBatch" style="flex:1;border:1px solid rgba(15,40,90,.14);background:rgba(255,255,255,.6);color:#42566f;border-radius:16px;padding:15px;font-weight:700;font-size:15px;cursor:pointer;">Sem lote</button><button data-act="batchOk" style="flex:1.4;border:0;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 88%,#19c277),var(--accent));color:#fff;border-radius:16px;padding:15px;font-weight:700;font-size:15px;cursor:pointer;">Confirmar lote</button></div>';
  }
  function chip(c, txt, iconp) { return '<span style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:700;color:' + (c === 'blue' ? '#1f5fd0' : '#0e7a4e') + ';background:' + (c === 'blue' ? 'rgba(47,122,224,.1)' : 'rgba(14,122,78,.1)') + ';padding:4px 10px;border-radius:8px;">' + svg(iconp, 13, 2) + esc(txt) + '</span>'; }
  function flowConfirm() {
    var f = S.flow; var meta = typeMeta(f.slug);
    var noteReq = !!meta.note_required; var ordersReq = !!meta.orders_required;
    var h = '<div style="display:flex;align-items:center;gap:14px;background:rgba(255,255,255,.66);border:1px solid rgba(15,40,90,.1);border-left:4px solid var(--accent);border-radius:20px;padding:16px;margin-bottom:20px;"><span style="flex:none;width:50px;height:50px;border-radius:15px;background:color-mix(in srgb,var(--accent) 13%,white);color:var(--accent);display:flex;align-items:center;justify-content:center;">' + svg(iconPath(f.slug), 26, 1.7) + '</span><div style="flex:1;min-width:0;"><div style="font-family:var(--hf-font-display);font-weight:700;font-size:18px;color:#0c2545;">' + esc(labelOf(f.slug)) + '</div><div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:6px;">' + (f.supplement ? chip('blue', f.supplement, 'M21 8l-9-5-9 5 9 5 9-5z') : '') + (f.batch ? chip('green', f.batch, 'M4 9h16M4 15h16M10 3L8 21M16 3l-2 18') : '') + '</div></div></div>';
    // quando começou
    h += sectionLabel('Quando começou?', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2');
    h += '<div style="display:flex;gap:11px;margin-bottom:14px;"><button data-act="modeNow" style="' + segBtn(!f.forgot, accent()) + '">Agora</button><button data-act="modeForgot" style="' + segBtn(f.forgot, accent()) + '">Esqueci de marcar</button></div>';
    if (f.forgot) {
      h += '<div style="background:rgba(15,40,90,.04);border-radius:16px;padding:14px;margin-bottom:18px;"><div style="display:flex;gap:9px;align-items:center;">' + timeSelect('tpH', f.tpH, 'h') + timeSelect('tpM', f.tpM, 'm') + '<button data-act="toggleAP" style="flex:none;min-width:70px;min-height:52px;font-size:16px;font-weight:800;font-family:var(--hf-font-display);background:#2c505f;color:#fff;border:0;border-radius:13px;cursor:pointer;">' + esc(f.tpAP) + '</button></div><div style="min-height:20px;margin-top:9px;font-size:14px;font-weight:700;color:' + startStatus(f).color + ';">' + esc(startStatus(f).text) + '</div></div>';
    }
    // cowork
    h += sectionLabel('Tem alguém junto?', 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0 0M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75');
    h += '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px;">';
    (S.team || []).filter(function (o) { return o.id !== S.session.person.id; }).forEach(function (o) {
      var on = (f.cowork || []).indexOf(o.id) >= 0;
      h += '<button data-act="toggleCowork" data-arg="' + o.id + '" style="display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:14px;cursor:pointer;border:1px solid ' + (on ? 'color-mix(in srgb,var(--accent) 50%,white)' : 'rgba(15,40,90,.1)') + ';background:' + (on ? 'color-mix(in srgb,var(--accent) 8%,white)' : 'rgba(255,255,255,.6)') + ';"><span style="flex:none;width:24px;height:24px;border-radius:7px;border:2px solid ' + (on ? 'var(--accent)' : 'rgba(15,40,90,.25)') + ';background:' + (on ? 'var(--accent)' : 'transparent') + ';color:#fff;display:flex;align-items:center;justify-content:center;">' + (on ? svg('M20 6L9 17l-5-5', 15, 3.4) : '') + '</span><span style="position:relative;flex:none;width:34px;height:34px;border-radius:50%;background:linear-gradient(140deg,#5a6e87,#42566f);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;">' + esc(D.initials(o.display_name)) + '</span><span style="flex:1;min-width:0;text-align:left;"><span style="display:block;font-weight:700;font-size:14.5px;color:#0c2545;">' + esc(o.display_name) + '</span><span style="display:block;font-size:12px;color:#8195ab;">' + esc(o.current_slug ? 'em ' + labelOf(o.current_slug) : (o.online ? 'disponível' : 'offline')) + '</span></span></button>';
    });
    h += '</div>';
    if (ordersReq) { h += sectionLabel('Quantas ordens vai imprimir?', 'M6 9V3.5h12V9'); h += '<input value="' + esc(f.ordersInput || '') + '" data-input="orders" inputmode="numeric" placeholder="ex: 206" style="width:100%;min-height:56px;font-size:18px;padding:12px 16px;border:1px solid rgba(15,40,90,.16);border-radius:14px;background:rgba(255,255,255,.9);color:#0c2545;outline:none;margin-bottom:18px;">'; }
    // nota
    h += sectionLabel(noteReq ? 'Nota (OBRIGATÓRIA)' : 'Nota (opcional)', 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z');
    h += '<textarea data-input="note" placeholder="' + (noteReq ? 'Conta o que está fazendo' : 'Escreve ou usa o microfone…') + '" style="width:100%;min-height:84px;font-size:16px;padding:13px 15px;border:1px solid rgba(15,40,90,.16);border-radius:14px;background:rgba(255,255,255,.9);color:#0c2545;outline:none;">' + esc(f.note || '') + '</textarea>';
    h += '<div style="display:flex;justify-content:flex-end;margin-top:10px;">' + voiceBtn('flow') + '</div>';
    var goLabel = f.forgot && startStatus(f).ok ? ('COMEÇAR ÀS ' + startStatus(f).label.toUpperCase()) : 'COMEÇAR';
    h += '<div style="display:flex;gap:11px;margin-top:24px;">' + backBtn() + '<button data-act="confirmStart" style="flex:2;position:relative;overflow:hidden;white-space:nowrap;border:0;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 86%,#19c277),var(--accent));color:#fff;border-radius:16px;padding:16px;font-weight:800;font-size:16px;font-family:var(--hf-font-display);cursor:pointer;box-shadow:0 16px 34px -14px color-mix(in srgb,var(--accent) 64%,transparent);display:flex;align-items:center;justify-content:center;gap:9px;">' + svg('M6 4l14 8-14 8z', 20, 0).replace('fill="none"', 'fill="currentColor"') + esc(goLabel) + '</button></div>';
    return h;
  }
  function flowFinished() {
    var f = S.flow;
    var h = '<div style="background:rgba(255,255,255,.66);border:1px solid rgba(15,40,90,.1);border-radius:18px;padding:16px;margin-bottom:20px;"><div style="font-family:var(--hf-font-display);font-weight:700;font-size:17px;color:#0c2545;">' + esc(labelOf(f.slug)) + '</div><div style="font-size:14px;color:#5a6e87;margin-top:4px;">Começou às ' + esc(startStatus(f).label) + '</div></div>';
    h += '<div style="font-family:var(--hf-font-display);font-weight:700;font-size:clamp(18px,2.2vw,22px);color:#0c2545;margin-bottom:14px;">Você já terminou essa tarefa?</div>';
    h += '<div style="display:flex;gap:11px;margin-bottom:14px;"><button data-act="finishedNo" style="' + segBtn(f.finished === 'no', accent()) + '">Não — ainda fazendo</button><button data-act="finishedYes" style="' + segBtn(f.finished === 'yes', accent()) + '">Sim — escolher fim</button></div>';
    if (f.finished === 'yes') {
      h += '<div style="background:rgba(15,40,90,.04);border-radius:16px;padding:14px;margin-bottom:18px;"><div style="display:flex;gap:9px;align-items:center;">' + timeSelect('endH', f.endH, 'h') + timeSelect('endM', f.endM, 'm') + '<button data-act="toggleEndAP" style="flex:none;min-width:70px;min-height:52px;font-size:16px;font-weight:800;font-family:var(--hf-font-display);background:#2c505f;color:#fff;border:0;border-radius:13px;cursor:pointer;">' + esc(f.endAP) + '</button></div><div style="min-height:20px;margin-top:9px;font-size:14px;font-weight:700;color:' + endStatus(f).color + ';">' + esc(endStatus(f).text) + '</div></div>';
    }
    h += '<div style="display:flex;gap:11px;margin-top:8px;">' + backBtn() + '<button data-act="commitRetro" style="flex:2;border:0;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 86%,#19c277),var(--accent));color:#fff;border-radius:16px;padding:16px;font-weight:800;font-size:16px;font-family:var(--hf-font-display);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:9px;">' + svg('M20 6L9 17l-5-5', 18, 2.6) + 'Adicionar tarefa</button></div>';
    return h;
  }
  function sectionLabel(txt, iconp) { return '<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6c819b;margin-bottom:10px;display:flex;align-items:center;gap:7px;">' + svg(iconp, 15, 2) + esc(txt) + '</div>'; }
  function segBtn(on, ac) { return 'flex:1;display:flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;border-radius:14px;padding:14px;font-weight:700;font-size:15px;font-family:var(--hf-font-display);border:' + (on ? '0' : '1px solid rgba(15,40,90,.14)') + ';background:' + (on ? ac : 'rgba(255,255,255,.6)') + ';color:' + (on ? '#fff' : '#42566f') + ';'; }
  function backBtn() { return '<button data-act="flowBack" style="flex:1;border:1px solid rgba(15,40,90,.14);background:rgba(255,255,255,.6);color:#42566f;border-radius:16px;padding:15px;font-weight:700;font-size:15px;cursor:pointer;">← Voltar</button>'; }
  function timeSelect(name, val, kind) {
    var opts = ''; if (kind === 'h') { opts = '<option value="">h</option>'; for (var i = 1; i <= 12; i++) opts += '<option value="' + i + '"' + (String(val) === String(i) ? ' selected' : '') + '>' + i + '</option>'; }
    else { ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'].forEach(function (m) { opts += '<option value="' + m + '"' + (String(val) === m ? ' selected' : '') + '>:' + m + '</option>'; }); }
    return '<select data-change="' + name + '" style="flex:1;min-height:52px;font-size:17px;padding:10px;border:1px solid rgba(15,40,90,.16);border-radius:13px;background:#fff;color:#0c2545;">' + opts + '</select>';
  }
  function isoFromHMA(h, m, ap) { if (!h) return null; var hh = (parseInt(h, 10) % 12) + (ap === 'PM' ? 12 : 0); var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate(), hh, parseInt(m || '0', 10), 0, 0).toISOString(); }
  function startStatus(f) {
    if (!f.tpH) return { ok: false, color: '#8195ab', text: '', label: '' };
    var iso = isoFromHMA(f.tpH, f.tpM, f.tpAP); var label = D.clockStr(new Date(iso)).replace(/^0/, '') ;
    var lbl12 = fmt12(iso);
    if (new Date(iso).getTime() > Date.now()) return { ok: false, color: '#b3261e', text: '⛔ Não pode ser no futuro', label: lbl12 };
    return { ok: true, color: '#0e7a4e', text: '✅ Começou às ' + lbl12, label: lbl12, iso: iso };
  }
  function endStatus(f) {
    if (!f.endH) return { ok: false, color: '#8195ab', text: '', label: '' };
    var iso = isoFromHMA(f.endH, f.endM, f.endAP); var st = startStatus(f);
    var lbl12 = fmt12(iso);
    if (new Date(iso).getTime() > Date.now()) return { ok: false, color: '#b3261e', text: '⛔ Não pode ser no futuro', label: lbl12 };
    if (st.iso && new Date(iso).getTime() <= new Date(st.iso).getTime()) return { ok: false, color: '#b3261e', text: '⛔ Tem que ser depois do início', label: lbl12 };
    return { ok: true, color: '#0e7a4e', text: '✅ Terminou às ' + lbl12, label: lbl12, iso: iso };
  }
  function fmt12(iso) { var d = new Date(iso); var h = d.getHours(); var m = d.getMinutes(); var ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + ' ' + ap; }

  // ── voz (Web Speech + cronômetro; MediaRecorder opcional) ──
  function voiceBtn(target) {
    var on = S.voice.on && S.voice.target === target;
    return '<button data-act="voice" data-arg="' + target + '" style="display:inline-flex;align-items:center;gap:8px;border-radius:13px;padding:11px 16px;font-weight:700;font-size:14px;cursor:pointer;border:1px solid ' + (on ? '#b3261e' : 'rgba(15,40,90,.14)') + ';background:' + (on ? '#b3261e' : 'rgba(255,255,255,.7)') + ';color:' + (on ? '#fff' : '#42566f') + ';' + (on ? 'animation:hfPulse 1.2s infinite;' : '') + '">' + svg('M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4', 18, 1.9) + (on ? ('Gravando ' + S.voice.secs + 's…') : 'Falar') + '</button>';
  }

  // ============================================================
  // OVERLAYS
  function overlayBox(maxw, inner) { return '<div style="position:fixed;inset:0;z-index:45;background:rgba(12,30,55,.42);backdrop-filter:blur(7px);display:flex;align-items:center;justify-content:center;padding:18px;animation:hfFade .25s ease both;"><div class="hf-glass-strong" style="width:min(94vw,' + maxw + 'px);border-radius:28px;padding:clamp(22px,3vw,30px);animation:hfPop .3s ease both;">' + inner + '</div></div>'; }
  function overlayHTML() {
    var o = S.overlay; if (!o) return '';
    if (o.type === 'finish') {
      var inner = '<div style="display:flex;align-items:center;gap:13px;margin-bottom:18px;"><span style="flex:none;width:48px;height:48px;border-radius:15px;background:rgba(179,38,30,.1);color:#b3261e;display:flex;align-items:center;justify-content:center;">' + svg('M20 6L9 17l-5-5', 26, 1.7) + '</span><div style="font-family:var(--hf-font-display);font-weight:700;font-size:19px;color:#0c2545;">Finalizar: ' + esc(o.label) + '</div></div>';
      if (o.needsCount) inner += '<div style="font-size:14px;font-weight:600;color:#42566f;margin-bottom:8px;">Quantos bottles saíram? (pode deixar vazio)</div><input value="' + esc(o.bottles || '') + '" data-input="finBottles" inputmode="numeric" placeholder="ex: 746" style="width:100%;min-height:56px;font-size:18px;padding:12px 16px;border:1px solid rgba(15,40,90,.16);border-radius:14px;background:#fff;color:#0c2545;outline:none;margin-bottom:14px;">';
      inner += '<textarea data-input="finNote" placeholder="Nota final (opcional)" style="width:100%;min-height:78px;font-size:16px;padding:13px 15px;border:1px solid rgba(15,40,90,.16);border-radius:14px;background:#fff;color:#0c2545;outline:none;">' + esc(o.note || '') + '</textarea>';
      inner += '<div style="display:flex;gap:11px;margin-top:20px;"><button data-act="closeOverlay" style="flex:1;border:1px solid rgba(15,40,90,.14);background:rgba(255,255,255,.6);color:#42566f;border-radius:15px;padding:15px;font-weight:700;font-size:15px;cursor:pointer;">Cancelar</button><button data-act="doFinish" style="flex:1.5;border:0;background:linear-gradient(135deg,#cf463c,#b3261e);color:#fff;border-radius:15px;padding:15px;font-weight:800;font-size:16px;font-family:var(--hf-font-display);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">' + svg('M20 6L9 17l-5-5', 19, 2.6) + 'Finalizar</button></div>';
      return overlayBox(460, inner);
    }
    if (o.type === 'join') {
      var ji = '<div style="text-align:center;"><span style="display:inline-flex;width:56px;height:56px;border-radius:50%;background:rgba(47,122,224,.12);color:#1f5fd0;align-items:center;justify-content:center;margin-bottom:14px;">' + svg('M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0 0M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75', 28) + '</span><div style="font-family:var(--hf-font-display);font-weight:700;font-size:20px;color:#0c2545;margin-bottom:6px;">Entrar junto com ' + esc(o.name) + '?</div><div style="font-size:14px;color:#5a6e87;margin-bottom:22px;">' + esc(o.sub || '') + '</div><div style="display:flex;gap:11px;"><button data-act="closeOverlay" style="flex:1;border:1px solid rgba(15,40,90,.14);background:rgba(255,255,255,.6);color:#42566f;border-radius:15px;padding:15px;font-weight:700;font-size:15px;cursor:pointer;">Cancelar</button><button data-act="doJoin" style="flex:1.5;border:0;background:linear-gradient(135deg,#3a86ee,#1f5fd0);color:#fff;border-radius:15px;padding:15px;font-weight:800;font-size:16px;font-family:var(--hf-font-display);cursor:pointer;">Entrar</button></div></div>';
      return overlayBox(420, ji);
    }
    if (o.type === 'note') {
      var ni = '<div style="font-family:var(--hf-font-display);font-weight:700;font-size:19px;color:#0c2545;margin-bottom:16px;display:flex;align-items:center;gap:9px;">' + svg('M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', 19, 1.9) + 'Nota rápida</div><textarea data-input="ovNote" data-focus="ovNote" placeholder="Fale ou escreva a nota…" style="width:100%;min-height:96px;font-size:16px;padding:13px 15px;border:1px solid rgba(15,40,90,.16);border-radius:14px;background:#fff;color:#0c2545;outline:none;">' + esc(o.note || '') + '</textarea><div style="display:flex;justify-content:flex-end;margin-top:10px;">' + voiceBtn('note') + '</div><div style="display:flex;gap:11px;margin-top:18px;"><button data-act="closeOverlay" style="flex:1;border:1px solid rgba(15,40,90,.14);background:rgba(255,255,255,.6);color:#42566f;border-radius:15px;padding:15px;font-weight:700;font-size:15px;cursor:pointer;">Fechar</button><button data-act="saveNote" style="flex:1.5;border:0;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 86%,#19c277),var(--accent));color:#fff;border-radius:15px;padding:15px;font-weight:800;font-size:16px;font-family:var(--hf-font-display);cursor:pointer;">Salvar</button></div>';
      return overlayBox(460, ni);
    }
    if (o.type === 'clock') {
      var ci = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;"><span style="flex:none;width:46px;height:46px;border-radius:14px;background:rgba(179,92,0,.12);color:#b35c00;display:flex;align-items:center;justify-content:center;">' + svg('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', 24) + '</span><div style="font-family:var(--hf-font-display);font-weight:700;font-size:20px;color:#0c2545;">Fim do dia</div></div>';
      if ((o.missing || []).length) {
        ci += '<div style="font-size:14px;color:#5a6e87;margin-bottom:16px;">Antes de sair, confirme as contagens das produções de hoje:</div><div style="display:flex;flex-direction:column;gap:10px;">';
        o.missing.forEach(function (m, i) {
          var unk = (o.unknown || {})[m.event_id];
          ci += '<div style="background:rgba(255,255,255,.7);border:1px solid rgba(15,40,90,.12);border-radius:16px;padding:14px;"><div style="font-weight:700;font-size:15px;color:#0c2545;margin-bottom:9px;">' + esc((m.product || '?') + ' · ' + (m.batch_number || '')) + '</div><div style="display:flex;gap:10px;align-items:center;"><input value="' + esc((o.counts || {})[m.event_id] || '') + '" data-input="clockCount" data-arg="' + m.event_id + '" inputmode="numeric" ' + (unk ? 'disabled' : '') + ' placeholder="Quantos bottles?" style="flex:1;min-height:50px;font-size:16px;padding:10px 14px;border:1px solid rgba(15,40,90,.16);border-radius:12px;background:#fff;color:#0c2545;outline:none;"><button data-act="clockUnknown" data-arg="' + m.event_id + '" style="flex:none;border:1px solid ' + (unk ? '#b35c00' : 'rgba(15,40,90,.14)') + ';background:' + (unk ? 'rgba(179,92,0,.12)' : 'rgba(255,255,255,.6)') + ';color:' + (unk ? '#b35c00' : '#42566f') + ';border-radius:12px;padding:10px 14px;font-weight:700;font-size:14px;cursor:pointer;">Não sei</button></div></div>';
        });
        ci += '</div>';
        if (o.is_last && !o.can_skip) ci += '<div style="margin-top:12px;font-size:13px;color:#b35c00;font-weight:600;">⚠️ Você é o último a sair: preencha os números ou marque "Não sei".</div>';
      } else {
        ci += '<div style="background:rgba(14,122,78,.08);border-radius:16px;padding:18px;text-align:center;color:#0e7a4e;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center;gap:9px;">' + svg('M20 6L9 17l-5-5', 19, 2.4) + 'Todas as produções de hoje têm contagem. Pode sair tranquilo!</div>';
      }
      ci += '<div style="display:flex;gap:11px;margin-top:22px;"><button data-act="closeOverlay" style="flex:1;border:1px solid rgba(15,40,90,.14);background:rgba(255,255,255,.6);color:#42566f;border-radius:15px;padding:15px;font-weight:700;font-size:15px;cursor:pointer;">Voltar</button><button data-act="doClockOut" style="flex:1.5;border:0;background:linear-gradient(135deg,#d97712,#b35c00);color:#fff;border-radius:15px;padding:15px;font-weight:800;font-size:16px;font-family:var(--hf-font-display);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">' + svg('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', 17) + 'Confirmar e sair</button></div>';
      return overlayBox(520, ci);
    }
    if (o.type === 'forgotten') {
      var p = o.prompt;
      var fi = '<div style="text-align:center;"><span style="display:inline-flex;width:60px;height:60px;border-radius:50%;background:rgba(179,92,0,.12);color:#b35c00;align-items:center;justify-content:center;margin-bottom:16px;">' + svg('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2', 30, 1.7) + '</span><div style="font-family:var(--hf-font-display);font-weight:700;font-size:21px;color:#0c2545;margin-bottom:6px;">' + esc(p.person_name) + ' ainda está trabalhando?</div><div style="font-size:13px;color:#8195ab;margin-bottom:22px;">' + esc([p.last_activity_at ? 'última atividade ' + p.last_activity_at : '', p.expected_end_time ? 'saída prevista ' + p.expected_end_time : ''].filter(Boolean).join(' · ')) + '</div><div style="display:flex;flex-direction:column;gap:11px;"><button data-act="forgottenYes" style="border:0;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 86%,#19c277),var(--accent));color:#fff;border-radius:15px;padding:16px;font-weight:800;font-size:16px;font-family:var(--hf-font-display);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">' + svg('M20 6L9 17l-5-5', 17, 2.6) + 'Sim, ainda está na linha</button><button data-act="forgottenNo" style="border:1px solid rgba(179,38,30,.25);background:rgba(255,255,255,.6);color:#b3261e;border-radius:15px;padding:16px;font-weight:700;font-size:15px;cursor:pointer;">Não, fazer checkout dela</button></div></div>';
      return '<div style="position:fixed;inset:0;z-index:48;background:rgba(12,30,55,.5);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:18px;animation:hfFade .25s ease both;"><div class="hf-glass-strong" style="width:min(94vw,440px);border-radius:28px;padding:clamp(24px,3.2vw,32px);animation:hfPop .3s ease both;">' + fi + '</div></div>';
    }
    return '';
  }

  // SETTINGS (admin)
  function toggle(act, on) { return '<button data-act="' + act + '" style="flex:none;width:46px;height:26px;border-radius:999px;border:0;cursor:pointer;background:' + (on ? accent() : 'rgba(15,40,90,.18)') + ';position:relative;transition:background .15s;"><span style="position:absolute;top:3px;left:' + (on ? '23px' : '3px') + ';width:20px;height:20px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 2px 6px rgba(0,0,0,.2);"></span></button>'; }
  function seg(act, arg, label, on) { return '<button data-act="' + act + '" data-arg="' + arg + '" style="flex:1;cursor:pointer;border-radius:11px;padding:9px 4px;font-weight:700;font-size:12.5px;border:' + (on ? '0' : '1px solid rgba(15,40,90,.12)') + ';background:' + (on ? accent() : 'rgba(255,255,255,.6)') + ';color:' + (on ? '#fff' : '#5a6e87') + ';">' + esc(label) + '</button>'; }
  function settingsHTML() {
    var st = S.settings;
    var h = '<div data-act="toggleSettings" style="position:fixed;inset:0;z-index:50;"></div><div style="position:fixed;top:74px;right:clamp(14px,2.6vw,30px);z-index:51;width:min(92vw,320px);background:rgba(255,255,255,.9);backdrop-filter:blur(30px) saturate(1.5);border:1px solid rgba(255,255,255,.85);border-radius:24px;box-shadow:0 40px 90px -34px rgba(12,37,69,.55);padding:20px;animation:hfPop .25s ease both;">';
    h += '<div style="display:flex;align-items:center;gap:9px;margin-bottom:16px;">' + svg('M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM12 1v4M12 19v4M1 12h4M19 12h4', 18, 1.8) + '<div style="font-family:var(--hf-font-display);font-weight:700;font-size:16px;color:#0c2545;">Ajustes do admin</div></div>';
    h += '<div style="display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid rgba(15,40,90,.08);"><div><div style="font-weight:700;font-size:14px;color:#0c2545;">Frases inspiradoras</div><div style="font-size:12px;color:#8195ab;">Mensagens flutuantes</div></div>' + toggle('toggleMantras', st.mantras) + '</div>';
    h += '<div style="padding:12px 0 6px;"><div style="font-weight:700;font-size:13px;color:#42566f;margin-bottom:8px;">Idioma das frases</div><div style="display:flex;gap:6px;">' + seg('setLang', 'pt', 'PT', st.mantraLang === 'pt') + seg('setLang', 'es', 'ES', st.mantraLang === 'es') + seg('setLang', 'en', 'EN', st.mantraLang === 'en') + seg('setLang', 'rotate', '🔄', st.mantraLang === 'rotate') + '</div></div>';
    h += '<div style="padding:12px 0 6px;"><div style="font-weight:700;font-size:13px;color:#42566f;margin-bottom:8px;">Fase do dia (cor do ambiente)</div><div style="display:flex;gap:6px;">' + seg('setPhase', 'morning', 'Manhã', st.dayPhase === 'morning') + seg('setPhase', 'afternoon', 'Tarde', st.dayPhase === 'afternoon') + seg('setPhase', 'evening', 'Noite', st.dayPhase === 'evening') + seg('setPhase', 'auto', 'Auto', st.dayPhase === 'auto') + '</div></div>';
    h += '<div style="padding:12px 0 4px;"><div style="font-weight:700;font-size:13px;color:#42566f;margin-bottom:8px;">Densidade do ambiente</div><div style="display:flex;gap:6px;">' + seg('setDens', 'low', 'Sutil', st.density === 'low') + seg('setDens', 'medium', 'Médio', st.density === 'medium') + seg('setDens', 'high', 'Intenso', st.density === 'high') + '</div></div>';
    h += '<div style="margin-top:8px;padding-top:14px;border-top:1px solid rgba(15,40,90,.1);"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><div><div style="display:flex;align-items:center;gap:7px;font-weight:700;font-size:14px;color:#0c2545;">Alerta de duração<span style="font-size:9.5px;font-weight:800;color:#b35c00;background:rgba(217,145,0,.14);padding:2px 6px;border-radius:6px;">BETA</span></div><div style="font-size:12px;color:#8195ab;margin-top:2px;">A tarefa muda de cor se demorar demais</div></div>' + toggle('toggleAging', st.aging) + '</div>';
    if (st.aging) {
      h += '<div style="margin-top:13px;display:flex;flex-direction:column;gap:9px;">' + stepper('Avisar após', 'warn', st.warnMin) + stepper('Marcar atrasada após', 'over', st.overMin) + '</div>';
    }
    h += '</div></div>';
    return h;
  }
  function stepper(label, key, val) { return '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><span style="font-size:13px;font-weight:600;color:#42566f;">' + esc(label) + '</span><span style="display:flex;align-items:center;gap:8px;"><button data-act="agingStep" data-arg="' + key + ':-" style="width:30px;height:30px;border-radius:9px;border:1px solid rgba(15,40,90,.16);background:rgba(255,255,255,.7);color:#42566f;font-weight:800;font-size:17px;cursor:pointer;line-height:1;">−</button><span style="min-width:58px;text-align:center;font-family:var(--hf-font-display);font-weight:700;font-size:14px;color:#0c2545;">' + val + ' min</span><button data-act="agingStep" data-arg="' + key + ':+" style="width:30px;height:30px;border-radius:9px;border:1px solid rgba(15,40,90,.16);background:rgba(255,255,255,.7);color:#42566f;font-weight:800;font-size:17px;cursor:pointer;line-height:1;">+</button></span></div>'; }

  // ============================================================
  // DADOS
  function loadData() {
    if (!S.session) return Promise.resolve();
    return Promise.all([
      api('/api/v3/architect/person/' + S.session.person.id + '/today', { headers: { 'X-Operator-Id': String(S.session.person.id) } }).catch(function () { return { events: [] }; }),
      api('/api/v3/op/active-operators').catch(function () { return { operators: [] }; }),
    ]).then(function (r) {
      var mine = r[0] || { events: [] }; var ops = r[1] || { operators: [] };
      var evs = mine.events || [];
      S.myTasks = evs.filter(function (e) { return !e.ended_at; });
      S.completedToday = evs.filter(function (e) { return e.ended_at; }).length;
      S.goal = mine.goal || Math.max(8, evs.length);
      S.team = ops.operators || [];
      render();
    });
  }

  // ── VOZ (Web Speech → preenche a nota; cronômetro 60s) ──────
  function startVoice(target) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    S.voice = { on: true, secs: 0, target: target }; render();
    voiceTimer = setInterval(function () { S.voice.secs += 1; if (S.voice.secs >= 60) { stopVoice(); } else render(); }, 1000);
    if (SR) {
      try {
        var r = new SR(); r.lang = ({ note: 'pt-BR' })[target] || 'pt-BR'; r.continuous = true; r.interimResults = true;
        var base = target === 'flow' ? (S.flow && S.flow.note || '') : (S.overlay && S.overlay.note || '');
        r.onresult = function (e) { var t = ''; for (var i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; var val = (base ? base + ' ' : '') + t; if (target === 'flow' && S.flow) S.flow.note = val; else if (S.overlay) S.overlay.note = val; };
        r.onerror = function () {}; r.start(); sr = r;
      } catch (e) { sr = null; }
    } else { toast('Neste aparelho a voz não está disponível — escreva a nota'); }
  }
  function stopVoice() { clearInterval(voiceTimer); try { sr && sr.stop(); } catch (e) {} sr = null; S.voice = { on: false, secs: 0, target: null }; render(); }
  var voiceTimer = null, sr = null;

  // ============================================================
  // HANDLERS (delegação)
  function flowDefaults(extra) { var n = new Date(); var ap = n.getHours() >= 12 ? 'PM' : 'AM'; var h12 = n.getHours() % 12 || 12; var m = String(Math.floor(n.getMinutes() / 5) * 5).padStart(2, '0'); return Object.assign({ step: 'group', cowork: [], note: '', forgot: false, tpH: '', tpM: m, tpAP: ap, endH: '', endM: m, endAP: ap, finished: 'no', ordersInput: '', requires_product: false }, extra || {}); }
  function bump() { if (S.session && S.session.auto_logoff_seconds) S.logoffLeft = S.session.auto_logoff_seconds; }

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
      if (f.step === 'type') f.step = 'group';
      else if (f.step === 'supp') f.step = 'type';
      else if (f.step === 'batch') f.step = 'supp';
      else if (f.step === 'confirm') f.step = f.requires_product ? 'batch' : 'type';
      else if (f.step === 'finished') f.step = 'confirm';
      else { S.flow = null; }
      render();
    },
    pickGroup: function (key) { S.flow.groupKey = key; S.flow.step = 'type'; render(); },
    quickLunch: function (slug) { S.flow.slug = slug; S.flow.requires_product = false; S.flow.step = 'confirm'; render(); },
    pickType: function (slug) { var m = typeMeta(slug); S.flow.slug = slug; S.flow.requires_product = !!m.requires_product; S.flow.step = m.requires_product ? 'supp' : 'confirm'; S._focus = m.requires_product ? 'query' : null; render(); },
    pickSupp: function (name) { S.flow.supplement = name; S.flow.step = 'batch'; S._focus = 'batch'; render(); },
    pickBatch: function (b) { S.flow.batch = b; S.flow.step = 'confirm'; S._focus = null; render(); },
    skipBatch: function () { S.flow.batch = null; S.flow.step = 'confirm'; S._focus = null; render(); },
    batchOk: function () { var v = (S.flow.batchInput || '').trim(); S.flow.batch = v || null; S.flow.step = 'confirm'; S._focus = null; render(); },
    modeNow: function () { S.flow.forgot = false; render(); },
    modeForgot: function () { S.flow.forgot = true; if (!S.flow.tpH) { var n = new Date(); S.flow.tpH = String(n.getHours() % 12 || 12); S.flow.tpAP = n.getHours() >= 12 ? 'PM' : 'AM'; } render(); },
    toggleAP: function () { S.flow.tpAP = S.flow.tpAP === 'AM' ? 'PM' : 'AM'; render(); },
    toggleEndAP: function () { S.flow.endAP = S.flow.endAP === 'AM' ? 'PM' : 'AM'; render(); },
    toggleCowork: function (id) { id = parseInt(id, 10); var i = S.flow.cowork.indexOf(id); if (i >= 0) S.flow.cowork.splice(i, 1); else S.flow.cowork.push(id); render(); },
    confirmStart: function () { confirmStart(); },
    finishedNo: function () { S.flow.finished = 'no'; render(); },
    finishedYes: function () { S.flow.finished = 'yes'; if (!S.flow.endH) { S.flow.endH = String(new Date().getHours() % 12 || 12); S.flow.endAP = new Date().getHours() >= 12 ? 'PM' : 'AM'; } render(); },
    commitRetro: function () { commitRetro(); },
    finish: function (id) { var t = S.myTasks.find(function (x) { return String(x.id) === String(id); }) || {}; S.overlay = { type: 'finish', eventId: id, label: labelOf(t.slug), needsCount: ['production_line', 'encapsulation'].indexOf(t.slug) >= 0, bottles: '', note: '' }; render(); },
    doFinish: function () { doFinish(); },
    join: function (id, el) { S.overlay = { type: 'join', eventId: id, name: el.getAttribute('data-name') || 'colega', sub: '' }; render(); },
    doJoin: function () { var o = S.overlay; api('/api/v3/op/event/' + o.eventId + '/join', { method: 'POST', body: {} }).then(function () { S.overlay = null; toast('✅ Você entrou junto'); loadData(); }).catch(function (e) { toast('❌ ' + e.message); }); },
    note: function () { S.overlay = { type: 'note', note: '' }; S._focus = 'ovNote'; render(); },
    saveNote: function () { var o = S.overlay; var txt = (o.note || '').trim(); if (!txt) { toast('Escreve algo'); return; } api('/api/v3/op/note', { method: 'POST', body: { text: txt } }).then(function () { S.overlay = null; toast('✅ Nota salva'); }).catch(function (e) { toast('❌ ' + e.message); }); },
    closeOverlay: function () { if (S.voice.on) stopVoice(); S.overlay = null; render(); },
    doClockOut: function () { doClockOut(); },
    clockUnknown: function (id) { var o = S.overlay; o.unknown = o.unknown || {}; o.unknown[id] = !o.unknown[id]; if (o.unknown[id]) { o.counts = o.counts || {}; delete o.counts[id]; } render(); },
    forgottenYes: function () { resolveForgotten(true); },
    forgottenNo: function () { resolveForgotten(false); },
    voice: function (target) { if (S.voice.on) stopVoice(); else startVoice(target); },
    // settings
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
      S.pinError = ''; S.screen = 'home'; bump(); render();
      loadData();
      if (r.forgotten_check_prompts && r.forgotten_check_prompts.length) { forgottenQueue = r.forgotten_check_prompts.slice(); nextForgotten('login'); }
      startTimers();
    }).catch(function (e) {
      S.pinError = e.status === 429 ? 'Muitas tentativas — espera 1 min' : 'PIN incorreto'; S.shake = true; render();
      setTimeout(function () { S.shake = false; render(); }, 650);
    });
  }
  function endSession() { S.session = null; S.screen = 'login'; S.pin = ''; S.myTasks = []; S.team = []; stopTimers(); render(); }
  function doLogout(reason) { api('/api/v3/op/auth/logout', { method: 'POST', body: { reason: reason } }).catch(function () {}); endSession(); }

  function confirmStart() {
    var f = S.flow; var m = typeMeta(f.slug);
    if (m.note_required && !(f.note || '').trim()) { toast('📝 Conta o que está fazendo (ou usa 🎤)'); return; }
    if (m.orders_required && !(parseInt(f.ordersInput, 10) > 0)) { toast('🔢 Informe quantas ordens'); return; }
    if (f.forgot) { var st = startStatus(f); if (!st.ok) { toast(st.text || 'Escolhe um horário válido'); return; } f.step = 'finished'; render(); return; }
    postStart(null, null);
  }
  function commitRetro() {
    var f = S.flow; var st = startStatus(f); if (!st.ok) { toast('Horário de início inválido'); return; }
    var ended = null; if (f.finished === 'yes') { var es = endStatus(f); if (!es.ok) { toast(es.text || 'Escolhe a hora de fim'); return; } ended = es.iso; }
    postStart(st.iso, ended);
  }
  function postStart(startedAt, endedAt) {
    var f = S.flow; var m = typeMeta(f.slug);
    var body = { activity_slug: f.slug, batch_number: f.batch || null, cowork_with: f.cowork || [], note: (f.note || '').trim() || null };
    if (m.orders_required) body.orders_printed = parseInt(f.ordersInput, 10);
    var path = startedAt ? '/api/v3/op/event/retroactive' : '/api/v3/op/event/start';
    if (startedAt) { body.started_at = startedAt; body.ended_at = endedAt || null; }
    api(path, { method: 'POST', body: body }).then(function (res) {
      S.flow = null; if (S.voice.on) stopVoice();
      toast(res && res.queued ? '📥 Salvo offline — sincroniza ao voltar' : (startedAt ? '✅ Tarefa adicionada' : '✅ Tarefa iniciada!'));
      loadData();
    }).catch(function (e) {
      var M = { note_required: 'Precisa de nota', orders_printed_required: 'Precisa da quantidade', started_at_future: 'Hora no futuro', started_at_not_today: 'Só dá pra hoje', ended_at_invalid: 'Hora de fim inválida', unknown_batch: 'Lote não encontrado' };
      toast('❌ ' + (M[e.message] || e.message));
    });
  }
  function doFinish() {
    var o = S.overlay; var body = { bottles: (o.bottles !== '' && parseInt(o.bottles, 10) >= 0) ? parseInt(o.bottles, 10) : null, note: (o.note || '').trim() || null };
    api('/api/v3/op/event/' + o.eventId + '/end', { method: 'POST', body: body }).then(function () { S.overlay = null; if (S.voice.on) stopVoice(); toast('✅ Finalizada!'); loadData(); }).catch(function (e) { toast('❌ ' + e.message); });
  }
  function openClock() {
    api('/api/v3/op/missing-bottle-counts').then(function (info) {
      S.overlay = { type: 'clock', missing: info.missing || [], is_last: info.is_last_operator, can_skip: info.can_skip, counts: {}, unknown: {} }; render();
    }).catch(function (e) { toast('❌ ' + e.message); });
  }
  function doClockOut() {
    var o = S.overlay; var counts = []; var unknown = []; var incomplete = false;
    (o.missing || []).forEach(function (m) {
      if ((o.unknown || {})[m.event_id]) unknown.push(m.event_id);
      else { var v = (o.counts || {})[m.event_id]; if (v !== undefined && v !== '' && parseInt(v, 10) >= 0) counts.push({ event_id: m.event_id, bottles: parseInt(v, 10) }); else incomplete = true; }
    });
    if (incomplete && o.is_last && !o.can_skip && (o.missing || []).length) { toast('Preenche os números ou marca "Não sei"'); return; }
    api('/api/v3/op/clock-out', { method: 'POST', body: { counts: counts, unknown_event_ids: unknown } }).then(function () { S.overlay = null; toast('👋 Até amanhã!'); endSession(); }).catch(function (e) {
      if (e.status === 422 && e.body && e.body.missing) { S.overlay = { type: 'clock', missing: e.body.missing, is_last: true, can_skip: false, counts: o.counts || {}, unknown: o.unknown || {} }; render(); }
      else toast('❌ ' + e.message);
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

  // ── delegação de eventos (uma vez) ─────────────────────────
  ROOT.addEventListener('click', function (e) { var el = e.target.closest('[data-act]'); if (!el) return; bump(); var fn = ACT[el.dataset.act]; if (fn) fn(el.dataset.arg, el); });
  ROOT.addEventListener('input', function (e) {
    var el = e.target.closest('[data-input]'); if (!el) return; bump(); var k = el.dataset.input; var v = el.value;
    if (k === 'query') { S.flow.query = v; S._focus = 'query'; render(); }
    else if (k === 'batch') { S.flow.batchInput = v; }
    else if (k === 'orders') { S.flow.ordersInput = v; }
    else if (k === 'note') { S.flow.note = v; }
    else if (k === 'ovNote') { S.overlay.note = v; }
    else if (k === 'finBottles') { S.overlay.bottles = v; }
    else if (k === 'finNote') { S.overlay.note = v; }
    else if (k === 'clockCount') { S.overlay.counts = S.overlay.counts || {}; S.overlay.counts[el.dataset.arg] = v; }
  });
  ROOT.addEventListener('change', function (e) {
    var el = e.target.closest('[data-change]'); if (!el) return; bump(); var k = el.dataset.change;
    if (S.flow) { S.flow[k] = el.value; render(); }
  });

  // ── timers ─────────────────────────────────────────────────
  var tClock = null, tBeat = null, tMantra = null;
  function startTimers() {
    stopTimers();
    tClock = setInterval(function () {
      S.now = Date.now();
      if (S.session && S.logoffLeft != null) { S.logoffLeft -= 1; if (S.logoffLeft <= 0) { doLogout('auto_timeout'); return; } }
      if (S.screen === 'home' || S.session) render();
    }, 1000);
    tBeat = setInterval(function () { if (S.session) api('/api/v3/op/auth/heartbeat', { method: 'POST' }).catch(function () {}); }, 45000);
    tMantra = setInterval(function () { S.mantraIdx = (S.mantraIdx + 1) % MANTRAS.length; if (S.settings.mantras && S.screen === 'home') render(); }, 7000);
  }
  function stopTimers() { clearInterval(tClock); clearInterval(tBeat); clearInterval(tMantra); S.logoffLeft = null; }

  window.addEventListener('online', function () { S.online = true; if (Q && Q.flush) Q.flush(function (item) { return fetch(item.path, { method: 'POST', headers: { Authorization: 'Bearer ' + CFG.pageToken, 'X-Session-Token': item.sessionToken || (S.session && S.session.token), 'Content-Type': 'application/json' }, body: JSON.stringify(item.body) }).then(function (r) { return r.ok; }); }).then(function () { loadData(); }); });
  window.addEventListener('offline', function () { S.online = false; });

  // boot
  render();
}());
