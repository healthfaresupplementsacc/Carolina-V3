'use strict';
/* Redesign /op v4 — guard de integridade do source (testEnvironment=node, sem jsdom;
   app.v4.js é browser-only). Garante: todos os screens/handlers/endpoints existem,
   retroactive vive no CONFIRM, e NENHUM endpoint inventado (R6). Behavioral real
   fica pro smoke em prod (SHELL_QUEUE). */
const fs = require('fs');
const path = require('path');
const APP = fs.readFileSync(path.join(__dirname, '..', 'op', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'op', 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(__dirname, '..', 'op', 'sw.js'), 'utf8');

// endpoints que o backend op.js realmente expõe (fonte da verdade)
const REAL = [
  '/api/v3/op/auth/login', '/api/v3/op/auth/logout', '/api/v3/op/auth/heartbeat',
  '/api/v3/op/event/start', '/api/v3/op/event/retroactive', '/api/v3/op/event/', // :id/end, :id/join
  '/api/v3/op/note', '/api/v3/op/voice/upload', '/api/v3/op/active-operators',
  '/api/v3/op/missing-bottle-counts', '/api/v3/op/clock-out', '/api/v3/op/forgotten-checkout/resolve',
  '/api/v3/architect/person/',
];

describe('op v4 — screens e handlers', () => {
  test('login: keypad + dots + submitPin', () => {
    expect(APP).toContain('function loginInner');
    expect(APP).toContain("data-act=\"pinkey\"");
    expect(APP).toContain('function submitPin');
  });
  test('home: hero/ring/CTA/mine/team/note', () => {
    expect(APP).toContain('function homeInner');
    expect(APP).toContain('Iniciar Tarefa');
    expect(APP).toContain('stroke-dasharray'); // ring
    expect(APP).toContain('Minhas tarefas');
    expect(APP).toContain('Equipe agora');
  });
  test('flow: group→type→supp→batch→confirm→finished', () => {
    ['flowGroup', 'flowType', 'flowSupp', 'flowBatch', 'flowConfirm', 'flowFinished'].forEach((fn) => expect(APP).toContain('function ' + fn));
  });
  test('confirm tem "Quando começou?" (Agora/Esqueci) — retroactive no lugar certo', () => {
    const conf = APP.slice(APP.indexOf('function flowConfirm'), APP.indexOf('function flowFinished'));
    expect(conf).toContain('Quando começou?');
    expect(conf).toContain('modeNow');
    expect(conf).toContain('modeForgot');
  });
  test('overlays: finish/join/note/clock/forgotten', () => {
    ['finish', 'join', 'note', 'clock', 'forgotten'].forEach((t) => expect(APP).toContain("o.type === '" + t + "'"));
  });
  test('settings: mantras/lang/phase/density/aging', () => {
    expect(APP).toContain('function settingsInner');
    ['toggleMantras', 'setLang', 'setPhase', 'setDens', 'toggleAging', 'agingStep'].forEach((a) => expect(APP).toContain(a + ':'));
  });
  test('ACT handlers principais definidos', () => {
    ['pinkey', 'startFlow', 'pickGroup', 'pickType', 'pickSupp', 'confirmStart', 'commitRetro', 'doFinish', 'doJoin', 'saveNote', 'doClockOut', 'forgottenYes', 'forgottenNo', 'voice'].forEach((a) => expect(APP).toContain(a + ':'));
  });
});

describe('op v4 — wiring de API (sem inventar endpoint)', () => {
  test('usa /event/start E /event/retroactive conforme started_at', () => {
    expect(APP).toContain("'/api/v3/op/event/retroactive'");
    expect(APP).toContain("'/api/v3/op/event/start'");
    expect(APP).toContain('startedAt ? '); // ternário escolhe o path
  });
  test('todo /api/v3/op/ usado é endpoint REAL', () => {
    const used = APP.match(/\/api\/v3\/(op|architect)\/[a-z0-9/_:+.${}'"\- ]*/gi) || [];
    used.forEach((u) => {
      // normaliza: corta em template/interpolação/aspas
      const base = u.replace(/['"`].*$/, '').replace(/\$\{.*$/, '').replace(/' \+.*$/, '');
      const ok = REAL.some((r) => base.indexOf(r) === 0 || r.indexOf(base) === 0 || base.indexOf(r) >= 0);
      expect(ok).toBe(true);
    });
  });
  test('voice é Web Speech → nota (sem upload no v4; documentado)', () => {
    expect(APP).toContain('SpeechRecognition');
    // v4 não chama /voice/upload (escopo: transcript-to-note); ver SHELL_QUEUE
    expect(APP).not.toContain('/voice/upload');
  });
});

describe('op v4 — html + sw', () => {
  test('index.v4 carrega fontes + hf-design + app.v4 + theme azul', () => {
    expect(HTML).toContain('Manrope');
    expect(HTML).toContain('/shared/hf-design.css');
    expect(HTML).toContain('/op/app.js');
    expect(HTML).toContain('#0f4c92');
  });
  test('sw é hf-op-v12 network-first', () => {
    expect(SW).toContain("'hf-op-v12'");
    expect(SW).toContain('NETWORK-FIRST');
  });
});

describe('op — fit-to-viewport (canvas fixo 1440x900 escalado)', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'op', 'style.css'), 'utf8');
  test('estrutura palco/canvas + aviso de girar no HTML', () => {
    expect(HTML).toContain('id="hf-stage"');
    expect(HTML).toContain('id="hf-canvas"');
    expect(HTML).toContain('id="hf-rotate-prompt"');
    expect(HTML).toContain('Gire o dispositivo');
  });
  test('CSS: canvas fixo 1440x900 + transform-origin + ambiente full-viewport no stage', () => {
    expect(CSS).toContain('#hf-canvas');
    expect(CSS).toContain('width: 1440px');
    expect(CSS).toContain('height: 900px');
    expect(CSS).toContain('transform-origin');
    expect(CSS).toContain('#hf-stage');
    expect(CSS).toContain('#hf-ambient'); // ambiente cobre a viewport (fora do canvas)
  });
  test('JS: fitCanvas com escala min(vw/1440,vh/900) cap [0.35,1.25] + listeners', () => {
    expect(APP).toContain('function fitCanvas');
    expect(APP).toContain('DESIGN_W = 1440');
    expect(APP).toContain('DESIGN_H = 900');
    expect(APP).toContain('SCALE_MAX = 1.25');
    expect(APP).toContain('SCALE_MIN = 0.35');
    expect(APP).toContain("ROOT.style.transform = 'scale(");
    expect(APP).toContain("addEventListener('resize'");
    expect(APP).toContain("addEventListener('orientationchange'");
    expect(APP).toContain("getElementById('hf-canvas')"); // ROOT é o canvas
  });
  test('conteúdo do canvas sem dvh (quebraria o fixo); vmax só no ambiente full-viewport', () => {
    expect(APP).not.toContain('dvh'); // telas/modais em px fixos (canvas 1440x900)
    // vmax agora é VÁLIDO: os blobs do ambiente vivem no #hf-stage (viewport), não no canvas
  });
});

describe('op — patch 3 bugs (rotate touch / ambiente full-viewport / admin resolve)', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'op', 'style.css'), 'utf8');
  const ADM = fs.readFileSync(path.join(__dirname, '..', 'admin', 'app.js'), 'utf8');
  test('BUG1: aviso de girar só em TOUCH + portrait pequeno (não em PC estreito)', () => {
    expect(APP).toContain('function isTouchDevice');
    expect(APP).toContain('function shouldShowRotate');
    expect(APP).toContain('function updateRotateState');
    expect(APP).toContain("matchMedia('(pointer: coarse)')"); // sinal confiável (não maxTouchPoints)
    expect(CSS).not.toContain('@media (orientation: portrait)'); // não decide mais por CSS/tamanho
  });
  test('BUG2: ambiente no #hf-stage full-viewport (z0) + canvas transparente (z1)', () => {
    expect(HTML).toContain('id="hf-ambient"');
    // #hf-ambient vem ANTES de #hf-canvas dentro do #hf-stage (cobre a viewport atrás)
    expect(HTML.indexOf('id="hf-ambient"')).toBeLessThan(HTML.indexOf('id="hf-canvas"'));
    expect(CSS).toContain('background: transparent'); // canvas transparente → ambiente aparece
    expect(APP).toContain('#hf-ambient vive no #hf-stage'); // bootShell não recria o ambiente no canvas
    expect(APP).toContain('var RS = document.documentElement.style'); // vars no <html> p/ herdar
  });
  test('BUG3: admin badge de exceções + resolve com nota + endpoint de contagem', () => {
    const adminRoutes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
    expect(adminRoutes).toContain('/api/adminpanel/metrics/exceptions-count');
    expect(adminRoutes).toContain('admin_note'); // nota do admin
    expect(ADM).toContain('exc-badge');
    expect(ADM).toContain('refreshExcBadge');
    expect(ADM).toContain('➕ Adicionar contagem');            // form inline (não window.prompt)
    expect(ADM).toContain('bottles_count: n, admin_note:');     // inline form posta contagem + nota
  });
});

describe('op v4 — 3 bugfixes críticos', () => {
  test('anti-flicker: shell persistente + tick cirúrgico (sem render() no relógio)', () => {
    expect(APP).toContain('function bootShell');
    expect(APP).toContain('function mountLayer');      // camadas persistentes
    expect(APP).toContain("classList.add('on')");      // cross-fade via classe .on
    // o tick de 1s NÃO chama render() — atualiza só textos por id
    const tick = APP.slice(APP.indexOf('tClock = setInterval'), APP.indexOf('tBeat = setInterval'));
    expect(tick).toContain("getElementById('hf-clock')");
    expect(tick).toContain("getElementById('hf-logoff')");
    expect(tick).not.toContain('render()');
  });
  test('ambiente fiel: 4 blobs + bottles reais + cápsulas de gel (uma vez no ambient)', () => {
    expect(APP).toContain('function buildAmbient');
    expect(APP).toContain('function ambientBottles');   // bottles reais à deriva (drop-shadow)
    expect(APP).toContain('function capsules');           // cápsulas de gel realistas (pó/sheen/seam)
    expect(APP).toContain('/op/assets/bottles/');
    expect(APP).toContain('hfHue');                       // ciclo de cor do pó (do design)
    expect(APP).toContain('radial-gradient(circle');      // blobs de marca
  });
  test('RBAC: gear/settings gated por adminUI (operador comum não vê)', () => {
    expect(APP).toContain('function adminUI');
    expect(APP).toContain("['admin', 'owner', 'manager'].indexOf");
    expect(APP).toContain("adminUI() ? iconBtn('toggleSettings'"); // gear condicional
    expect(APP).toContain('S.settingsOpen && adminUI()');           // dropdown gated
  });
});

describe('op — patch UX (3 bugs)', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'op', 'style.css'), 'utf8');

  test('BUG1 cross-fade: camadas persistentes com transição de opacidade', () => {
    // todas as telas/modais vivem sempre no DOM (criadas no bootShell)
    ['scr-login', 'scr-home', 'lyr-flow', 'lyr-overlay', 'lyr-settings', 'lyr-alert'].forEach((id) => expect(APP).toContain(id));
    expect(CSS).toContain('.hf-layer');
    expect(CSS).toContain('transition: opacity 220ms');          // cross-fade 220ms
    expect(CSS).toContain('.hf-layer.on');
    // flow não re-popa por passo: casca montada uma vez, corpo trocado
    expect(APP).toContain('function mountFlow');
    expect(APP).toContain('#flow-body');
    expect(APP).toContain("querySelector('#flow-body')");
  });

  test('BUG2 voz steady: timer/transcript cirúrgicos (sem render no setInterval)', () => {
    expect(APP).toContain("getElementById('voice-timer')");      // timer via textContent
    // o setInterval da voz NÃO chama render() — só textContent
    const vi = APP.slice(APP.indexOf('function startVoice'), APP.indexOf('function stopVoice'));
    const loop = vi.slice(vi.indexOf('voiceTimer = setInterval'), vi.indexOf('if (SR)'));
    expect(loop).toContain('textContent');
    expect(loop).not.toContain('render()');
    // transcript escreve direto no textarea-alvo (sem render)
    expect(vi).toContain("querySelector('[data-input=\"note\"]')");
  });

  test('BUG3 alerta vermelho central: showAlert + 4 dismissals + reuso nas validações', () => {
    expect(APP).toContain('function showAlert');
    expect(APP).toContain('function closeAlert');
    expect(APP).toContain("data-act=\"alertOk\"");
    expect(APP).toContain('#hf-alert-ok');                       // foco no OK
    expect(APP).toContain('#b3261e');                            // vermelho forte
    // 4 caminhos de dismissal: clique (closeAlert), Enter, Esc, 3 teclas
    expect(APP).toContain("e.key === 'Enter'");
    expect(APP).toContain("e.key === 'Escape'");
    expect(APP).toContain('keyCount >= 3');
    // validações usam showAlert (não mais toast discreto)
    expect(APP).toContain("showAlert({ title: 'Motivo obrigatório'");
    expect(APP).toContain("showAlert({ title: 'Quantidade obrigatória'");
    // foco volta pro campo após dismiss
    expect(APP).toContain('flowNoteHighlight');
  });
});

describe('op — production_line finish (bottles obrigatório + exceção)', () => {
  test('overlay específico da production_line com checkbox de exceção + voz + aviso', () => {
    expect(APP).toContain('function finishProdInner');
    expect(APP).toContain("o.type === 'finish' && o.slug === 'production_line'"); // roteia overlay novo
    expect(APP).toContain('Quantas bottles foram produzidas?');
    expect(APP).toContain("data-act=\"toggleExc\"");                 // checkbox exceção
    expect(APP).toContain('Exceção: não tenho o número');
    expect(APP).toContain("data-input=\"finReason\"");                // textarea motivo
    expect(APP).toContain("voiceBtn('finishReason')");                // voz no motivo
    expect(APP).toContain('Orders &amp; Inventory');                  // aviso de envio
  });
  test('doFinish: alerta se sem contagem / sem motivo, e confirma exceção antes de POST', () => {
    expect(APP).toContain('function postFinish');
    expect(APP).toContain("showAlert({ title: 'Contagem obrigatória'");
    expect(APP).toContain("showAlert({ title: 'Confirmar exceção'");
    expect(APP).toContain('exception_no_count: true');                // body da exceção
    expect(APP).toContain('exception_reason:');
  });
});
