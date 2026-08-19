'use strict';
/* HEALTHFARE — Estação de Impressão (.28). "User Screen" kiosk (Bruno 07-16).
 * Login por PIN IDÊNTICO ao /op (mesmo visual + mesmos PINs via /api/v3/op/auth/login).
 * Ao logar → abre a task "Impressão de Labels" (activity_slug=label_printing).
 * Botão OTHER → não-funcionário diz quem é + o que vai fazer → Slack #admin-orin.
 * Auto-lock: 10 min sem re-toque → volta pro PIN. Ver [[label-printing-station]]. */
(function () {
  var AC = '#1f5fd0';                 // accent (mesmo azul do /op)
  var LOCK_MS = 10 * 60 * 1000;       // 10 min → volta pro login
  var S = { screen: 'login', pin: '', pinError: '', shake: false, session: null, person: null, other: { name: '', what: '' }, busy: false, queueMsg: '' };
  var lockTimer = null;
  var center = document.getElementById('pcenter');

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ── fundo idêntico ao /op (blobs de gradiente) ─────────────────────────────
  document.getElementById('pambient').innerHTML =
    '<div style="position:absolute; width:62vmax; height:62vmax; left:-16vmax; top:-20vmax; border-radius:50%; background:radial-gradient(circle,#2f7ae0,transparent 68%); filter:blur(60px); opacity:.36;"></div>' +
    '<div style="position:absolute; width:58vmax; height:58vmax; right:-18vmax; top:8vmax; border-radius:50%; background:radial-gradient(circle,#44ae4f,transparent 66%); filter:blur(64px); opacity:.34;"></div>' +
    '<div style="position:absolute; width:54vmax; height:54vmax; left:24vmax; bottom:-24vmax; border-radius:50%; background:radial-gradient(circle,#1b8f8f,transparent 70%); filter:blur(66px); opacity:.24;"></div>' +
    '<div style="position:absolute; width:40vmax; height:40vmax; right:18vmax; bottom:-12vmax; border-radius:50%; background:radial-gradient(circle,#0f4c92,transparent 72%); filter:blur(70px); opacity:.18;"></div>';

  // ── card de login (copiado do loginInner do /op) + botão OTHER ─────────────
  function loginCard() {
    var dots = '';
    for (var i = 0; i < 4; i++) {
      var on = S.pin.length > i;
      dots += '<div style="width:16px; height:16px; border-radius:50%; transition:all .2s; background:' + (on ? AC : 'transparent') + '; border:2px solid ' + (on ? AC : 'rgba(15,40,90,.28)') + '; transform:' + (on ? 'scale(1.18)' : 'scale(1)') + ';"></div>';
    }
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'], kp = '';
    keys.forEach(function (k) {
      var isOk = k === '✓', isDel = k === '⌫';
      var base = 'aspect-ratio:1; border-radius:50%; cursor:pointer; font-family:\'Sora\',sans-serif; font-weight:700; font-size:clamp(22px,3vw,28px); display:flex; align-items:center; justify-content:center; transition:transform .1s, background .15s; min-height:0;';
      var st = isOk ? base + 'border:0; color:#fff; background:linear-gradient(135deg, color-mix(in srgb,' + AC + ' 86%,#19c277),' + AC + '); box-shadow:0 14px 30px -12px color-mix(in srgb,' + AC + ' 70%,transparent);'
        : isDel ? base + 'border:1px solid rgba(15,40,90,.12); color:#6c819b; background:rgba(255,255,255,.5); font-size:clamp(20px,2.6vw,26px);'
          : base + 'border:1px solid rgba(255,255,255,.85); color:#0c2545; background:rgba(255,255,255,.72); box-shadow:0 10px 24px -16px rgba(15,40,90,.5);';
      kp += '<button data-act="pinkey" data-arg="' + k + '" style="' + st + '">' + k + '</button>';
    });
    return '<div style="width:min(94vw,420px); background:rgba(255,255,255,.66); backdrop-filter:blur(26px) saturate(1.5); border:1px solid rgba(255,255,255,.8); border-radius:34px; padding:clamp(26px,4vw,40px) clamp(22px,3.6vw,36px); box-shadow:0 40px 90px -36px rgba(15,40,90,.5), inset 0 1px 0 rgba(255,255,255,.9); text-align:center;">'
      + '<img src="/op/assets/healthfare-logo.png" alt="HealthFare" style="height:clamp(46px,7vw,58px); width:auto; margin:0 auto 10px;">'
      + '<div style="font-family:\'Sora\',sans-serif; font-weight:600; font-size:14px; letter-spacing:.16em; text-transform:uppercase; color:#6c819b; margin-bottom:22px;">Estação de Impressão</div>'
      + '<div style="' + (S.shake ? 'animation:hfShake .4s;' : '') + '"><div style="display:flex; justify-content:center; gap:16px; margin-bottom:10px;">' + dots + '</div></div>'
      + '<div style="min-height:22px; color:#c0352b; font-weight:700; font-size:14px; margin-bottom:14px;">' + esc(S.pinError) + '</div>'
      + '<div style="display:grid; grid-template-columns:repeat(3,1fr); gap:clamp(10px,1.8vw,15px); max-width:320px; margin:0 auto;">' + kp + '</div>'
      + '<div style="margin-top:22px; font-size:12.5px; color:#566681; font-weight:500;">Toque seu PIN de 4 dígitos para entrar e imprimir</div>'
      + '<button data-act="other" style="margin-top:16px; padding:11px 20px; border-radius:14px; border:1px dashed rgba(15,40,90,.28); background:rgba(255,255,255,.5); color:#42566f; font-weight:700; font-size:13px; cursor:pointer;">Não sou funcionário — OTHER</button>'
      + '</div>';
  }

  // ── OTHER: quem é + o que vai fazer (requisito pra usar o PC) ───────────────
  function otherCard() {
    var inp = 'width:100%; box-sizing:border-box; margin-top:6px; padding:13px 15px; border:1px solid rgba(15,40,90,.16); border-radius:14px; font-size:16px; background:#fff; color:#0c2545; outline:none;';
    return '<div style="width:min(94vw,440px); background:rgba(255,255,255,.72); backdrop-filter:blur(26px) saturate(1.5); border:1px solid rgba(255,255,255,.8); border-radius:30px; padding:clamp(24px,3.6vw,34px); box-shadow:0 40px 90px -36px rgba(15,40,90,.5);">'
      + '<div style="font-family:\'Sora\',sans-serif; font-weight:700; font-size:19px; color:#0c2545; text-align:center;">Quem é você?</div>'
      + '<div style="font-size:13px; color:#566681; text-align:center; margin:6px 0 18px;">Diga seu nome e o que vai fazer no PC — obrigatório pra usar.</div>'
      + '<label style="display:block; font-size:12px; font-weight:700; color:#42566f;">Seu nome<input data-input="oname" value="' + esc(S.other.name) + '" placeholder="Ex: João da manutenção" style="' + inp + '"></label>'
      + '<label style="display:block; font-size:12px; font-weight:700; color:#42566f; margin-top:14px;">O que vai fazer?<input data-input="owhat" value="' + esc(S.other.what) + '" placeholder="Ex: imprimir um documento" style="' + inp + '"></label>'
      + '<div style="min-height:20px; color:#c0352b; font-weight:700; font-size:13px; margin-top:10px; text-align:center;">' + esc(S.pinError) + '</div>'
      + '<div style="display:flex; gap:10px; margin-top:8px;">'
      + '<button data-act="otherCancel" style="flex:1; padding:14px; border-radius:14px; border:1px solid rgba(15,40,90,.14); background:rgba(255,255,255,.6); color:#42566f; font-weight:700; font-size:15px; cursor:pointer;">Voltar</button>'
      + '<button data-act="otherGo" style="flex:2; padding:14px; border-radius:14px; border:0; background:linear-gradient(135deg,#2f7ae0,#0f4c92); color:#fff; font-weight:800; font-size:15px; cursor:pointer;">' + (S.busy ? '…' : 'Entrar') + '</button>'
      + '</div></div>';
  }

  // ── FILA DE IMPRESSÃO DO CELULAR ──────────────────────────────────────────
  // O admin pede a etiqueta do iPhone; o papel sai NESTE PC. A máquina de
  // estados mora em /shared/print-queue-card.js (a mesma da Central e do hub de
  // estoque); aqui só ligamos os fios da estação.
  var queue = null;
  function PQ() { return window.HF_PRINT_QUEUE || null; }
  function startQueue() {
    var M = PQ();
    if (!M || queue) return;
    queue = M.create({
      api: api2,
      by: function () { return S.person ? S.person.display_name : (S.other.name || 'Estação'); },
      onChange: render,
      toast: function (m) { S.queueMsg = String(m || ''); render(); setTimeout(function () { S.queueMsg = ''; render(); }, 4000); },
      openWindow: function () { return window.open('', '_blank', 'width=520,height=760'); },
    });
    queue.start();
  }
  function stopQueue() { if (queue) { queue.stop(); queue = null; } }

  /* Cartão só aparece quando tem pedido esperando. Este PC existe pra imprimir:
     quando alguém pede do celular, o pedido tem que estar visível de longe. */
  function queueCard() {
    var M = PQ();
    if (!M || !queue || !queue.jobs.length) return '';
    var h = '<div style="width:min(94vw,460px); margin-top:14px; background:rgba(255,255,255,.82); border:1px solid rgba(255,255,255,.9); border-radius:24px; padding:18px 20px; box-shadow:0 30px 70px -34px rgba(15,40,90,.5); text-align:left;" data-card="print-queue">'
      + '<div style="font-family:\'Sora\',sans-serif; font-weight:800; font-size:15px; color:#0c2545;">Impressão pedida pelo celular</div>'
      + '<div style="font-size:12.5px; color:#566681; margin:3px 0 8px;">Toque em Imprimir e tire o papel da impressora.</div>';
    queue.jobs.forEach(function (j) {
      var n = M.jobCount(j);
      var note = M.stateNote(j);
      var can = M.isTakeable(j);
      var busy = String(queue.busy) === String(j.id);
      h += '<div style="border-top:1px dotted rgba(15,40,90,.16); padding:10px 0; display:flex; align-items:center; gap:9px; flex-wrap:wrap;" data-job="' + esc(String(j.id)) + '">'
        + '<span style="flex:1; min-width:130px; font-size:13.5px; font-weight:700; color:#0c2545;">' + esc(M.kindLabel(j.kind))
        + (n ? '<span style="font-size:11.5px; color:#6c819b; font-weight:600; margin-left:7px;">' + n + (n === 1 ? ' folha' : ' folhas') + '</span>' : '')
        + '</span>'
        + '<span style="font-size:11.5px; color:#566681;">' + esc(j.requested_by || 'admin') + ' · ' + esc(M.ageText(j.age_min)) + '</span>'
        + (can
          ? '<button data-act="printJob" data-arg="' + esc(String(j.id)) + '" ' + (busy ? 'disabled' : '')
            + ' style="border:0; cursor:pointer; border-radius:999px; min-height:46px; padding:0 22px; background:linear-gradient(135deg,#2f7ae0,#0f4c92); color:#fff; font-weight:800; font-size:14px;">'
            + (busy ? 'Imprimindo…' : esc(M.actionLabel(j))) + '</button>'
          : '<span style="font-size:12px; color:#6b4c07; font-weight:700;">imprimindo</span>')
        + (note ? '<div style="width:100%; font-size:12px; color:#6c819b;">' + esc(note) + '</div>' : '')
        + '</div>';
    });
    return h + '</div>';
  }

  /* A confirmação vive FORA do cartão: o último job impresso esvazia a fila, o
     cartão some, e sem isto o operador não veria o "Pode tirar do papel" logo
     depois de mandar imprimir. Aviso sem retorno é aviso que não existe. */
  function queueMsgCard() {
    if (!S.queueMsg) return '';
    return '<div style="width:min(94vw,460px); margin-top:14px; background:rgba(232,247,234,.92); border:1px solid #c8ecce; border-radius:20px; padding:14px 20px; text-align:center; font-size:14px; font-weight:700; color:#1e6b2e;" data-card="print-queue-msg">'
      + esc(S.queueMsg) + '</div>';
  }

  // ── tela pós-login: "está imprimindo labels" ──────────────────────────────
  function printingCard() {
    var who = S.person ? S.person.display_name : (S.other.name || 'Convidado');
    var sub = S.person ? 'Impressão de Labels' : esc(S.other.what || 'usando o computador');
    return '<div style="display:flex; flex-direction:column; align-items:center;">'
      + '<div style="width:min(94vw,460px); background:rgba(255,255,255,.72); backdrop-filter:blur(26px) saturate(1.5); border:1px solid rgba(255,255,255,.85); border-radius:30px; padding:clamp(28px,4vw,40px); box-shadow:0 40px 90px -36px rgba(15,40,90,.5); text-align:center;">'
      + '<div style="font-size:44px; margin-bottom:8px;">🖨️</div>'
      + '<div style="font-family:\'Sora\',sans-serif; font-weight:800; font-size:22px; color:#0c2545;">' + esc(who) + '</div>'
      + '<div style="font-size:15px; color:#1f5fd0; font-weight:700; margin-top:4px;">' + sub + '</div>'
      + '<div style="font-size:13px; color:#566681; margin-top:14px;">O computador está liberado. Pode imprimir seus labels.<br>A tela volta a pedir o PIN em 10 minutos.</div>'
      + '<button data-act="lockNow" style="margin-top:22px; padding:13px 26px; border-radius:14px; border:1px solid rgba(15,40,90,.14); background:rgba(255,255,255,.6); color:#42566f; font-weight:700; font-size:14px; cursor:pointer;">Sair / trancar agora</button>'
      + '</div>'
      + queueCard()
      + queueMsgCard()
      + '</div>';
  }

  function render() {
    center.innerHTML = S.screen === 'other' ? otherCard() : S.screen === 'printing' ? printingCard() : loginCard();
    var f = center.querySelector('[data-input="oname"]'); if (f && S.screen === 'other') f.focus();
  }

  // ── ações ─────────────────────────────────────────────────────────────────
  // SINAL pro app de trava do .28: quando desbloqueado, o title vira
  // "HF-PRINT-UNLOCKED" e a hash vira #unlocked; trancado → #locked. O app de
  // kiosk local (que cobre o Windows) observa isso pra liberar/retrancar a tela.
  function signal(unlocked) {
    document.title = unlocked ? 'HF-PRINT-UNLOCKED' : 'HealthFare — Estação de Impressão';
    try { location.hash = unlocked ? 'unlocked' : 'locked'; } catch (e) {}
    window.HF_PRINT_UNLOCKED = !!unlocked;
    window.HF_PRINT_WHO = unlocked ? (S.person ? S.person.display_name : (S.other.name || 'Convidado')) : '';
  }
  function armLock() { if (lockTimer) clearTimeout(lockTimer); lockTimer = setTimeout(lock, LOCK_MS); }
  function lock() { S.screen = 'login'; S.pin = ''; S.pinError = ''; S.session = null; S.person = null; S.other = { name: '', what: '' }; S.queueMsg = ''; if (lockTimer) clearTimeout(lockTimer); stopQueue(); signal(false); render(); }

  async function api(path, body, headers) {
    // Bearer pageToken (as rotas /api/v3/op/* exigem; vem do /op/config.js). Igual /op.
    var PT = (window.HF_OP_CONFIG && window.HF_OP_CONFIG.pageToken) || '';
    var base = { 'Content-Type': 'application/json' };
    if (PT) base.Authorization = 'Bearer ' + PT;
    var r = await fetch(path, { method: 'POST', headers: Object.assign(base, headers || {}), body: JSON.stringify(body || {}) });
    var j = null; try { j = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, j: j || {} };
  }

  /* api2: a MESMA credencial do api() acima (Bearer da página + a sessão do PIN),
     no formato que /shared/print-queue-card.js espera (GET/POST, promessa que
     rejeita no erro). O api() antigo é só POST e devolve {ok,status,j}: mudá-lo
     quebraria o login, então a fila ganha este irmão em vez de uma exceção. */
  function api2(path, opts) {
    var o = opts || {};
    var PT = (window.HF_OP_CONFIG && window.HF_OP_CONFIG.pageToken) || '';
    var headers = { 'Content-Type': 'application/json' };
    if (PT) headers.Authorization = 'Bearer ' + PT;
    if (S.session) headers['X-Session-Token'] = S.session;
    return fetch(path, {
      method: o.method || 'GET',
      headers: headers,
      body: o.body ? JSON.stringify(o.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = new Error((j && (j.detail || (j.error && (j.error.message || j.error)))) || ('HTTP ' + r.status));
          e.body = j; e.status = r.status;
          throw e;
        }
        return j;
      });
    });
  }

  async function submitPin() {
    if (S.busy) return; S.busy = true;
    var login = await api('/api/v3/op/auth/login', { pin: S.pin });
    if (!login.ok || !login.j.session_token) {
      S.busy = false; S.pin = ''; S.pinError = login.status === 429 ? 'Muitas tentativas — aguarde' : 'PIN incorreto'; S.shake = true; render();
      setTimeout(function () { S.shake = false; render(); }, 420); return;
    }
    S.session = login.j.session_token; S.person = login.j.person;
    // abre a task "Impressão de Labels" (nunca bloqueia o acesso se falhar)
    try { await api('/api/v3/op/event/start', { activity_slug: 'label_printing' }, { 'X-Session-Token': S.session }); } catch (e) {}
    S.busy = false; S.pinError = ''; S.screen = 'printing'; signal(true); armLock(); startQueue(); render();
  }

  async function otherGo() {
    if (S.busy) return;
    if (!S.other.name.trim() || !S.other.what.trim()) { S.pinError = 'Preencha nome e o que vai fazer'; render(); return; }
    S.busy = true; render();
    try { await api('/api/v3/print/other', { name: S.other.name.trim(), what: S.other.what.trim() }); } catch (e) {}
    S.busy = false; S.pinError = ''; S.screen = 'printing'; signal(true); armLock(); startQueue(); render();
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'pinkey') {
      var k = b.getAttribute('data-arg');
      if (k === '⌫') { S.pin = S.pin.slice(0, -1); S.pinError = ''; render(); }
      else if (k === '✓') { if (S.pin.length === 4) submitPin(); }
      else if (/\d/.test(k) && S.pin.length < 4) { S.pin += k; S.pinError = ''; render(); if (S.pin.length === 4) submitPin(); }
    } else if (act === 'other') { S.screen = 'other'; S.pinError = ''; render(); }
    else if (act === 'otherCancel') { S.screen = 'login'; S.pin = ''; S.pinError = ''; render(); }
    else if (act === 'otherGo') { otherGo(); }
    else if (act === 'lockNow') { lock(); }
    // fila do celular: pega o job, imprime e marca como feito
    else if (act === 'printJob') { if (queue) { armLock(); queue.take(b.getAttribute('data-arg')); } }
  });
  document.addEventListener('input', function (e) {
    var el = e.target.closest('[data-input]'); if (!el) return;
    var k = el.getAttribute('data-input');
    if (k === 'oname') S.other.name = el.value; else if (k === 'owhat') S.other.what = el.value;
  });
  // teclado físico (o PC tem teclado): dígitos → PIN, Enter → confirma, Backspace → apaga
  document.addEventListener('keydown', function (e) {
    if (S.screen !== 'login') return;
    if (/^\d$/.test(e.key) && S.pin.length < 4) { S.pin += e.key; S.pinError = ''; render(); if (S.pin.length === 4) submitPin(); }
    else if (e.key === 'Backspace') { S.pin = S.pin.slice(0, -1); S.pinError = ''; render(); }
    else if (e.key === 'Enter' && S.pin.length === 4) submitPin();
  });

  render();
})();
