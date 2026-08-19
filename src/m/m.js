'use strict';
/* ═══════════════════════════════════════════════════════════════════
   HEALTHFARE — ADMIN NO CELULAR (/m/). S15.29.

   Bruno anda pelo armazém com o iPhone na mão. Esta página é o sistema
   de estoque e de impressão inteiro nesse bolso: aprovar, olhar produto,
   dar entrada, organizar, mover, ajustar, separar, cadastrar prateleira
   e caixa, ler código com a câmera e imprimir etiqueta.

   O QUE ELA NÃO FAZ, de propósito:
     - não escreve quantidade nenhuma por conta própria. TODA mudança de
       estoque sai por uma rota que já existe em /api/v3/warehouse/*, que
       por sua vez passa pelo StockService (a porta única). Esta página é
       só mais um cliente da mesma API que o dashboard usa;
     - não tem service worker. Cache velho num app de estoque é pior que
       recarregar: o número na tela precisa ser o número de agora.

   AUTENTICAÇÃO: o PIN do admin em toda chamada (header x-admin-pin), o
   mesmo do dashboard. Guardado em localStorage com validade de 12 h,
   porque sessionStorage morre quando o Safari descarta a aba e ninguém
   merece redigitar o PIN o dia inteiro.

   TEXTO: PT-BR com acento, curto, humano, sem travessão. Todo erro diz o
   que fazer AGORA. O vocabulário é o MESMO do hub do dashboard:
   Total · Prateleira · Caixa · A organizar · Reservado · Disponível ·
   Separadas · Dias de estoque · Aprovações · Locais · Etiquetas ·
   Veeqo diferente.
   ═══════════════════════════════════════════════════════════════════ */
(function () {

  // ── constantes ───────────────────────────────────────────────────
  var WH = '/api/v3/warehouse';
  var PQ = '/api/v3/print-queue';
  var PIN_KEY = 'hf_m_pin';
  var PIN_TTL = 12 * 60 * 60 * 1000;    // 12 h e o PIN sai sozinho
  var FORMATS = ['code_128', 'qr_code', 'upc_a', 'upc_e', 'ean_13', 'ean_8', 'data_matrix'];
  var DUP_MS = 1800;                     // a câmera lê a mesma etiqueta 30x/s
  var ZXING_SRC = '/m/vendor/zxing.min.js';

  var TABS = [
    { k: 'inicio', label: 'Início' },
    { k: 'aprovar', label: 'Aprovar' },
    { k: 'produtos', label: 'Produtos' },
    { k: 'locais', label: 'Locais' },
    { k: 'imprimir', label: 'Imprimir' },
  ];

  /* Os nomes dos tipos de proposta, iguais aos do dashboard. Duas telas
     chamando a mesma coisa por nomes diferentes é como se ensina alguém a
     errar. */
  var KIND_LABEL = {
    take: 'pegou do estoque', entrada: 'caixa nova', count: 'contagem',
    return_in: 'devolução', issue_release: 'voltou de Separadas', adjust: 'ajuste',
  };
  var CONF_LABEL = { high: 'confiança alta', medium: 'confiança média', low: 'confiança baixa' };
  var CONF_TONE = { high: 'ok', medium: 'warn', low: 'bad' };

  var STATUS_LABEL = {
    ok: 'ok', low: 'pouco', out: 'zerado', negative: 'negativo',
    organizar: 'a organizar', drift: 'Veeqo diferente', sem_local: 'sem local',
  };
  var STATUS_TONE = {
    ok: 'ok', low: 'warn', out: 'bad', negative: 'bad',
    organizar: 'info', drift: 'warn', sem_local: 'warn',
  };

  /* Os movimentos vêm do banco com o verbo técnico (storein, place, take).
     Na tela do Bruno eles viram as MESMAS palavras do hub e do /op: quem
     lê "storein" aprende o nome errado da própria operação. */
  var MOVE_LABEL = {
    storein: 'Entrada', entrada: 'Entrada', import: 'Importado do Veeqo',
    place: 'Organizado', move: 'Movido', adjust: 'Ajuste', take: 'Saiu',
    separate: 'Separada', issue_release: 'Voltou de Separadas',
    count: 'Contagem', restock: 'Reposição', return_in: 'Devolução',
  };
  function moveLabel(k) { return MOVE_LABEL[k] || (k ? String(k) : 'movimento'); }

  // curto de propósito: na largura do iPhone o nome longo cortava no meio
  var JOB_KIND_LABEL = {
    bin_labels: 'Prateleiras', box_label: 'Caixa', picklist: 'Picklist',
    shipping_labels: 'Etiquetas de envio',
  };
  var JOB_STATUS = {
    queued: { label: 'na fila', tone: 'neutral' },
    taken: { label: 'imprimindo', tone: 'info' },
    done: { label: 'impresso', tone: 'ok' },
    error: { label: 'deu erro', tone: 'bad' },
    cancelled: { label: 'cancelado', tone: 'neutral' },
  };

  // ── estado ───────────────────────────────────────────────────────
  var S = {
    pin: null,
    pinTyped: '',
    pinError: '',
    shake: false,
    booted: false,
    loading: false,
    tab: 'inicio',
    boot: null,           // resposta do mobile/bootstrap
    me: null,
    productSearch: '',
    locSearch: '',
    locTab: 'bins',       // bins | boxes
    sel: { bins: [], boxes: [] },   // etiquetas escolhidas
    sheet: null,          // { type, ... }
    cam: null,            // { hint, manual }
    queue: [],
    printers: [],
    ship: null,           // preview das etiquetas de envio de hoje
    detail: null,         // ficha do produto aberta
    busy: false,
    offline: false,
  };

  var els = {};
  var toastTimer = {};

  // ── utilidades ───────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
  function fmt(v) {
    if (v == null || v === '') return '0';
    var n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('pt-BR') : String(v);
  }
  function intOf(v) {
    var n = Number(String(v == null ? '' : v).replace(',', '.'));
    return Number.isInteger(n) ? n : (Number.isFinite(n) ? Math.round(n) : null);
  }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 30); } catch (e) {} }

  /** Idade em palavras. "há 3 h" diz mais que "180". */
  function ageText(min) {
    var m = num(min);
    if (m < 1) return 'agora';
    if (m < 60) return 'há ' + Math.round(m) + ' min';
    var h = m / 60;
    if (h < 24) return 'há ' + Math.round(h) + ' h';
    var d = Math.round(h / 24);
    return 'há ' + d + (d === 1 ? ' dia' : ' dias');
  }
  /** Idade vira cor: 4 h já incomoda, 24 h é problema. */
  function ageTone(min) {
    var m = num(min);
    return m >= 24 * 60 ? 'bad' : (m >= 4 * 60 ? 'warn' : 'neutral');
  }

  function icon(name, cls) {
    var P = {
      home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
      check: '<path d="m4 12 5.5 5.5L20 6.5"/>',
      box: '<path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5z"/><path d="M3 8.5 12 13l9-4.5M12 13v7"/>',
      pin: '<path d="M4 7h16M4 12h16M4 17h16"/>',
      print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 15h10v6H7z"/>',
      cam: '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.4"/>',
      chev: '<path d="m9 5 7 7-7 7"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
      refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
      exit: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 12h9m0 0-3-3m3 3-3 3"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
    };
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || '') + '</svg>';
  }

  function chip(text, tone) { return '<span class="chip ' + (tone || 'neutral') + '">' + esc(text) + '</span>'; }
  function mlabel(t) { return '<span class="mlabel">' + esc(t) + '</span>'; }

  /** Permissão de escrita: sem manage_stock a tela vira só leitura. */
  function canWrite() {
    var f = (S.me && S.me.functions) || [];
    return f.indexOf('*') >= 0 || f.indexOf('manage_stock') >= 0;
  }

  // ── PIN ──────────────────────────────────────────────────────────
  function loadPin() {
    try {
      var raw = localStorage.getItem(PIN_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.pin || !o.exp || Date.now() > o.exp) { localStorage.removeItem(PIN_KEY); return null; }
      return String(o.pin);
    } catch (e) { return null; }
  }
  function savePin(pin) {
    try { localStorage.setItem(PIN_KEY, JSON.stringify({ pin: String(pin), exp: Date.now() + PIN_TTL })); } catch (e) {}
  }
  function clearPin() {
    S.pin = null; S.me = null; S.boot = null; S.pinTyped = '';
    try { localStorage.removeItem(PIN_KEY); } catch (e) {}
  }

  // ── rede ─────────────────────────────────────────────────────────
  /**
   * Toda chamada da página. Um lugar só pra: mandar o PIN, ler o
   * envelope {data}/{error}, e traduzir falha em frase que o Bruno
   * consegue agir. Um 401 devolve pro PIN na hora.
   */
  /* A credencial da tela em UM lugar só. api() e apiBlob() chamam esta função:
     não existe caminho pro servidor sem o PIN do admin. */
  function pinHeaders() { return { 'x-admin-pin': S.pin || '' }; }

  function api(pathname, opts) {
    var o = opts || {};
    var headers = pinHeaders();
    var init = { method: o.method || 'GET', headers: headers };
    if (o.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(o.body);
    }
    return fetch(pathname, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        S.offline = false;
        if (r.status === 401) {
          clearPin();
          S.pinError = 'PIN inválido';
          render();
          var e401 = new Error('PIN inválido'); e401.code = 'unauthorized'; throw e401;
        }
        if (!r.ok) {
          var msg = (j && j.error && j.error.message) || (j && j.error && j.error.code) || '';
          if (r.status >= 500 || !msg) msg = 'Nada foi perdido. Tente de novo.';
          var e = new Error(msg);
          e.code = (j && j.error && j.error.code) || String(r.status);
          e.status = r.status;
          throw e;
        }
        return (j && j.data !== undefined) ? j.data : j;
      });
    }).catch(function (e) {
      if (e && (e.code === 'unauthorized' || e.status)) throw e;
      // fetch estourou: é rede, não é o servidor dizendo não
      S.offline = true;
      var off = new Error('Sem internet aqui. Tente de novo quando o sinal voltar.');
      off.code = 'offline';
      throw off;
    });
  }

  /**
   * Um arquivo (PDF das etiquetas de envio) em vez de JSON. MESMA credencial
   * do api() acima, montada pela MESMA função: nenhum caminho desta tela fala
   * com o servidor sem o PIN. Devolve o blob pra virar URL local, porque uma
   * aba nova não manda header nenhum.
   */
  function apiBlob(pathname) {
    return fetch(pathname, { headers: pinHeaders() }).then(function (r) {
      if (r.status === 401) {
        clearPin(); S.pinError = 'PIN inválido'; render();
        var e401 = new Error('PIN inválido'); e401.code = 'unauthorized'; throw e401;
      }
      if (!r.ok) { var e = new Error('Não deu pra baixar o arquivo. Tente de novo.'); e.status = r.status; throw e; }
      return r.blob();
    });
  }

  // ── toast ────────────────────────────────────────────────────────
  var toastSeq = 0;
  function toast(text, tone) {
    var host = document.getElementById('toast');
    if (!host) return;
    var id = 'tst' + (++toastSeq);
    var d = document.createElement('div');
    d.className = 'toast ' + (tone || '');
    d.id = id;
    d.textContent = text;
    host.appendChild(d);
    buzz(tone === 'bad' ? [40, 60, 40] : 26);
    toastTimer[id] = setTimeout(function () {
      var n = document.getElementById(id);
      if (n && n.parentNode) n.parentNode.removeChild(n);
      delete toastTimer[id];
    }, tone === 'bad' ? 5200 : 3400);
  }
  function fail(e) { toast((e && e.message) || 'Nada foi perdido. Tente de novo.', 'bad'); }

  // ══════════════════════════════════════════════════════════════════
  // DADOS
  // ══════════════════════════════════════════════════════════════════

  /** Uma chamada abre o app inteiro. full=1 traz todos os produtos. */
  function loadBoot(full) {
    S.loading = true;
    return api(WH + '/mobile/bootstrap' + (full === false ? '' : '?full=1')).then(function (d) {
      S.boot = d || {};
      S.me = d && d.me ? d.me : S.me;
      S.loading = false;
      S.booted = true;
      render();
      return d;
    }).catch(function (e) {
      S.loading = false;
      render();
      if (e.code !== 'unauthorized') fail(e);
      throw e;
    });
  }

  function products() { return (S.boot && S.boot.products) || []; }
  function requests() { return (S.boot && S.boot.requests) || []; }
  function bins() { return (S.boot && S.boot.locations && S.boot.locations.bins) || []; }
  function boxes() { return (S.boot && S.boot.locations && S.boot.locations.boxes) || []; }
  function kpis() { return (S.boot && S.boot.kpis) || {}; }
  function productById(id) {
    var list = products();
    for (var i = 0; i < list.length; i++) if (num(list[i].product_id) === num(id)) return list[i];
    return null;
  }
  function binById(id) {
    var l = bins();
    for (var i = 0; i < l.length; i++) if (num(l[i].id) === num(id)) return l[i];
    return null;
  }
  function boxById(id) {
    var l = boxes();
    for (var i = 0; i < l.length; i++) if (num(l[i].id) === num(id)) return l[i];
    return null;
  }

  // ══════════════════════════════════════════════════════════════════
  // TELA: PIN
  // ══════════════════════════════════════════════════════════════════
  function pinHtml() {
    var dots = '';
    for (var i = 0; i < 6; i++) {
      if (i < 4 || S.pinTyped.length > i) dots += '<i class="' + (S.pinTyped.length > i ? 'on' : '') + '"></i>';
    }
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
    var kp = '';
    keys.forEach(function (k) {
      var cls = k === 'ok' ? 'ok' : (k === 'del' ? 'del' : '');
      var label = k === 'ok' ? '&#10003;' : (k === 'del' ? '&#9003;' : k);
      var aria = k === 'ok' ? 'Entrar' : (k === 'del' ? 'Apagar' : k);
      kp += '<button class="' + cls + '" data-act="pinkey" data-arg="' + k + '" aria-label="' + aria + '">' + label + '</button>';
    });
    return '<div class="pin-wrap"><div class="pin-card' + (S.shake ? ' shake' : '') + '">'
      + '<div class="eyebrow">HealthFare</div>'
      + '<div class="h1">Admin de <em>bolso</em></div>'
      + '<div class="sub">Estoque e impressão do armazém, daqui.</div>'
      + '<div class="pin-dots">' + dots + '</div>'
      + '<div class="pin-err">' + esc(S.pinError) + '</div>'
      + '<div class="keypad">' + kp + '</div>'
      + '<div class="sub" style="margin-top:18px; font-size:12.5px;">Digite o seu PIN de admin. Ele vale por 12 horas neste celular.</div>'
      + '</div></div>';
  }

  function pinKey(k) {
    if (k === 'del') { S.pinTyped = S.pinTyped.slice(0, -1); S.pinError = ''; render(); return; }
    if (k === 'ok') { submitPin(); return; }
    if (S.pinTyped.length >= 10) return;
    S.pinTyped += k;
    S.pinError = '';
    render();
    // 4 dígitos é o formato de sempre: entra sozinho, sem pedir confirmação
    if (S.pinTyped.length === 4) setTimeout(submitPin, 120);
  }

  function submitPin() {
    if (!S.pinTyped) return;
    S.pin = S.pinTyped;
    S.pinError = '';
    loadBoot(true).then(function () {
      savePin(S.pin);
      S.pinTyped = '';
      buzz(30);
    }).catch(function (e) {
      S.pin = null;
      S.pinTyped = '';
      if (e.code === 'unauthorized') { S.pinError = 'PIN inválido'; }
      else if (e.code === 'offline') { S.pinError = 'Sem internet aqui'; }
      else { S.pinError = (e && e.message) || 'Não deu pra entrar'; }
      S.shake = true;
      render();
      setTimeout(function () { S.shake = false; render(); }, 450);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // CASCA
  // ══════════════════════════════════════════════════════════════════
  function topbarHtml() {
    var who = (S.me && S.me.name) || '';
    return '<div class="topbar">'
      + '<span class="brand-dot"></span>'
      + '<span class="brand">HealthFare · Admin</span>'
      + '<span class="who">'
      + (who ? '<span class="name">' + esc(who) + '</span>' : '')
      + '<button class="icon-btn" data-act="refresh" aria-label="Atualizar">' + icon('refresh') + '</button>'
      + '<button class="icon-btn" data-act="logout" aria-label="Sair">' + icon('exit') + '</button>'
      + '</span></div>';
  }

  function tabbarHtml() {
    var pend = num((S.boot && S.boot.pending_summary && S.boot.pending_summary.count) || 0);
    var ic = { inicio: 'home', aprovar: 'check', produtos: 'box', locais: 'pin', imprimir: 'print' };
    var h = '<div class="tabbar">';
    TABS.forEach(function (t) {
      var badge = (t.k === 'aprovar' && pend > 0)
        ? '<span class="badge">' + (pend > 99 ? '99+' : pend) + '</span>' : '';
      h += '<button class="tab' + (S.tab === t.k ? ' on' : '') + '" data-act="tab" data-arg="' + t.k + '"'
        + (S.tab === t.k ? ' aria-current="page"' : '') + '>'
        + icon(ic[t.k]) + badge + '<span>' + esc(t.label) + '</span></button>';
    });
    return h + '</div>';
  }

  function shellHtml(inner) {
    return topbarHtml()
      + '<div class="shell">' + (S.offline ? '<div class="page" style="padding-bottom:0"><div class="offline">Sem internet aqui. O que está na tela é do último carregamento.</div></div>' : '') + inner + '</div>'
      + '<button class="fab" data-act="scan" aria-label="Ler código com a câmera">' + icon('cam') + '</button>'
      + tabbarHtml();
  }

  function pageHead(eyebrow, title, italic, sub) {
    return '<div class="page-head">'
      + '<div class="eyebrow">' + esc(eyebrow) + '</div>'
      + '<div class="h1">' + esc(title) + ' <em>' + esc(italic) + '</em></div>'
      + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '')
      + '</div>';
  }

  function empty(big, t, s) {
    return '<div class="empty"><div class="big">' + big + '</div>'
      + '<div class="t">' + esc(t) + '</div><div class="s">' + esc(s) + '</div></div>';
  }

  // ══════════════════════════════════════════════════════════════════
  // ABA: INÍCIO
  // ══════════════════════════════════════════════════════════════════
  function inicioHtml() {
    var k = kpis();
    var pend = num((S.boot && S.boot.pending_summary && S.boot.pending_summary.count) || 0);
    var att = (S.boot && S.boot.attention) || [];
    var drift = num(k.drift_products);

    var h = '<div class="page">';
    h += pageHead('Hoje no armazém', 'Estoque em', 'ordem',
      'O que precisa de você agora fica em cima.');

    h += '<div class="kpis">'
      + kpiTile('Total', fmt(k.total_bottles), '')
      + kpiTile('Disponível', fmt(k.available), num(k.available) <= 0 ? 'bad' : 'ok')
      + kpiTile('A organizar', fmt(k.unplaced), num(k.unplaced) > 0 ? 'warn' : '')
      + kpiTile('Aprovações', fmt(pend), pend > 0 ? 'warn' : '')
      + '</div>';

    if (drift > 0) {
      h += '<button class="card card-row" data-act="tab" data-arg="produtos" style="width:100%; text-align:left;">'
        + chip('Veeqo diferente', 'warn')
        + '<span class="grow" style="flex:1; font-size:13.5px;">' + drift
        + (drift === 1 ? ' produto com número diferente do Veeqo' : ' produtos com número diferente do Veeqo') + '</span>'
        + icon('chev', 'chev') + '</button>';
    }

    h += '<div class="sect">' + mlabel('Precisa de atenção') + '<span class="rule"></span></div>';
    if (!att.length) {
      h += '<div class="card">' + empty('&#10003;', 'Nada pendente agora',
        'Quando faltar garrafa, sobrar coisa a organizar ou o Veeqo discordar, aparece aqui.') + '</div>';
    } else {
      h += '<div class="list">';
      att.forEach(function (a, i) {
        var act = (a.action && a.action.type) || 'ver';
        var lbl = { repor: 'Repor', aprovar: 'Aprovar', organizar: 'Organizar', entrada: 'Entrada', ver: 'Ver' }[act] || 'Ver';
        h += '<div class="item">'
          + '<span class="grow">'
          + '<span class="t">' + esc(a.product || '') + '</span>'
          + '<span class="s">' + esc(oneLine(a)) + '</span>'
          + '</span>'
          + '<button class="btn sm" data-act="attn" data-arg="' + i + '">' + esc(lbl) + '</button>'
          + '</div>';
      });
      h += '</div>';
    }

    h += '<div style="text-align:center; padding:6px 0 4px;">'
      + '<button class="btn sm" data-act="refresh">Atualizar</button></div>';
    h += generatedAt();
    return h + '</div>';
  }

  /** O texto do backend já vem "Produto · motivo". Na tela o nome fica no
      título, então a linha de baixo mostra só o motivo. */
  function oneLine(a) {
    var t = String(a.text || '');
    var p = String(a.product || '');
    if (p && t.indexOf(p + ' · ') === 0) return t.slice(p.length + 3);
    return t;
  }

  function kpiTile(label, value, tone) {
    return '<div class="kpi">' + mlabel(label)
      + '<div class="v ' + (tone || '') + '">' + esc(value) + '</div></div>';
  }

  function generatedAt() {
    var at = S.boot && S.boot.generated_at;
    if (!at) return '';
    var d = new Date(at);
    if (isNaN(d.getTime())) return '';
    return '<div class="sub" style="text-align:center; font-size:11.5px; padding:4px 0 10px;">Números de '
      + esc(d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })) + '</div>';
  }

  /** Botão da lista de atenção: leva pra tela que resolve. */
  function onAttention(idx) {
    var a = ((S.boot && S.boot.attention) || [])[num(idx)];
    if (!a) return;
    var act = (a.action && a.action.type) || 'ver';
    if (act === 'aprovar') { S.tab = 'aprovar'; render(); return; }
    if (act === 'repor' && a.action.bin_id) { openBinSheet(a.action.bin_id); return; }
    if (act === 'repor' && a.action.box_id) { openBoxSheet(a.action.box_id); return; }
    if (act === 'entrada') { openProduct(a.product_id, 'entrada'); return; }
    if (act === 'organizar') { openProduct(a.product_id, 'place'); return; }
    openProduct(a.product_id);
  }

  // ══════════════════════════════════════════════════════════════════
  // ABA: APROVAR
  // ══════════════════════════════════════════════════════════════════
  function aprovarHtml() {
    var rows = requests();
    var h = '<div class="page">';
    h += pageHead('Fila de propostas', 'Aprovar ou', 'recusar',
      'Aprovar mexe no número na hora. Recusar não mexe em nada.');

    if (!rows.length) {
      h += '<div class="card">' + empty('&#128077;', 'Fila vazia',
        'Quando alguém do armazém contar, pegar ou devolver garrafa, a proposta aparece aqui pra você decidir.') + '</div>';
      return h + '</div>';
    }

    rows.forEach(function (r) { h += requestCard(r); });
    return h + '</div>';
  }

  function requestCard(r) {
    var kind = KIND_LABEL[r.kind] || r.kind || 'proposta';
    var where = r.bin_code ? 'prateleira ' + r.bin_code : (r.box_number ? 'caixa ' + r.box_number : '');
    var tone = ageTone(r.age_min);
    var w = canWrite();

    var h = '<div class="card' + (tone === 'bad' ? ' bad' : (tone === 'warn' ? ' warn' : '')) + '" data-req="' + esc(r.id) + '">';
    // uma linha que se lê de relance: quem · o quê · quanto · onde
    h += '<div style="display:flex; align-items:baseline; gap:7px; flex-wrap:wrap; margin-bottom:5px;">'
      + '<b style="font-size:15px;">' + esc(r.proposed_by || 'alguém') + '</b>'
      + chip(kind, 'neutral')
      + '<b class="mono" style="font-size:15px;">' + esc(fmt(r.qty)) + '</b>'
      + '<span class="sub" style="font-size:13px;">' + esc(r.direction === 'out' ? 'saindo' : 'entrando') + '</span>'
      + '</div>';
    h += '<div style="font-weight:600; font-size:14.5px; margin-bottom:4px;">' + esc(r.product || 'produto') + '</div>';
    h += '<div style="display:flex; gap:7px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">'
      + (where ? chip(where, 'info') : '')
      + chip(ageText(r.age_min), tone)
      + '</div>';
    if (r.reason || r.note) {
      h += '<div class="sub" style="margin-bottom:8px;">' + esc(r.reason || '') + (r.reason && r.note ? ' · ' : '') + esc(r.note || '') + '</div>';
    }
    h += metaHtml(r);

    if (w) {
      h += '<div class="btn-row" style="margin-top:11px;">'
        + '<button class="btn ok" data-act="approve" data-arg="' + esc(r.id) + '">Aprovar</button>'
        + '<button class="btn danger" data-act="reject" data-arg="' + esc(r.id) + '">Recusar</button>'
        + '</div>';
    } else {
      h += '<div class="sub" style="margin-top:9px;">Só quem tem permissão de mexer no estoque decide isso.</div>';
    }
    return h + '</div>';
  }

  /** "ver como foi contado": a conta da pesagem fica dobrada, porque quem
      aprova pelo celular lê a linha de cima e decide. */
  function metaHtml(r) {
    var m = r.meta;
    if (!m || typeof m !== 'object') return '';
    var isWeigh = m.gross_g != null || m.unit_weight_g != null;
    var isBox = m.box === true || m.batch_number != null || m.new_box === true;
    if (!isWeigh && !isBox) return '';
    var g = function (v) { return v == null || v === '' ? null : fmt(v) + ' g'; };
    var cell = function (l, v) {
      return v == null ? '' : '<span style="display:inline-flex; gap:5px; align-items:baseline;">'
        + mlabel(l) + '<b class="mono" style="font-size:12.5px;">' + esc(v) + '</b></span>';
    };
    if (isWeigh) {
      var net = m.net_g != null ? m.net_g : (m.gross_g != null && m.tare_g != null ? num(m.gross_g) - num(m.tare_g) : null);
      return '<details style="border-top:1px dotted var(--dotline); padding-top:7px;">'
        + '<summary style="font-size:13px; color:var(--ink-dim); display:flex; gap:8px; align-items:center; min-height:32px;">'
        + '<span>ver como foi contado</span>'
        + (m.confidence ? chip(CONF_LABEL[m.confidence] || m.confidence, CONF_TONE[m.confidence] || 'neutral') : '')
        + '</summary>'
        + '<div style="display:flex; gap:12px; flex-wrap:wrap; align-items:baseline; margin-top:7px;">'
        + cell('Bruto', g(m.gross_g)) + cell('Tara', g(m.tare_g)) + cell('Líquido', g(net))
        + cell('Unidade', g(m.unit_weight_g)) + cell('Contou', m.computed_qty != null ? fmt(m.computed_qty) : null)
        + cell('Sobra', g(m.residual_g))
        + '</div></details>';
    }
    return '<div style="display:flex; gap:12px; flex-wrap:wrap; align-items:baseline; border-top:1px dotted var(--dotline); padding-top:7px;">'
      + chip('caixa nova', 'info')
      + cell('Lote', m.batch_number) + cell('Área', m.area)
      + cell('Qtd', m.qty != null ? fmt(m.qty) : fmt(r.qty))
      + (m.box_number ? cell('Caixa', m.box_number)
        : '<span class="sub" style="font-size:12px;">o número da caixa sai na aprovação</span>')
      + '</div>';
  }

  /** Decide a proposta. Some da lista na hora (otimista) e o bootstrap
      volta certo logo em seguida; se o servidor recusar, ela reaparece. */
  function decide(id, action) {
    if (!canWrite()) { toast('Este login não pode editar estoque.', 'bad'); return; }
    var note = (S.sheet && S.sheet.type === 'decide' && S.sheet.note) || null;
    var before = requests();
    S.boot.requests = before.filter(function (r) { return num(r.id) !== num(id); });
    if (S.boot.pending_summary) {
      S.boot.pending_summary.count = Math.max(0, num(S.boot.pending_summary.count) - 1);
    }
    S.sheet = null;
    render();
    api(WH + '/requests/' + encodeURIComponent(id) + '/' + action, {
      method: 'POST', body: note ? { note: note } : {},
    }).then(function () {
      toast(action === 'approve' ? 'Aprovado. O número mudou.' : 'Recusado. Nada mudou.', 'ok');
      return loadBoot(true);
    }).catch(function (e) {
      S.boot.requests = before;           // devolve o cartão pra fila
      render();
      fail(e);
    });
  }

  /** Folha com nota opcional antes de decidir. Um toque errado no bolso
      não pode aprovar sozinho: quem quer explicar, explica. */
  function openDecide(id, action) {
    var r = null;
    requests().forEach(function (x) { if (num(x.id) === num(id)) r = x; });
    if (!r) return;
    S.sheet = { type: 'decide', id: id, action: action, req: r, note: '' };
    render();
  }

  function decideSheet(sh) {
    var r = sh.req;
    var isOk = sh.action === 'approve';
    return sheetShell(isOk ? 'Aprovar' : 'Recusar', esc(r.product || '') + ' · ' + fmt(r.qty) + ' garrafas',
      '<div class="sub" style="margin-bottom:12px;">'
      + (isOk ? 'Aprovar mexe no estoque na hora, pela mesma porta de sempre.'
        : 'Recusar não mexe em nada. A proposta some da fila.')
      + '</div>'
      + '<div class="field">' + mlabel('Quer dizer o motivo? (opcional)')
      + '<input class="input" data-input="decideNote" value="' + esc(sh.note || '') + '" placeholder="Ex.: conferi na prateleira" autocomplete="off"></div>'
      + '<button class="btn ' + (isOk ? 'ok' : 'danger') + ' big block" data-act="decideGo">'
      + (isOk ? 'Aprovar agora' : 'Recusar') + '</button>');
  }

  // ══════════════════════════════════════════════════════════════════
  // ABA: PRODUTOS
  // ══════════════════════════════════════════════════════════════════
  /* Busca acha pelo SKU FILHO também. Casepack é a mesma garrafa: o C3 não
     tem linha própria aqui, então procurar "RUT-500-C3" tem que cair no pai.
     Sem isso o Bruno leria "não achei" pra um SKU que existe. */
  function matchProduct(p, q) {
    if (!q) return true;
    var hay = [p.name, p.nickname, p.base_sku]
      .concat(skuKids(p).map(function (c) { return c.sku; }))
      .filter(Boolean).join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  /* Os SKUs pendurados na garrafa. children[] é o formato novo (contrato do
     hub); `skus` é o antigo, e continua servindo pra tela não ficar muda
     enquanto o backend não trocar. */
  function skuKids(p) {
    if (Array.isArray(p.children)) return p.children;
    return (p.skus || []).filter(function (s) {
      return s.role !== 'base' && s.sku !== p.base_sku;
    });
  }

  /* O chip "RUT-500 +2": a garrafa e quantas listagens estão nela. No celular
     não se junta SKU (é tarefa de mesa), mas o número tem que aparecer, senão
     quem olha acha que um SKU sumiu do sistema. */
  function skuChip(p) {
    if (!p.base_sku) return '';
    var extra = p.sku_count != null ? Math.max(0, num(p.sku_count) - 1) : skuKids(p).length;
    return '<span class="chip solid mono" data-sku-chip="' + esc(p.product_id) + '" '
      + 'data-sku-count="' + extra + '">' + esc(p.base_sku)
      + (extra ? ' <b>+' + extra + '</b>' : '') + '</span>';
  }

  function produtosHtml() {
    var q = S.productSearch.trim().toLowerCase();
    var list = products().filter(function (p) { return matchProduct(p, q); });

    var h = '<div class="page">';
    h += pageHead('Todo o estoque', 'Buscar um', 'produto', 'Pelo nome, apelido ou SKU. Ou leia o código com a câmera.');
    h += '<div class="search">' + icon('search')
      + '<input class="input" data-input="productSearch" value="' + esc(S.productSearch) + '" '
      + 'placeholder="Nome, apelido ou SKU" autocomplete="off" autocapitalize="none" enterkeyhint="search"></div>';

    if (!products().length) {
      h += '<div class="card">' + empty('&#128230;', 'Nenhum produto ainda',
        'Cadastre os produtos no dashboard e eles aparecem aqui com os números.') + '</div>';
      return h + '</div>';
    }
    if (!list.length) {
      h += '<div class="card">' + empty('&#128269;', 'Nada com esse nome',
        'Tente parte do nome, o apelido, ou aponte a câmera pro código de barras da garrafa.') + '</div>';
      return h + '</div>';
    }

    h += '<div class="list">';
    list.forEach(function (p) {
      var st = (p.status || [])[0];
      // UMA linha por produto, com o SKU base e o "+N" dos casepacks
      h += '<button class="item" data-act="product" data-arg="' + esc(p.product_id) + '">'
        + '<span class="grow">'
        + '<span class="t">' + esc(p.nickname || p.name) + '</span>'
        + '<span class="s">Disponível ' + fmt(p.available) + ' · Total ' + fmt(p.total)
        + (p.days_of_stock != null ? ' · ' + fmt(p.days_of_stock) + ' dias' : '') + '</span>'
        + (p.base_sku ? '<span class="skus">' + skuChip(p) + '</span>' : '')
        + '</span>'
        + (st && st !== 'ok' ? chip(STATUS_LABEL[st] || st, STATUS_TONE[st] || 'neutral') : '')
        + icon('chev', 'chev') + '</button>';
    });
    h += '</div>';
    return h + '</div>';
  }

  /** Abre a ficha do produto. `then` opcional já escancara uma ação. */
  function openProduct(productId, then) {
    var p = productById(productId);
    S.sheet = { type: 'product', product_id: num(productId), product: p, detail: null, then: then || null };
    render();
    api(WH + '/product/' + encodeURIComponent(productId)).then(function (d) {
      if (!S.sheet || S.sheet.type !== 'product' || num(S.sheet.product_id) !== num(productId)) return;
      S.sheet.detail = d;
      if (d && d.product) S.sheet.product = d.product;
      render();
      if (then) openAction(then);
    }).catch(function (e) { fail(e); });
  }

  function productSheet(sh) {
    var p = sh.product || {};
    var d = sh.detail;
    var w = canWrite();
    var name = p.nickname || p.name || 'Produto';

    var body = '';
    // números: o mesmo vocabulário do hub, na mesma ordem
    body += '<div class="nums">'
      + numCell('Total', p.total) + numCell('Prateleira', p.shelf_qty)
      + numCell('Caixa', p.box_qty) + numCell('A organizar', p.unplaced_qty, num(p.unplaced_qty) > 0 ? 'warn' : '')
      + '</div>';
    body += '<div class="nums">'
      + numCell('Reservado', p.reserved) + numCell('Disponível', p.available, num(p.available) < 0 ? 'bad' : '')
      + numCell('Separadas', p.separated) + numCell('Dias', p.days_of_stock)
      + '</div>';

    var st = (p.status || []).filter(function (x) { return x !== 'ok'; });
    if (st.length || p.veeqo_match) {
      body += '<div style="display:flex; gap:7px; flex-wrap:wrap; margin-bottom:4px;">';
      st.forEach(function (x) { body += chip(STATUS_LABEL[x] || x, STATUS_TONE[x] || 'neutral'); });
      if (p.veeqo_match === 'drift' && p.veeqo) {
        body += chip('Veeqo ' + fmt(p.veeqo.physical) + ', aqui ' + fmt(p.total), 'warn');
      } else if (p.veeqo_match === 'ok') {
        body += chip('Veeqo confere', 'ok');
      }
      body += '</div>';
    }

    if (w) {
      body += '<div class="sect">' + mlabel('O que fazer') + '<span class="rule"></span></div>';
      body += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:9px;">'
        + actBtn('entrada', 'Entrada') + actBtn('place', 'Organizar')
        + actBtn('move', 'Mover') + actBtn('adjust', 'Ajustar')
        + actBtn('separate', 'Separar') + '</div>';
    }

    /* SKUs da garrafa. Juntar/desagrupar NÃO existe aqui: mexer na família é
       tarefa de mesa, com o catálogo inteiro na frente. O que o celular
       precisa é MOSTRAR, pra ninguém achar que um SKU sumiu do sistema. */
    var kids = skuKids(p);
    if (p.base_sku) {
      body += '<div class="sect">' + mlabel('SKUs desta garrafa') + '<span class="rule"></span></div>';
      body += '<div class="card flat" data-sku-list>'
        + '<div class="skus">' + skuChip(p) + '</div>';
      if (kids.length) {
        body += '<div class="list tight">';
        kids.forEach(function (c) {
          body += '<div class="item" data-sku-kid="' + esc(c.sku) + '">'
            + '<span class="grow"><span class="t mono">' + esc(c.sku) + '</span>'
            + '<span class="s">' + esc([
              num(c.units_per_pack) > 1 ? num(c.units_per_pack) + ' garrafas no pacote' : 'garrafa avulsa',
              c.veeqo_qty != null ? 'Veeqo ' + fmt(c.veeqo_qty) : '',
            ].filter(Boolean).join(' · ')) + '</span></span></div>';
        });
        body += '</div>';
        body += '<div class="sub" style="margin-top:8px;">'
          + 'É a mesma garrafa em pacotes diferentes. Juntar ou separar SKU se faz no computador.</div>';
      }
      body += '</div>';
    }

    // locais: onde essa garrafa está de verdade
    body += '<div class="sect">' + mlabel('Locais') + '<span class="rule"></span></div>';
    var locs = (p.bins || []).map(function (b) {
      return { kind: 'bin', id: b.id, code: b.bin_code, qty: b.qty, sub: [b.shelf_code, b.area].filter(Boolean).join(' · ') };
    }).concat((p.boxes || []).map(function (x) {
      return { kind: 'box', id: x.id, code: x.box_number, qty: x.qty, sub: x.area || '' };
    }));
    if (!locs.length) {
      body += '<div class="card flat"><div class="sub">Nenhuma prateleira nem caixa com este produto. Cadastre em Locais e depois use Organizar.</div></div>';
    } else {
      body += '<div class="list">';
      locs.forEach(function (l) {
        body += '<button class="item" data-act="' + (l.kind === 'bin' ? 'binSheet' : 'boxSheet') + '" data-arg="' + esc(l.id) + '">'
          + '<span class="grow"><span class="t">' + esc(l.kind === 'bin' ? 'Prateleira ' : 'Caixa ') + esc(l.code) + '</span>'
          + (l.sub ? '<span class="s">' + esc(l.sub) + '</span>' : '') + '</span>'
          + '<b class="mono">' + fmt(l.qty) + '</b>' + icon('chev', 'chev') + '</button>';
      });
      body += '</div>';
    }

    // movimentos: os 10 últimos, que é o que cabe num polegar
    body += '<div class="sect">' + mlabel('Últimos movimentos') + '<span class="rule"></span></div>';
    if (!d) {
      body += '<div class="loading">Carregando o histórico...</div>';
    } else if (!(d.movements || []).length) {
      body += '<div class="card flat"><div class="sub">Ainda não houve movimento deste produto.</div></div>';
    } else {
      body += '<div class="list">';
      d.movements.slice(0, 10).forEach(function (m) {
        var when = m.created_at ? new Date(m.created_at) : null;
        var qty = num(m.qty);
        body += '<div class="item"><span class="grow">'
          + '<span class="t">' + esc(moveLabel(m.kind)) + ' ' + (qty > 0 ? '+' : '') + fmt(qty) + '</span>'
          + '<span class="s">' + esc([m.bin_code ? 'prateleira ' + m.bin_code : (m.box_number ? 'caixa ' + m.box_number : ''),
            m.person || '', when && !isNaN(when.getTime()) ? when.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
              + ' ' + when.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''].filter(Boolean).join(' · '))
          + '</span></span></div>';
      });
      body += '</div>';
    }

    return sheetShell(name, p.base_sku
      ? 'SKU ' + p.base_sku + (kids.length ? ' e mais ' + kids.length : '')
      : '', body);
  }

  function numCell(label, v, tone) {
    return '<div class="num"><div class="v ' + (tone || '') + '">' + esc(v == null ? '0' : fmt(v)) + '</div>'
      + mlabel(label) + '</div>';
  }
  function actBtn(k, label) {
    return '<button class="btn" data-act="paction" data-arg="' + k + '">' + esc(label) + '</button>';
  }

  // ── ações do produto (folhas de 1 a 3 campos) ────────────────────
  function openAction(kind) {
    var sh = S.sheet;
    var pid = sh && (sh.product_id || (sh.product && sh.product.product_id));
    if (!pid) return;
    if (!canWrite()) { toast('Este login não pode editar estoque.', 'bad'); return; }
    S.sheet = {
      type: 'action', action: kind, product_id: num(pid),
      product: (sh && sh.product) || productById(pid),
      qty: '', dest: '', from: '', to: '', reason: '', note: '',
    };
    render();
  }

  var ACTIONS = {
    entrada: { title: 'Entrada', verb: 'Dar entrada', sub: 'Garrafa que chegou da produção. Sem destino, ela fica em A organizar.' },
    place: { title: 'Organizar', verb: 'Guardar', sub: 'Tira de A organizar e coloca numa prateleira ou caixa.' },
    move: { title: 'Mover', verb: 'Mover', sub: 'Troca de lugar. O total não muda.' },
    adjust: { title: 'Ajustar', verb: 'Ajustar', sub: 'Corrige o número. Use + ou menos e diga o motivo.' },
    separate: { title: 'Separar', verb: 'Separar', sub: 'Tira da prateleira e manda pra Separadas. Sai do total.' },
  };

  /** Opções de destino: prateleiras e caixas, com o do produto primeiro. */
  function locOptions(productId, selected, allowEmpty) {
    var pid = num(productId);
    var opts = allowEmpty ? '<option value="">A organizar (sem lugar ainda)</option>' : '<option value="">Escolha</option>';
    var bs = bins().slice().sort(function (a, b) {
      return (num(b.product_id) === pid ? 1 : 0) - (num(a.product_id) === pid ? 1 : 0);
    });
    var xs = boxes().slice().sort(function (a, b) {
      return (num(b.product_id) === pid ? 1 : 0) - (num(a.product_id) === pid ? 1 : 0);
    });
    bs.forEach(function (b) {
      var v = 'bin:' + b.id;
      opts += '<option value="' + v + '"' + (selected === v ? ' selected' : '') + '>Prateleira ' + esc(b.bin_code)
        + (b.product && num(b.product_id) !== pid ? ' (' + esc(b.product) + ')' : '') + '</option>';
    });
    xs.forEach(function (x) {
      var v = 'box:' + x.id;
      opts += '<option value="' + v + '"' + (selected === v ? ' selected' : '') + '>Caixa ' + esc(x.box_number)
        + (x.product && num(x.product_id) !== pid ? ' (' + esc(x.product) + ')' : '') + '</option>';
    });
    return opts;
  }

  /** "bin:12" → {bin_id:12}. Um lugar só pra traduzir o seletor. */
  function locBody(v) {
    var s = String(v || '');
    if (s.indexOf('bin:') === 0) return { bin_id: intOf(s.slice(4)) };
    if (s.indexOf('box:') === 0) return { box_id: intOf(s.slice(4)) };
    return {};
  }

  function actionSheet(sh) {
    var A = ACTIONS[sh.action] || {};
    var p = sh.product || {};
    var body = '<div class="sub" style="margin-bottom:13px;">' + esc(A.sub || '') + '</div>';

    if (sh.action === 'move') {
      body += '<div class="field">' + mlabel('De onde')
        + '<select class="input" data-input="from">' + locOptions(sh.product_id, sh.from, false) + '</select></div>';
      body += '<div class="field">' + mlabel('Pra onde')
        + '<select class="input" data-input="to">' + locOptions(sh.product_id, sh.to, false) + '</select></div>';
    }

    body += '<div class="field">' + mlabel(sh.action === 'adjust' ? 'Quantas garrafas (+ ou menos)' : 'Quantas garrafas')
      + '<div class="stepper">'
      + '<button data-act="qty" data-arg="-1" aria-label="Menos uma">&minus;</button>'
      + '<input class="input" data-input="qty" inputmode="numeric" pattern="[0-9-]*" value="' + esc(sh.qty) + '" placeholder="0">'
      + '<button data-act="qty" data-arg="1" aria-label="Mais uma">+</button>'
      + '</div></div>';

    if (sh.action === 'entrada' || sh.action === 'place') {
      body += '<div class="field">' + mlabel(sh.action === 'entrada' ? 'Onde guardar (opcional)' : 'Onde guardar')
        + '<select class="input" data-input="dest">' + locOptions(sh.product_id, sh.dest, sh.action === 'entrada') + '</select></div>';
    }
    if (sh.action === 'separate') {
      body += '<div class="field">' + mlabel('Sai de qual prateleira (opcional)')
        + '<select class="input" data-input="dest">' + locOptions(sh.product_id, sh.dest, true) + '</select></div>';
      body += '<div class="field">' + mlabel('Por quê')
        + '<select class="input" data-input="reason">'
        + '<option value="label"' + (sh.reason === 'label' ? ' selected' : '') + '>Rótulo errado</option>'
        + '<option value="seal"' + (sh.reason === 'seal' ? ' selected' : '') + '>Lacre com problema</option>'
        + '<option value="return"' + (sh.reason === 'return' ? ' selected' : '') + '>Devolução do cliente</option>'
        + '<option value="other"' + (sh.reason === 'other' || !sh.reason ? ' selected' : '') + '>Outro motivo</option>'
        + '</select></div>';
    }
    if (sh.action === 'adjust') {
      body += '<div class="field">' + mlabel('Motivo (obrigatório)')
        + '<input class="input" data-input="reason" value="' + esc(sh.reason) + '" placeholder="Ex.: conferi e faltavam 3" autocomplete="off"></div>';
    }

    body += '<button class="btn primary big block" data-act="actionGo"' + (S.busy ? ' disabled' : '') + '>'
      + (S.busy ? '<span class="spin"></span> Mandando...' : esc(A.verb || 'Confirmar')) + '</button>';

    return sheetShell(A.title || 'Ação', p.nickname || p.name || '', body);
  }

  /** Manda a ação pela rota que já existe. Nada de SQL, nada de atalho. */
  function submitAction() {
    var sh = S.sheet;
    if (!sh || sh.type !== 'action' || S.busy) return;
    var id = sh.product_id;
    var qty = intOf(sh.qty);
    var body = {};
    var url = '';

    if (sh.action === 'adjust') {
      if (!qty || qty === 0) { toast('Diga quantas garrafas, mais ou menos.', 'bad'); return; }
      if (!String(sh.reason || '').trim()) { toast('O motivo é obrigatório pra ajustar.', 'bad'); return; }
      url = WH + '/product/' + id + '/adjust';
      body = { qty: qty, reason: String(sh.reason).trim() };
    } else {
      if (!qty || qty <= 0) { toast('Diga quantas garrafas.', 'bad'); return; }
      if (sh.action === 'entrada') {
        url = WH + '/product/' + id + '/entrada';
        body = Object.assign({ qty: qty }, locBody(sh.dest));
      } else if (sh.action === 'place') {
        if (!sh.dest) { toast('Escolha a prateleira ou a caixa.', 'bad'); return; }
        url = WH + '/product/' + id + '/place';
        body = Object.assign({ qty: qty }, locBody(sh.dest));
      } else if (sh.action === 'move') {
        if (!sh.from || !sh.to) { toast('Escolha de onde e pra onde.', 'bad'); return; }
        if (sh.from === sh.to) { toast('De onde e pra onde não podem ser o mesmo lugar.', 'bad'); return; }
        url = WH + '/product/' + id + '/move';
        body = { qty: qty, from: locBody(sh.from), to: locBody(sh.to) };
      } else if (sh.action === 'separate') {
        url = WH + '/product/' + id + '/separate';
        body = Object.assign({ qty: qty, reason: sh.reason || 'other' }, locBody(sh.dest));
      }
    }
    if (!url) return;

    S.busy = true; render();
    var what = ACTIONS[sh.action] || {};
    api(url, { method: 'POST', body: body }).then(function () {
      S.busy = false;
      S.sheet = null;
      toast(doneText(sh.action, qty), 'ok');
      render();
      return loadBoot(true);
    }).catch(function (e) {
      S.busy = false; render();
      fail(e);
    });
  }

  /** A confirmação diz o que aconteceu, não "ok". */
  function doneText(action, qty) {
    var n = fmt(Math.abs(qty));
    if (action === 'entrada') return n + ' garrafas entraram no estoque.';
    if (action === 'place') return n + ' garrafas guardadas.';
    if (action === 'move') return n + ' garrafas mudaram de lugar.';
    if (action === 'adjust') return 'Estoque ajustado em ' + (qty > 0 ? '+' : '-') + n + '.';
    if (action === 'separate') return n + ' garrafas foram pra Separadas.';
    return 'Pronto.';
  }

  // ══════════════════════════════════════════════════════════════════
  // ABA: LOCAIS
  // ══════════════════════════════════════════════════════════════════
  function locaisHtml() {
    var q = S.locSearch.trim().toLowerCase();
    var isBins = S.locTab === 'bins';
    var list = (isBins ? bins() : boxes()).filter(function (l) {
      if (!q) return true;
      var hay = [(isBins ? l.bin_code : l.box_number), l.shelf_code, l.area, l.product].filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    var selKey = isBins ? 'bins' : 'boxes';
    var sel = S.sel[selKey];

    var h = '<div class="page">';
    h += pageHead('Prateleiras e caixas', 'Onde a garrafa', 'mora',
      'Toque no nome pra ver. Toque no quadrinho pra escolher e imprimir etiqueta.');

    h += '<div class="btn-row" style="margin-bottom:12px;">'
      + '<button class="btn' + (isBins ? ' primary' : '') + '" data-act="loctab" data-arg="bins">Prateleiras</button>'
      + '<button class="btn' + (!isBins ? ' primary' : '') + '" data-act="loctab" data-arg="boxes">Caixas</button>'
      + '</div>';

    if (sel.length) {
      h += '<div class="selbar">'
        + '<b style="flex:1; font-size:13.5px;">' + sel.length + (sel.length === 1 ? ' etiqueta escolhida' : ' etiquetas escolhidas') + '</b>'
        + '<button class="btn sm" data-act="tab" data-arg="imprimir">Imprimir</button>'
        + '<button class="btn sm" data-act="selclear" data-arg="' + selKey + '">Limpar</button>'
        + '</div>';
    }

    h += '<div class="search">' + icon('search')
      + '<input class="input" data-input="locSearch" value="' + esc(S.locSearch) + '" '
      + 'placeholder="' + (isBins ? 'Código, corredor ou produto' : 'Número da caixa ou produto') + '" autocomplete="off" autocapitalize="characters"></div>';

    if (canWrite()) {
      h += '<button class="btn block" data-act="newloc" data-arg="' + (isBins ? 'bin' : 'box') + '" style="margin-bottom:12px;">'
        + icon('plus') + (isBins ? 'Nova prateleira' : 'Nova caixa') + '</button>';
    }

    if (!list.length) {
      h += '<div class="card">' + empty('&#128205;',
        (isBins ? 'Nenhuma prateleira aqui' : 'Nenhuma caixa aqui'),
        q ? 'Nada com esse texto. Apague a busca pra ver tudo.'
          : 'Cadastre a primeira com o botão acima. Sem local cadastrado, o estoque não tem onde morar.') + '</div>';
      return h + '</div>';
    }

    h += '<div class="list">';
    list.forEach(function (l) {
      var id = l.id;
      var on = sel.indexOf(num(id)) >= 0;
      var code = isBins ? l.bin_code : l.box_number;
      var sub = isBins
        ? [l.shelf_code, l.area, l.product].filter(Boolean).join(' · ')
        : [l.area, l.product, l.batch_number ? 'lote ' + l.batch_number : ''].filter(Boolean).join(' · ');
      h += '<div class="item' + (on ? ' sel' : '') + '">'
        + '<button class="tick' + (on ? ' on' : '') + '" data-act="seltoggle" data-arg="' + selKey + ':' + esc(id) + '" '
        + 'aria-label="Escolher etiqueta de ' + esc(code) + '">' + (on ? icon('check') : '') + '</button>'
        + '<button class="grow" style="border:0; background:none; padding:0; text-align:left;" '
        + 'data-act="' + (isBins ? 'binSheet' : 'boxSheet') + '" data-arg="' + esc(id) + '">'
        + '<span class="t">' + esc(code) + '</span>'
        + (sub ? '<span class="s">' + esc(sub) + '</span>' : '<span class="s">sem produto</span>')
        + '</button>'
        + '<b class="mono">' + fmt(l.qty) + '</b>'
        + '</div>';
    });
    h += '</div>';
    return h + '</div>';
  }

  function openBinSheet(id) {
    var b = binById(id);
    if (!b) { toast('Não achei essa prateleira aqui. Puxe os dados de novo.', 'bad'); return; }
    S.sheet = { type: 'bin', bin: b };
    render();
  }
  function openBoxSheet(id) {
    var x = boxById(id);
    if (!x) { toast('Não achei essa caixa aqui. Puxe os dados de novo.', 'bad'); return; }
    S.sheet = { type: 'box', box: x };
    render();
  }

  function binSheet(sh) {
    var b = sh.bin || {};
    var body = '<div class="nums">'
      + numCell('Quantidade', b.qty)
      + numCell('Mínimo', b.min_qty)
      + numCell('Cabe', b.capacity)
      + numCell('Tara g', b.tare_g)
      + '</div>';
    body += '<div class="card flat"><div class="sub">'
      + esc([b.shelf_code ? 'Corredor ' + b.shelf_code : '', b.area ? 'Área ' + b.area : '',
        b.product ? 'Produto ' + b.product : 'Sem produto fixo'].filter(Boolean).join(' · '))
      + '</div></div>';
    if (b.product_id) {
      body += '<button class="btn block" data-act="product" data-arg="' + esc(b.product_id) + '" style="margin-bottom:9px;">Ver o produto</button>';
    }
    body += '<button class="btn primary block" data-act="labelOne" data-arg="bin:' + esc(b.id) + '">Imprimir etiqueta</button>';
    return sheetShell('Prateleira ' + (b.bin_code || ''), '', body);
  }

  function boxSheet(sh) {
    var x = sh.box || {};
    var body = '<div class="nums">'
      + numCell('Quantidade', x.qty)
      + numCell('Tara g', x.tare_g)
      + '<div class="num"><div class="v">' + esc(x.batch_number || '-') + '</div>' + mlabel('Lote') + '</div>'
      + '<div class="num"><div class="v">' + (x.sealed ? 'sim' : 'não') + '</div>' + mlabel('Lacrada') + '</div>'
      + '</div>';
    body += '<div class="card flat"><div class="sub">'
      + esc([x.area ? 'Área ' + x.area : '', x.product ? 'Produto ' + x.product : 'Sem produto',
        x.status ? 'Situação ' + x.status : ''].filter(Boolean).join(' · ')) + '</div></div>';
    if (x.product_id) {
      body += '<button class="btn block" data-act="product" data-arg="' + esc(x.product_id) + '" style="margin-bottom:9px;">Ver o produto</button>';
    }
    body += '<button class="btn primary block" data-act="labelOne" data-arg="box:' + esc(x.id) + '">Imprimir etiqueta</button>';
    return sheetShell('Caixa ' + (x.box_number || ''), '', body);
  }

  // ── cadastrar local ──────────────────────────────────────────────
  function openNewLoc(kind) {
    if (!canWrite()) { toast('Este login não pode editar estoque.', 'bad'); return; }
    S.sheet = { type: 'newloc', kind: kind, code: '', shelf: '', area: '', product_id: '', qty: '' };
    render();
  }

  function newLocSheet(sh) {
    var isBin = sh.kind === 'bin';
    var prodOpts = '<option value="">Sem produto fixo</option>';
    products().forEach(function (p) {
      prodOpts += '<option value="' + esc(p.product_id) + '"' + (String(sh.product_id) === String(p.product_id) ? ' selected' : '') + '>'
        + esc(p.nickname || p.name) + '</option>';
    });

    var body = '<div class="sub" style="margin-bottom:13px;">'
      + (isBin ? 'A prateleira é o lugar de onde se pega pra despachar.'
        : 'A caixa é o estoque guardado. Se disser quantas garrafas, isso vira entrada de verdade.')
      + '</div>';
    body += '<div class="field">' + mlabel(isBin ? 'Código da prateleira' : 'Número da caixa')
      + '<input class="input mono" data-input="code" value="' + esc(sh.code) + '" '
      + 'placeholder="' + (isBin ? 'Ex.: A03B2' : 'Ex.: BX-0451') + '" autocomplete="off" autocapitalize="characters"></div>';
    if (isBin) {
      body += '<div class="field">' + mlabel('Corredor (opcional)')
        + '<input class="input" data-input="shelf" value="' + esc(sh.shelf) + '" placeholder="Ex.: S4" autocomplete="off"></div>';
    }
    body += '<div class="field">' + mlabel('Área (opcional)')
      + '<input class="input" data-input="area" value="' + esc(sh.area) + '" placeholder="Ex.: P&amp;P" autocomplete="off"></div>';
    body += '<div class="field">' + mlabel(isBin ? 'Produto (opcional)' : 'Produto')
      + '<select class="input" data-input="product_id">' + prodOpts + '</select></div>';
    if (!isBin) {
      body += '<div class="field">' + mlabel('Quantas garrafas já tem (opcional)')
        + '<input class="input mono" data-input="qty" inputmode="numeric" value="' + esc(sh.qty) + '" placeholder="0"></div>';
    }
    body += '<button class="btn primary big block" data-act="newlocGo"' + (S.busy ? ' disabled' : '') + '>'
      + (S.busy ? '<span class="spin"></span> Cadastrando...' : (isBin ? 'Cadastrar prateleira' : 'Cadastrar caixa')) + '</button>';

    return sheetShell(isBin ? 'Nova prateleira' : 'Nova caixa', '', body);
  }

  function submitNewLoc() {
    var sh = S.sheet;
    if (!sh || sh.type !== 'newloc' || S.busy) return;
    var code = String(sh.code || '').trim().toUpperCase();
    if (!code) { toast(sh.kind === 'bin' ? 'Digite o código da prateleira.' : 'Digite o número da caixa.', 'bad'); return; }
    var isBin = sh.kind === 'bin';
    var body = isBin
      ? { bin_code: code, shelf_code: sh.shelf || null, area: sh.area || null, product_id: intOf(sh.product_id) || null }
      : { box_number: code, area: sh.area || null, product_id: intOf(sh.product_id) || null, qty: intOf(sh.qty) || 0 };

    S.busy = true; render();
    api(WH + '/locations/' + (isBin ? 'bin' : 'box'), { method: 'POST', body: body }).then(function () {
      S.busy = false;
      S.sheet = null;
      toast(isBin ? 'Prateleira ' + code + ' cadastrada.' : 'Caixa ' + code + ' cadastrada.', 'ok');
      render();
      return loadBoot(true);
    }).catch(function (e) { S.busy = false; render(); fail(e); });
  }

  // ══════════════════════════════════════════════════════════════════
  // ABA: IMPRIMIR
  // ══════════════════════════════════════════════════════════════════
  function imprimirHtml() {
    var nb = S.sel.bins.length; var nx = S.sel.boxes.length;
    var total = nb + nx;
    var h = '<div class="page">';
    h += pageHead('Etiquetas e fila', 'Imprimir do', 'celular',
      'Imprima aqui pelo AirPrint, ou mande pro computador da impressora.');

    // (a) o que está escolhido
    if (!total) {
      h += '<div class="card">' + empty('&#127991;', 'Nenhuma etiqueta escolhida',
        'Vá em Locais, marque as prateleiras ou caixas e volte aqui. Ou abra uma delas e toque em Imprimir etiqueta.') + '</div>';
    } else {
      h += '<div class="card">'
        + '<div style="display:flex; gap:7px; flex-wrap:wrap; margin-bottom:11px;">'
        + (nb ? chip(nb + (nb === 1 ? ' prateleira' : ' prateleiras'), 'neutral') : '')
        + (nx ? chip(nx + (nx === 1 ? ' caixa' : ' caixas'), 'neutral') : '')
        + '</div>'
        + '<button class="btn primary big block" data-act="printHere" style="margin-bottom:9px;"'
        + (S.busy ? ' disabled' : '') + '>Imprimir daqui</button>'
        + (canWrite()
          ? '<button class="btn big block" data-act="printSend"' + (S.busy ? ' disabled' : '') + '>Mandar pro computador</button>'
          : '')
        + '<div class="sub" style="margin-top:9px;">Imprimir daqui abre a folha e usa o AirPrint do iPhone. Mandar pro computador põe na fila da impressora do armazém.</div>'
        + '<button class="btn sm block" data-act="selclearall" style="margin-top:11px;">Limpar a escolha</button>'
        + '</div>';
    }

    // (a2) etiquetas de envio de hoje
    h += shipCardHtml();

    // (d) picklist do dia
    if (canWrite()) {
      h += '<div class="card"><div style="font-weight:600; margin-bottom:5px;">Picklist de hoje</div>'
        + '<div class="sub" style="margin-bottom:11px;">Sai na impressora da Central, com os pedidos do dia.</div>'
        + '<button class="btn block" data-act="printPicklist"' + (S.busy ? ' disabled' : '') + '>Mandar o picklist</button></div>';
    }

    // (b) fila
    h += '<div class="sect">' + mlabel('Fila de impressão') + '<span class="rule"></span>'
      + '<button class="btn sm" data-act="reloadQueue">Atualizar</button></div>';
    if (!S.queue.length) {
      h += '<div class="card flat"><div class="sub">Nada na fila. O que você mandar aparece aqui até sair no papel.</div></div>';
    } else {
      h += '<div class="list">';
      S.queue.forEach(function (j) {
        var st = JOB_STATUS[j.status] || { label: j.status, tone: 'neutral' };
        var n = (j.payload && j.payload.labels && j.payload.labels.length) || 0;
        h += '<div class="item"><span class="grow">'
          + '<span class="t">' + esc(JOB_KIND_LABEL[j.kind] || j.kind) + (n ? ' (' + n + ')' : '') + '</span>'
          + '<span class="s">' + esc([j.requested_by || '', ageText(j.age_min), j.error_note || ''].filter(Boolean).join(' · ')) + '</span>'
          + '</span>'
          + chip(st.label, st.tone)
          + (j.status === 'queued' && canWrite()
            ? '<button class="btn sm" data-act="cancelJob" data-arg="' + esc(j.id) + '">Cancelar</button>' : '')
          + '</div>';
      });
      h += '</div>';
    }

    // (c) impressoras
    h += '<div class="sect">' + mlabel('Impressoras') + '<span class="rule"></span></div>';
    if (!S.printers.length) {
      h += '<div class="card flat"><div class="sub">Sem notícia das impressoras agora.</div></div>';
    } else {
      h += '<div class="list">';
      S.printers.forEach(function (p) {
        var tone = p.error_label ? 'bad' : 'ok';
        h += '<div class="item"><span class="grow">'
          + '<span class="t">' + esc(p.name || 'impressora') + '</span>'
          + '<span class="s">' + esc(p.error_label || p.status_label || '')
          + (p.jobs_today != null ? ' · ' + fmt(p.jobs_today) + ' hoje' : '') + '</span>'
          + '</span>' + chip(p.error_label ? 'com erro' : (p.status_label || 'ok'), tone) + '</div>';
      });
      h += '</div>';
    }
    return h + '</div>';
  }

  function loadPrintSide() {
    api(PQ + '?status=all&limit=20').then(function (d) {
      S.queue = (d && d.jobs) || [];
      render();
    }).catch(function () { /* a fila é acessório: não derruba a tela */ });
    api(WH + '/mobile/printers').then(function (d) {
      S.printers = (d && d.printers) || [];
      render();
    }).catch(function () {});
    loadShip();
  }

  // ══════════════════════════════════════════════════════════════════
  // ETIQUETAS DE ENVIO DE HOJE
  // A etiqueta da transportadora com o rodapé do nosso sistema (apelido,
  // local, garrafas, envelope, quem separou e quem embalou). O papel certo
  // sai na 4x6 da Central; daqui o Bruno manda pra lá, ou abre o PDF no
  // iPhone quando quiser conferir antes.
  // ══════════════════════════════════════════════════════════════════

  /** Hoje em Nova York: o dia do P&P é o da fábrica, não o do celular. */
  function todayNY() {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
    } catch (e) { return new Date().toISOString().slice(0, 10); }
  }

  function loadShip() {
    return api(PQ + '/shipping-labels/preview?day=' + encodeURIComponent(todayNY()))
      .then(function (d) {
        S.ship = { day: (d && d.day) || todayNY(), ready: (d && d.ready) || [], counts: (d && d.counts) || {} };
        render();
      })
      .catch(function () {
        /* Veeqo fora do ar não pode esconder a aba inteira: o cartão diz que
           não deu e o resto (fila, impressoras, etiquetas) segue. */
        S.ship = { down: true, ready: [], counts: {} };
        render();
      });
  }

  /** Uma linha por produto pro resumo: apelido · quantas · local. */
  function shipGroups(p) {
    var by = {}; var order = [];
    ((p && p.ready) || []).forEach(function (o) {
      var pr = (o.products || [])[0] || {};
      var nick = pr.nickname || pr.sku || 'sem produto';
      if (!by[nick]) { by[nick] = { nickname: nick, count: 0, location: pr.bin_code || pr.shelf_code || 'sem local' }; order.push(nick); }
      by[nick].count += 1;
    });
    return order.map(function (k) { return by[k]; });
  }

  function shipCardHtml() {
    var p = S.ship;
    var h = '<div class="card" data-card="shipping-labels">'
      + '<div style="font-weight:600; margin-bottom:5px;">Etiquetas de envio de hoje</div>';
    if (!p) return h + '<div class="sub">Vendo o que a Veeqo tem pra hoje…</div></div>';
    if (p.down) {
      return h + '<div class="sub">Não deu pra falar com a Veeqo agora. Toque em Atualizar daqui a pouco.</div>'
        + '<button class="btn sm block" data-act="reloadShip" style="margin-top:9px;">Atualizar</button></div>';
    }
    var c = p.counts || {};
    var ready = Number(c.ready) || 0;
    var printed = Number(c.printed) || 0;
    var toPrint = Number(c.to_print) || 0;

    h += '<div style="display:flex; gap:7px; flex-wrap:wrap; margin-bottom:10px;" data-counts="shipping">'
      + chip(ready + ' prontas', 'neutral')
      + chip(printed + ' impressas', 'ok')
      + chip(toPrint + ' pra imprimir', toPrint ? 'warn' : 'neutral')
      + '</div>';

    var gs = shipGroups(p);
    if (gs.length) {
      h += '<div class="list" style="margin-bottom:11px;" data-list="shipping-groups">';
      gs.forEach(function (g) {
        h += '<div class="item"><span class="grow">'
          + '<span class="t">' + esc(g.nickname) + '</span>'
          + '<span class="s">' + esc(g.location) + '</span></span>'
          + chip(g.count + (g.count === 1 ? ' etiqueta' : ' etiquetas'), 'neutral') + '</div>';
      });
      h += '</div>';
    }

    if (!toPrint) {
      h += '<div class="sub">' + (ready ? 'Tudo de hoje já saiu no papel.' : 'Nenhuma etiqueta comprada na Veeqo hoje ainda.') + '</div>';
    }
    if (canWrite() && toPrint) {
      h += '<button class="btn primary big block" data-act="shipSend"' + (S.busy ? ' disabled' : '') + ' style="margin-bottom:9px;">Mandar pro computador</button>';
    }
    if (toPrint || ready) {
      h += '<button class="btn big block" data-act="shipOpen"' + (S.busy ? ' disabled' : '') + '>Abrir PDF aqui</button>'
        + '<div class="sub" style="margin-top:9px;">Mandar pro computador põe na fila da Central, que imprime na 4x6. Abrir PDF aqui usa o AirPrint do iPhone.</div>';
    }
    return h + '</div>';
  }

  /** MANDAR PRO COMPUTADOR: compõe sem take; a Central puxa da fila e imprime. */
  function shipSend() {
    if (!canWrite()) { toast('Este login não pode mandar imprimir.', 'bad'); return; }
    S.busy = true; render();
    api(PQ + '/shipping-labels', { method: 'POST', body: { day: todayNY() } })
      .then(function () {
        S.busy = false;
        toast('Mandado. Sai na 4x6 da Central em até 30 s.', 'ok');
        render();
        loadPrintSide();
      })
      .catch(function (e) {
        S.busy = false; render();
        if (e && e.code === 'nothing_to_print') { toast('Nada novo pra imprimir. As de hoje já saíram.', 'ok'); loadShip(); return; }
        fail(e);
      });
  }

  /**
   * ABRIR PDF AQUI: o arquivo mora atrás do PIN, e uma aba nova não manda
   * header nenhum. Então buscamos os bytes com a credencial e abrimos um
   * blob local. A aba nasce ANTES do await: no iOS, window.open que não vem
   * direto do toque é bloqueado.
   */
  function shipOpen() {
    var win = window.open('', '_blank');
    S.busy = true; render();
    api(PQ + '/shipping-labels', { method: 'POST', body: { day: todayNY(), take: true } })
      .then(function (d) {
        var url = (d && d.file_url) || (d && d.job ? PQ + '/' + d.job.id + '/file' : '');
        if (!url) throw new Error('o servidor não devolveu o arquivo');
        return apiBlob(url).then(function (blob) {
          S.busy = false; render();
          var obj = URL.createObjectURL(blob);
          if (!win) { toast('O Safari bloqueou a janela. Libere os pop-ups deste site e toque de novo.', 'bad'); return; }
          win.location = obj;
          toast('PDF aberto. Use Imprimir pra mandar pro AirPrint.', 'ok');
          loadPrintSide();
        });
      })
      .catch(function (e) {
        S.busy = false; render();
        if (win) { try { win.close(); } catch (e2) {} }
        if (e && e.code === 'nothing_to_print') { toast('Nada novo pra imprimir. As de hoje já saíram.', 'ok'); loadShip(); return; }
        fail(e);
      });
  }

  /** Puxa os labels prontos do servidor (mesma função do GET /labels). */
  function fetchLabels() {
    var q = [];
    if (S.sel.bins.length) q.push('bins=' + S.sel.bins.join(','));
    if (S.sel.boxes.length) q.push('boxes=' + S.sel.boxes.join(','));
    if (!q.length) return Promise.resolve([]);
    return api(WH + '/labels?' + q.join('&')).then(function (d) { return (d && d.labels) || []; });
  }

  /**
   * IMPRIMIR DAQUI: desenha a folha 4x6 (Code128 + QR, o mesmo desenho do
   * kiosk) e chama o print do Safari, que abre o AirPrint. A janela é
   * aberta ANTES do await: o iOS bloqueia window.open que não nasce do
   * toque.
   */
  function printHere() {
    if (!S.sel.bins.length && !S.sel.boxes.length) return;
    var win = window.open('', '_blank');
    S.busy = true; render();
    fetchLabels().then(function (labels) {
      S.busy = false; render();
      if (!labels.length) { if (win) win.close(); toast('Não achei essas etiquetas. Escolha de novo.', 'bad'); return; }
      var L = window.HF_LABELS;
      if (!L || typeof L.sheetHtml !== 'function') {
        if (win) win.close();
        toast('O desenho da etiqueta não carregou. Recarregue a página.', 'bad');
        return;
      }
      var doc = L.sheetHtml(labels, { title: 'Etiquetas HealthFare' });
      if (!win) { toast('O Safari bloqueou a janela. Libere os pop-ups deste site e toque de novo.', 'bad'); return; }
      win.document.open(); win.document.write(doc); win.document.close();
      toast(labels.length + (labels.length === 1 ? ' etiqueta pronta. Use Imprimir.' : ' etiquetas prontas. Use Imprimir.'), 'ok');
    }).catch(function (e) {
      S.busy = false; render();
      if (win) win.close();
      fail(e);
    });
  }

  /** MANDAR PRO COMPUTADOR: a fila que o PC da impressora puxa. */
  function printSend() {
    if (!canWrite()) { toast('Este login não pode mandar imprimir.', 'bad'); return; }
    var jobs = [];
    if (S.sel.bins.length) jobs.push({ kind: 'bin_labels', bins: S.sel.bins.slice() });
    S.sel.boxes.forEach(function (id) { jobs.push({ kind: 'box_label', boxes: [id] }); });
    if (!jobs.length) return;
    S.busy = true; render();
    Promise.all(jobs.map(function (b) {
      return api(WH + '/mobile/print/submit', { method: 'POST', body: b });
    })).then(function () {
      S.busy = false;
      S.sel = { bins: [], boxes: [] };
      toast('Mandado. Aparece no computador da impressora em até 30 s.', 'ok');
      render();
      loadPrintSide();
    }).catch(function (e) { S.busy = false; render(); fail(e); });
  }

  function printPicklist() {
    if (!canWrite()) { toast('Este login não pode mandar imprimir.', 'bad'); return; }
    S.busy = true; render();
    api(WH + '/mobile/print/submit', { method: 'POST', body: { kind: 'picklist' } }).then(function () {
      S.busy = false;
      toast('Picklist mandado. Sai na impressora da Central.', 'ok');
      render();
      loadPrintSide();
    }).catch(function (e) { S.busy = false; render(); fail(e); });
  }

  function cancelJob(id) {
    api(PQ + '/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: {} }).then(function () {
      toast('Cancelado. Não vai sair no papel.', 'ok');
      loadPrintSide();
    }).catch(function (e) { fail(e); });
  }

  /** "Imprimir etiqueta" dentro da folha de um local: escolhe e vai. */
  function labelOne(arg) {
    var parts = String(arg || '').split(':');
    var id = intOf(parts[1]);
    if (!id) return;
    S.sel = { bins: [], boxes: [] };
    if (parts[0] === 'bin') S.sel.bins = [id]; else S.sel.boxes = [id];
    S.sheet = null;
    S.tab = 'imprimir';
    render();
    loadPrintSide();
  }

  // ══════════════════════════════════════════════════════════════════
  // CÂMERA / LER CÓDIGO
  // ══════════════════════════════════════════════════════════════════
  var camState = { stream: null, detector: null, zx: null, running: false, last: '', lastAt: 0 };

  function camHtml() {
    var c = S.cam || {};
    return '<div class="cam">'
      + '<video id="mvideo" playsinline muted autoplay></video>'
      + '<div class="aim"><i></i></div>'
      + '<div class="flash" id="mflash"></div>'
      + '<div class="cam-top"><span class="t">Ler código</span>'
      + '<button class="close" data-act="camClose" aria-label="Fechar">&times;</button></div>'
      + '<div class="cam-bot">'
      + mlabel('Aponte pra etiqueta ou pro código de barras')
      + '<div class="hint">' + esc(c.hint || 'Abrindo a câmera...') + '</div>'
      + '<div class="row">'
      + '<input class="input" id="mmanual" placeholder="Digitar o código na mão" autocomplete="off" autocapitalize="characters" enterkeyhint="go">'
      + '<button class="btn" data-act="camManual">Buscar</button>'
      + '</div></div></div>';
  }

  function openCam() {
    S.cam = { hint: 'Abrindo a câmera...' };
    render();
    startCamera();
  }
  function closeCam() {
    S.cam = null;
    stopCamera();
    render();
  }
  function stopCamera() {
    camState.running = false;
    try { if (camState.zx && camState.zx.reset) camState.zx.reset(); } catch (e) {}
    camState.zx = null;
    camState.detector = null;
    try {
      if (camState.stream) camState.stream.getTracks().forEach(function (t) { t.stop(); });
    } catch (e) {}
    camState.stream = null;
  }

  function camHint(t) {
    if (!S.cam) return;
    S.cam.hint = t;
    var n = document.querySelector('.cam .hint');
    if (n) n.textContent = t; else render();
  }

  function startCamera() {
    var video = document.getElementById('mvideo');
    if (!video) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camHint('Este navegador não abre a câmera. Digite o código aqui embaixo.');
      return;
    }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    }).then(function (s) {
      camState.stream = s;
      video.srcObject = s;
      return video.play().catch(function () {});
    }).then(function () {
      camHint('Aponte pro código.');
      startDecoder(video);
    }).catch(function (e) {
      var n = (e && e.name) || '';
      camHint(n === 'NotAllowedError'
        ? 'Toque em Permitir pra usar a câmera. Enquanto isso, digite o código aqui embaixo.'
        : 'Não consegui abrir a câmera. Digite o código aqui embaixo.');
    });
  }

  /** BarcodeDetector quando existe (Safari 17+), ZXing pro resto. O ZXing
      só é BAIXADO se for preciso: são 300 kB que o 4G agradece. */
  function startDecoder(video) {
    if (typeof window.BarcodeDetector !== 'undefined') {
      try {
        camState.detector = new window.BarcodeDetector({ formats: FORMATS });
      } catch (e) {
        try { camState.detector = new window.BarcodeDetector(); } catch (e2) { camState.detector = null; }
      }
      if (camState.detector) { camState.running = true; nativeTick(video); return; }
    }
    loadZxing().then(function () { startZxing(video); }).catch(function () {
      camHint('Este navegador não lê código de barras. Digite o código aqui embaixo.');
    });
  }

  function nativeTick(video) {
    if (!camState.running || !camState.detector) return;
    if (!video.videoWidth) { requestAnimationFrame(function () { nativeTick(video); }); return; }
    camState.detector.detect(video).then(function (list) {
      if (list && list.length) onScan(list[0].rawValue);
    }).catch(function () {}).then(function () {
      if (camState.running) setTimeout(function () { nativeTick(video); }, 130);
    });
  }

  var zxingLoading = null;
  function loadZxing() {
    if (window.ZXing) return Promise.resolve();
    if (zxingLoading) return zxingLoading;
    zxingLoading = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = ZXING_SRC;
      s.onload = function () { res(); };
      s.onerror = function () { zxingLoading = null; rej(new Error('zxing')); };
      document.head.appendChild(s);
    });
    return zxingLoading;
  }

  function startZxing(video) {
    var Z = window.ZXing;
    if (!Z) { camHint('Este navegador não lê código de barras. Digite o código aqui embaixo.'); return; }
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
      camState.zx = new Z.BrowserMultiFormatReader(hints, 200);
      camState.running = true;
      camState.zx.decodeFromVideoElement(video, function (result) {
        if (result) onScan(result.getText ? result.getText() : String(result));
      });
    } catch (e) {
      camHint('O leitor da câmera falhou. Digite o código aqui embaixo.');
    }
  }

  function camFlash() {
    var f = document.getElementById('mflash');
    if (!f) return;
    f.className = 'flash on';
    setTimeout(function () { var n = document.getElementById('mflash'); if (n) n.className = 'flash'; }, 130);
  }

  /** Um código foi lido (câmera ou digitado) → resolve → cai na ficha. */
  function onScan(raw) {
    var code = String(raw || '').replace(/[\r\n\t]+/g, '').trim();
    if (!code) return;
    var now = Date.now();
    if (code === camState.last && (now - camState.lastAt) < DUP_MS) return;
    camState.last = code; camState.lastAt = now;
    camFlash(); buzz(50);
    camHint('Procurando ' + code + '...');
    resolveCode(code);
  }

  function resolveCode(code) {
    api(WH + '/mobile/scan/resolve?barcode=' + encodeURIComponent(code)).then(function (d) {
      var kind = d && d.kind;
      if (kind === 'bin' && d.bin) { closeCam(); openBinSheet(d.bin.id); return; }
      if (kind === 'box' && d.box) { closeCam(); openBoxSheet(d.box.id); return; }
      if (kind === 'product' && d.product) { closeCam(); openProduct(d.product.id || d.product.product_id); return; }
      camHint('Não reconheci. Digite o código ou cadastre.');
      camState.last = '';           // deixa tentar de novo o mesmo código
    }).catch(function (e) {
      camHint((e && e.message) || 'Não deu pra procurar agora.');
      camState.last = '';
    });
  }

  function camManual() {
    var i = document.getElementById('mmanual');
    var v = (i && i.value || '').trim();
    if (!v) { if (i) i.focus(); return; }
    camState.last = ''; camState.lastAt = 0;    // digitou: é intencional
    onScan(v);
    if (i) { i.value = ''; i.blur(); }
  }

  // ══════════════════════════════════════════════════════════════════
  // FOLHAS
  // ══════════════════════════════════════════════════════════════════
  function sheetShell(title, sub, body) {
    return '<div class="scrim" data-act="sheetScrim"><div class="sheet" data-sheet="1">'
      + '<div class="grab"></div>'
      + '<div class="sheet-head"><div class="grow">'
      + '<div class="h2">' + esc(title) + '</div>'
      + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '')
      + '</div><button class="sheet-x" data-act="sheetClose" aria-label="Fechar">&times;</button></div>'
      + body + '</div></div>';
  }

  function sheetHtml() {
    var sh = S.sheet;
    if (!sh) return '';
    if (sh.type === 'product') return productSheet(sh);
    if (sh.type === 'action') return actionSheet(sh);
    if (sh.type === 'bin') return binSheet(sh);
    if (sh.type === 'box') return boxSheet(sh);
    if (sh.type === 'newloc') return newLocSheet(sh);
    if (sh.type === 'decide') return decideSheet(sh);
    return '';
  }

  // ══════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════
  function bodyHtml() {
    if (S.tab === 'inicio') return inicioHtml();
    if (S.tab === 'aprovar') return aprovarHtml();
    if (S.tab === 'produtos') return produtosHtml();
    if (S.tab === 'locais') return locaisHtml();
    if (S.tab === 'imprimir') return imprimirHtml();
    return '';
  }

  function render() {
    var app = document.getElementById('app');
    if (!app) return;
    if (!S.pin) { app.innerHTML = pinHtml(); return; }
    if (!S.booted) {
      app.innerHTML = topbarHtml() + '<div class="shell"><div class="loading">Carregando o armazém...</div></div>';
      return;
    }
    // guarda o foco e o cursor: redesenhar não pode roubar o que o dedo digita
    var act = document.activeElement;
    var key = act && act.getAttribute ? act.getAttribute('data-input') : null;
    var pos = key && act.selectionStart != null ? act.selectionStart : null;

    app.innerHTML = shellHtml(bodyHtml()) + sheetHtml() + (S.cam ? camHtml() : '');

    if (key) {
      var next = document.querySelector('[data-input="' + key + '"]');
      if (next && next.focus) {
        next.focus();
        try { if (pos != null && next.setSelectionRange) next.setSelectionRange(pos, pos); } catch (e) {}
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // EVENTOS
  // ══════════════════════════════════════════════════════════════════
  function onClick(ev) {
    var t = ev.target;
    var el = t && t.closest ? t.closest('[data-act]') : null;
    if (!el) return;
    var act = el.getAttribute('data-act');
    var arg = el.getAttribute('data-arg');

    // toque fora da folha fecha; dentro, não
    if (act === 'sheetScrim') {
      if (t.closest && t.closest('[data-sheet]')) return;
      S.sheet = null; render(); return;
    }

    ev.preventDefault();
    switch (act) {
      case 'pinkey': pinKey(arg); break;
      case 'tab': S.tab = arg; S.sheet = null; render(); if (arg === 'imprimir') loadPrintSide(); break;
      case 'refresh': loadBoot(true).catch(function () {}); break;
      case 'logout':
        clearPin(); stopCamera(); S.cam = null; S.booted = false; S.tab = 'inicio'; render();
        toast('Você saiu. Digite o PIN pra voltar.');
        break;
      case 'scan': openCam(); break;
      case 'camClose': closeCam(); break;
      case 'camManual': camManual(); break;
      case 'attn': onAttention(arg); break;
      case 'approve': openDecide(arg, 'approve'); break;
      case 'reject': openDecide(arg, 'reject'); break;
      case 'decideGo': decide(S.sheet.id, S.sheet.action); break;
      case 'product': openProduct(arg); break;
      case 'paction': openAction(arg); break;
      case 'actionGo': submitAction(); break;
      case 'qty': bumpQty(intOf(arg) || 0); break;
      case 'loctab': S.locTab = arg; render(); break;
      case 'binSheet': openBinSheet(arg); break;
      case 'boxSheet': openBoxSheet(arg); break;
      case 'newloc': openNewLoc(arg); break;
      case 'newlocGo': submitNewLoc(); break;
      case 'seltoggle': toggleSel(arg); break;
      case 'selclear': S.sel[arg] = []; render(); break;
      case 'selclearall': S.sel = { bins: [], boxes: [] }; render(); break;
      case 'labelOne': labelOne(arg); break;
      case 'printHere': printHere(); break;
      case 'printSend': printSend(); break;
      case 'printPicklist': printPicklist(); break;
      case 'reloadQueue': loadPrintSide(); break;
      case 'reloadShip': S.ship = null; render(); loadShip(); break;
      case 'shipSend': shipSend(); break;
      case 'shipOpen': shipOpen(); break;
      case 'cancelJob': cancelJob(arg); break;
      case 'sheetClose': S.sheet = null; render(); break;
      default: break;
    }
  }

  function bumpQty(delta) {
    var sh = S.sheet;
    if (!sh) return;
    var cur = intOf(sh.qty) || 0;
    var next = cur + delta;
    if (sh.action !== 'adjust' && next < 0) next = 0;
    sh.qty = String(next);
    render();
  }

  function toggleSel(arg) {
    var p = String(arg || '').split(':');
    var key = p[0]; var id = intOf(p[1]);
    if (!id || !S.sel[key]) return;
    var i = S.sel[key].indexOf(id);
    if (i >= 0) S.sel[key].splice(i, 1); else S.sel[key].push(id);
    buzz(18);
    render();
  }

  /** Campos: guarda no estado e só redesenha quando é preciso. Redesenhar
      a cada tecla num iPhone é o que faz teclado piscar. */
  function onInput(ev) {
    var el = ev.target;
    var key = el && el.getAttribute ? el.getAttribute('data-input') : null;
    if (!key) return;
    var v = el.value;
    if (key === 'productSearch') { S.productSearch = v; renderSoon(); return; }
    if (key === 'locSearch') { S.locSearch = v; renderSoon(); return; }
    if (S.sheet) {
      if (key === 'decideNote') { S.sheet.note = v; return; }
      S.sheet[key] = v;
      // seletores mudam de forma; campos de texto não precisam de redesenho
      if (el.tagName === 'SELECT') render();
    }
  }

  var soon = null;
  function renderSoon() {
    if (soon) clearTimeout(soon);
    soon = setTimeout(function () { soon = null; render(); }, 130);
  }

  function onKeydown(ev) {
    if (ev.key !== 'Enter') return;
    var el = ev.target;
    if (el && el.id === 'mmanual') { ev.preventDefault(); camManual(); }
  }

  // ══════════════════════════════════════════════════════════════════
  // BOOT
  // ══════════════════════════════════════════════════════════════════
  function boot() {
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('online', function () { S.offline = false; render(); });
    window.addEventListener('offline', function () { S.offline = true; render(); });
    // voltou pro app depois de um tempo: os números podem estar velhos
    document.addEventListener('visibilitychange', function () {
      if (document.hidden || !S.pin || !S.booted) return;
      loadBoot(true).catch(function () {});
    });

    S.pin = loadPin();
    render();
    if (S.pin) {
      loadBoot(true).then(function () { loadPrintSide(); }).catch(function () {});
    }
  }

  // exposto pro harness (e pra depurar no celular)
  window.HF_M = {
    state: S, render: render, api: api, toast: toast,
    _: {
      ageText: ageText, ageTone: ageTone, locBody: locBody, doneText: doneText,
      canWrite: canWrite, oneLine: oneLine, KIND_LABEL: KIND_LABEL, STATUS_LABEL: STATUS_LABEL,
      moveLabel: moveLabel, MOVE_LABEL: MOVE_LABEL,
      onScan: onScan, resolveCode: resolveCode, TABS: TABS,
    },
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
