'use strict';
/* ============================================================
   HEALTHFARE Operator · HUB DE ESTOQUE (/op/estoque.html). S15 Fase 3.

   O galpao inteiro numa tela de toque: Organizar, Contar (pesagem),
   Repor, Entrada de caixa nova, Devolucao, Danificada, e o celular
   pareado virando leitor de codigo de barras.

   Login = mesmo PIN do /op (POST /api/v3/op/auth/login com o page token
   do /op/config.js, igual src/print/print.js). A sessao fica no
   sessionStorage: fechou a aba, acabou.

   SCAN, tres caminhos, mesmo destino (dispatchScan):
     1. leitor USB → "digita" no #scanSink (sempre focado);
     2. celular pareado → SSE /api/v3/scan/stream?code=&t=<sessao> (fora do gate: EventSource nao manda header);
     3. busca manual → stock/lookup (REGRA #0: nunca trava o operador).

   Visual = STYLE-KIT inline (mesmos tokens do ws.js).
   PT-BR, sem em dash.

   Este arquivo NAO toca o DOM ao carregar: da pra exigir em node e testar
   os helpers puros (window.HF_EST._).
   ============================================================ */
(function (root, factory) {
  var EST = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = EST;
  if (root) {
    root.HF_EST = EST;
    if (root.document) EST.boot();
  }
}(typeof window !== 'undefined' ? window : null, function () {

  // ── tokens STYLE-KIT (identicos aos do ws.js) ───────────────
  var T = {
    ink: '#0d1f3c', ink2: '#1c2b3a', muted: '#54687c', mute2: '#6b7f92',
    line: '#d4e2f0', dot: '#c6d7e8', soft: '#f7fafd', green: '#2e8b3c',
    okBg: '#e8f7ea', okFg: '#1e6b2e', okLn: '#c8ecce',
    badBg: '#fdeeec', badFg: '#a02c20', badLn: '#f5cdc7',
    warnBg: '#fdf6e3', warnFg: '#6b4c07', warnLn: '#eeddad',
    neuBg: '#eaf0fb', neuFg: '#1a3a6b', neuLn: '#d4e2f0',
  };
  var MONO = '\'DM Mono\',monospace';
  var SORA = '\'Sora\',sans-serif';
  var SERIF = '\'DM Serif Display\',Georgia,serif';
  var CARD = 'background:#fff; border:1px solid ' + T.line + '; border-radius:18px; box-shadow:0 1px 2px rgba(13,31,60,.03),0 10px 30px rgba(13,31,60,.05);';
  var AC = '#1f5fd0';

  var API = '/api/v3/op/';
  var SS_KEY = 'hf_est_session';

  // ════════════════════════════════════════════════════════════
  // HELPERS PUROS (testaveis sem DOM)
  // ════════════════════════════════════════════════════════════

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function intOf(v) { var n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
  function numOf(v) {
    if (v == null || v === '') return null;
    var n = parseFloat(String(v).replace(',', '.'));   // operador digita 1234,5
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Que tipo de codigo e esse? Serve pro palpite LOCAL (o servidor decide de
   * verdade em scan/resolve); usamos pra dar retorno instantaneo na tela.
   *   A03B2 / A03 → bin      BX-0451 → box
   *   12 ou 13 digitos → upc (EAN/UPC de garrafa)
   *   URL /scan/... ou /op/... com bin=/box= → o que a query disser
   */
  function guessKind(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return 'unknown';
    var up = s.toUpperCase();
    // QR do nosso sistema: url com ?bin= / ?box= / ?p=
    var m = up.match(/[?&](BIN|BOX)=([A-Z0-9-]+)/);
    if (m) return m[1] === 'BIN' ? 'bin' : 'box';
    if (/^BX-?\d{3,}$/.test(up)) return 'box';
    if (/^[A-Z]\d{2}[A-Z]\d{1,2}$/.test(up)) return 'bin';   // A03B2
    if (/^[A-Z]\d{2}$/.test(up)) return 'bin';               // A03
    if (/^\d{12,14}$/.test(s)) return 'upc';
    if (/^\d{8}$/.test(s)) return 'upc';                     // EAN-8
    return 'sku';
  }

  /** Normaliza o que veio do leitor: tira espaco, Enter e o lixo do HID. */
  function normScan(raw) {
    return String(raw == null ? '' : raw).replace(/[\r\n\t]+/g, '').trim();
  }

  /**
   * PESAGEM → quantidade. A conta que o operador ve ANTES de confirmar
   * (o servidor refaz e e ele quem manda, mas o operador nao assina no escuro).
   *   liquido = bruto - tara ; qty = round(liquido / peso_unitario)
   *   sobra = |liquido - qty * peso_unitario|
   *
   * Confianca pela sobra. Como qty e ARREDONDADO, a sobra nunca passa de meia
   * garrafa: a razao sobra/unidade vive em 0..0.5, e as faixas seguem essa
   * escala (0.5 = em cima do muro entre duas contagens, o pior caso).
   *   ate 15% de uma garrafa = alta · ate 32% = media · acima = baixa.
   * Sem peso unitario nao da pra contar: qty null, confianca baixa.
   */
  function weighPreview(o) {
    var gross = numOf(o && o.gross_g);
    var tare = numOf(o && o.tare_g) || 0;
    var unit = numOf(o && o.unit_weight_g);
    var out = { gross_g: gross, tare_g: tare, unit_weight_g: unit, net_g: null, qty: null, residual_g: null, confidence: 'low' };
    if (gross == null) return out;
    var net = gross - tare;
    out.net_g = Math.round(net * 100) / 100;
    if (!unit || unit <= 0) return out;                     // sem peso unitario: so pesa, nao conta
    if (net <= 0) { out.qty = 0; out.residual_g = Math.round(Math.abs(net) * 100) / 100; out.confidence = net === 0 ? 'high' : 'low'; return out; }
    var qty = Math.round(net / unit);
    var residual = Math.abs(net - qty * unit);
    var ratio = residual / unit;
    out.qty = qty;
    out.residual_g = Math.round(residual * 100) / 100;
    out.confidence = ratio <= 0.15 ? 'high' : ratio <= 0.32 ? 'medium' : 'low';
    return out;
  }
  var CONF_LABEL = { high: 'confiança alta', medium: 'confiança média', low: 'confiança baixa' };
  function confChip(c) {
    if (c === 'high') return { label: CONF_LABEL.high, bg: T.okBg, fg: T.okFg, ln: T.okLn };
    if (c === 'medium') return { label: CONF_LABEL.medium, bg: T.warnBg, fg: T.warnFg, ln: T.warnLn };
    return { label: CONF_LABEL.low, bg: T.badBg, fg: T.badFg, ln: T.badLn };
  }

  /**
   * Tara de um local, na ORDEM que o Bruno pediu:
   *   1. a tara cadastrada no proprio bin/caixa (a mais confiavel: e AQUELA caixa);
   *   2. o preset que o operador escolheu (chips de stock/tasks.tares);
   *   3. o valor digitado na mao (ultimo recurso, mas nunca bloqueia: REGRA #0).
   * Devolve so o numero. Quem precisa saber DE ONDE veio usa tareSource().
   */
  function tareFor(target, preset, typed) {
    var t = target && numOf(target.tare_g);
    if (t != null && t > 0) return t;
    var p = preset && numOf(preset.tare_g);
    if (p != null && p > 0) return p;
    var d = numOf(typed);
    return d != null && d > 0 ? d : 0;
  }
  /** De onde veio a tara que esta valendo, pra tela poder DIZER. */
  function tareSource(target, preset, typed) {
    var t = target && numOf(target.tare_g);
    if (t != null && t > 0) return { from: 'target', g: t, label: 'cadastrada neste local' };
    var p = preset && numOf(preset.tare_g);
    if (p != null && p > 0) return { from: 'preset', g: p, label: String(preset.name || 'preset') };
    var d = numOf(typed);
    if (d != null && d > 0) return { from: 'typed', g: d, label: 'digitada por você' };
    return { from: 'none', g: 0, label: 'sem tara' };
  }
  /** Frase curta pro chip: "tara: caixa média 780 g". */
  function tareText(target, preset, typed) {
    var s = tareSource(target, preset, typed);
    if (s.from === 'none') return 'tara: nenhuma, peso cheio';
    return 'tara: ' + s.label + ' ' + s.g + ' g';
  }

  /** Nome curto de um bin/caixa (mesma regra do ws.js). */
  function placeLabel(p) {
    if (!p) return '';
    if (p.bin_code) return 'BIN ' + p.bin_code + (p.shelf_code ? ' · ' + p.shelf_code : '');
    if (p.box_number) return 'CAIXA ' + p.box_number + (p.area ? ' · ' + p.area : '');
    return String(p.id || '');
  }
  function targetLabel(t) {
    if (!t) return '';
    if (t.kind === 'bin') return placeLabel(t.bin);
    if (t.kind === 'box') return placeLabel(t.box);
    return '';
  }
  /** {bin_id} ou {box_id} pro corpo do POST (o contrato aceita um OU outro). */
  function targetBody(t) {
    if (!t) return {};
    if (t.kind === 'bin' && t.bin) return { bin_id: t.bin.id };
    if (t.kind === 'box' && t.box) return { box_id: t.box.id };
    return {};
  }

  /** Corpo do POST stock/organize. */
  function organizeBody(w) {
    var b = { product_id: w.product && w.product.id, qty: intOf(w.qty) };
    var t = targetBody(w.target);
    if (t.bin_id) b.bin_id = t.bin_id;
    if (t.box_id) b.box_id = t.box_id;
    return b;
  }
  function organizeError(w) {
    if (!w || !w.target || (w.target.kind !== 'bin' && w.target.kind !== 'box')) return 'Escaneie a prateleira ou a caixa onde vai guardar';
    if (!w.product) return 'Escaneie a garrafa ou busque o produto pelo nome';
    var q = intOf(w.qty);
    if (!q || q < 1) return 'Coloque quantas garrafas você guardou, pelo menos 1';
    if (q > 100000) return 'Quantidade alta demais. Confira o número';
    return null;
  }

  /** Corpo do POST stock/count/weigh. */
  function weighBody(w) {
    var b = { product_id: w.product && w.product.id, gross_g: numOf(w.gross) };
    var tare = tareFor(w.target && (w.target.bin || w.target.box), w.preset, w.tareTyped);
    if (tare) b.tare_g = tare;
    var t = targetBody(w.target);
    if (t.bin_id) b.bin_id = t.bin_id;
    if (t.box_id) b.box_id = t.box_id;
    return b;
  }
  /** Corpo do POST stock/count/manual (qty 0 = "esta vazio", permitido). */
  function manualBody(w, qty) {
    var q = qty == null ? intOf(w.qty) : intOf(qty);
    var b = { product_id: w.product && w.product.id, qty: q };
    var t = targetBody(w.target);
    if (t.bin_id) b.bin_id = t.bin_id;
    if (t.box_id) b.box_id = t.box_id;
    return b;
  }
  function countError(w, mode) {
    if (!w || !w.target || (w.target.kind !== 'bin' && w.target.kind !== 'box')) return 'Escaneie a prateleira ou a caixa que você contou';
    if (!w.product) return 'Diga qual produto está aí. Escaneie a garrafa ou busque pelo nome';
    if (mode === 'weigh') {
      var g = numOf(w.gross);
      if (g == null || g <= 0) return 'Coloque tudo na balança e digite o peso em gramas';
    } else {
      var q = intOf(w.qty);
      if (q == null || q < 0) return 'Digite quantas garrafas você contou';
    }
    return null;
  }

  /** Corpo do POST stock/box/new (entrada de caixa nova). */
  function boxNewBody(w) {
    var b = { product_id: w.product && w.product.id, qty: intOf(w.qty) };
    var lot = String(w.lot || '').trim();
    if (lot) b.batch_number = lot.slice(0, 60);
    var area = String(w.area || '').trim();
    if (area) b.area = area.slice(0, 40);
    return b;
  }
  function boxNewError(w) {
    if (!w || !w.product) return 'Escaneie uma garrafa da caixa ou busque o produto pelo nome';
    var q = intOf(w.qty);
    if (!q || q < 1) return 'Diga quantas garrafas tem na caixa';
    if (q > 100000) return 'Quantidade alta demais. Confira o número';
    return null;
  }

  /** Etiqueta de caixa: o que vai impresso (grande = numero, Code128, QR). */
  function labelPayload(d) {
    var x = d || {};
    var code = String(x.code || x.box_number || '');
    var line2 = x.line2 || x.product || '';
    var qty = x.qty == null ? null : intOf(x.qty);
    var lot = x.lot || x.batch_number || '';
    var line3 = x.line3 || ((qty != null ? qty + ' garrafas' : '') + (lot ? (qty != null ? ' · ' : '') + 'lote ' + lot : ''));
    return {
      kind: x.kind || 'box',
      code: code,
      line2: String(line2 || ''),
      line3: String(line3 || ''),
      url: x.url || ('/scan/?box=' + encodeURIComponent(code)),
    };
  }

  /** URL do SSE: a sessao vai na query (EventSource nao manda header). */
  function streamUrl(code, token) {
    return '/api/v3/scan/stream?code=' + encodeURIComponent(code || '') + '&t=' + encodeURIComponent(token || '');
  }

  var KIND_LABEL = {
    take: 'Peguei', pick: 'Peguei', damaged: 'Danificada', entrada: 'Caixa nova',
    count: 'Contagem', restock: 'Reposição', return_in: 'Devolução', organize: 'Organizou',
  };
  function kindLabel(k) { return KIND_LABEL[String(k || '')] || 'Registro'; }
  var STATUS_CHIP = {
    pending: { label: 'pendente', bg: T.warnBg, fg: T.warnFg, ln: T.warnLn },
    approved: { label: 'aprovado', bg: T.okBg, fg: T.okFg, ln: T.okLn },
    rejected: { label: 'recusado', bg: T.badBg, fg: T.badFg, ln: T.badLn },
    applied: { label: 'aplicado', bg: T.neuBg, fg: T.neuFg, ln: T.neuLn },
  };
  function statusChip(s) { return STATUS_CHIP[String(s || '').toLowerCase()] || STATUS_CHIP.applied; }

  // Telas do hub (Home + 6 acoes + pareamento)
  var SCREENS = ['home', 'organizar', 'contar', 'repor', 'entrada', 'devolucao', 'danificada', 'parear'];
  var MENU = [
    { k: 'organizar', title: 'Organizar', desc: 'Guardar garrafa na prateleira ou na caixa', icon: '📥' },
    { k: 'contar', title: 'Contar', desc: 'Conferir quantas tem numa prateleira', icon: '⚖️' },
    { k: 'repor', title: 'Repor', desc: 'Encher a prateleira com a caixa', icon: '🔄' },
    { k: 'entrada', title: 'Caixa nova', desc: 'Chegou da produção', icon: '📦' },
    { k: 'devolucao', title: 'Devolução', desc: 'Garrafa que voltou pra casa', icon: '↩️' },
    { k: 'danificada', title: 'Danificada', desc: 'Garrafa que não pode vender', icon: '⚠️' },
  ];

  // ════════════════════════════════════════════════════════════
  // ESTADO
  // ════════════════════════════════════════════════════════════
  var S = {
    screen: 'login', pin: '', pinError: '', shake: false, busy: false,
    session: null, person: null,
    scr: 'home',
    toastMsg: '', toastAt: 0,
    tasks: null, recent: null, ctx: null,
    lookup: { q: '', items: [], busy: false },
    org: { target: null, product: null, qty: '1' },
    cnt: { target: null, product: null, mode: 'weigh', gross: '', qty: '', preset: null, tareTyped: '', preview: null },
    ent: { product: null, qty: '', lot: '', area: '', lastBox: null },
    dev: { product: null, qty: '1', reason: '' },
    dan: { product: null, qty: '1', reason: '' },
    pair: { code: null, url: '', expires_at: null, connected: false, lastScan: '', error: '' },
    flash: 0,
  };

  var el = null;            // #hf-est
  var sink = null;          // #scanSink (leitor USB digita aqui)
  var es = null;            // EventSource do celular
  var keepTimer = null;

  // ════════════════════════════════════════════════════════════
  // API
  // ════════════════════════════════════════════════════════════
  function pageToken() {
    return (typeof window !== 'undefined' && window.HF_OP_CONFIG && window.HF_OP_CONFIG.pageToken) || '';
  }
  function api(path, opts) {
    var o = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    var pt = pageToken();
    if (pt) headers.Authorization = 'Bearer ' + pt;
    if (S.session) headers['X-Session-Token'] = S.session;
    var url = path.indexOf('/') === 0 ? path : API + path;
    return fetch(url, {
      method: o.method || 'GET',
      headers: headers,
      body: o.body ? JSON.stringify(o.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = new Error((j && (j.detail || j.error)) || ('HTTP ' + r.status));
          e.body = j; e.status = r.status;
          throw e;
        }
        return j;
      });
    });
  }

  function toast(msg) {
    S.toastMsg = String(msg || ''); S.toastAt = Date.now();
    render();
    setTimeout(function () {
      if (Date.now() - S.toastAt >= 3400) { S.toastMsg = ''; render(); }
    }, 3600);
  }

  // ════════════════════════════════════════════════════════════
  // FILA DE IMPRESSÃO DO CELULAR
  // O admin pede a etiqueta do iPhone; quem tem papel é que imprime. A lógica
  // mora em /shared/print-queue-card.js (a Central e a estação /print usam a
  // mesma), aqui só ligamos os fios da tela.
  // ════════════════════════════════════════════════════════════
  var queue = null;
  function PQ() { return (typeof window !== 'undefined' && window.HF_PRINT_QUEUE) || null; }
  function startQueue() {
    var M = PQ();
    if (!M || queue) return;
    queue = M.create({
      api: api,
      by: function () { return (S.person && (S.person.display_name || S.person.name)) || 'Estoque'; },
      // a aba do PDF das etiquetas de envio nao manda header: o token vai na query
      sessionToken: function () { return S.session || ''; },
      onChange: render,
      toast: toast,
      openWindow: function () { return window.open('', '_blank', 'width=520,height=760'); },
    });
    queue.start();
  }
  function stopQueue() { if (queue) { queue.stop(); queue = null; } }

  /* Cartão só aparece quando tem pedido esperando: tela cheia de caixa vazia
     ensina o operador a ignorar a tela. */
  /* Etiquetas de envio: o PDF abriu numa aba e o job fica ESPERANDO alguem
     dizer que o papel saiu (e o done que carimba printed_at). Sem esta faixa o
     job ficaria presvo aqui sem botao nenhum pra fechar. */
  function queueAwaitHtml() {
    var aw = queue && queue.awaiting;
    if (!aw) return '';
    return '<div style="' + CARD + ' padding:14px 18px; margin-bottom:16px; background:' + T.warnBg + '; border-color:' + T.warnLn + ';" data-card="print-await">'
      + '<div style="font-size:13.5px; font-weight:700; color:' + T.warnFg + '; margin-bottom:10px;">PDF aberto. Imprima na 4x6 e toque em J&aacute; imprimi.</div>'
      + '<div style="display:flex; gap:9px; flex-wrap:wrap; align-items:center;">'
      + btn('printJobDone', 'J&aacute; imprimi', '', 'border:0; cursor:pointer; border-radius:999px; min-height:48px; padding:0 24px; background:' + T.ink + '; color:#fff; font-weight:800; font-size:15px; font-family:' + SORA + ';')
      + btn('printJobFail', 'Deu erro', '', 'border:1px solid ' + T.badLn + '; cursor:pointer; border-radius:999px; min-height:48px; padding:0 20px; background:#fff; color:' + T.badFg + '; font-weight:700; font-size:14px; font-family:' + SORA + ';')
      + '<a href="' + esc(aw.url) + '" target="_blank" rel="noopener" style="font-size:12.5px; color:' + T.neuFg + '; font-weight:700;">abrir o PDF de novo</a>'
      + '</div></div>';
  }

  function queueHtml() {
    var M = PQ();
    if (!M || !queue || !queue.jobs.length) return '';
    var h = '<div style="' + CARD + ' padding:16px 20px; margin-bottom:16px; border-color:' + T.neuLn + ';" data-card="print-queue">'
      + '<div style="display:flex; align-items:center; gap:9px; margin-bottom:4px;">'
      + '<span style="font-size:18px;">🖨️</span>' + microLbl('Impressão pedida pelo celular') + '</div>'
      + '<div style="font-size:12.5px; color:' + T.muted + '; margin-bottom:8px;">Alguém pediu do celular e o papel sai aqui. Toque em Imprimir e tire da impressora.</div>';
    queue.jobs.forEach(function (j) {
      var n = M.jobCount(j);
      var note = M.stateNote(j);
      var can = M.isTakeable(j);
      var busy = String(queue.busy) === String(j.id);
      h += '<div style="border-top:1px dotted ' + T.dot + '; padding:10px 2px; display:flex; align-items:center; gap:9px; flex-wrap:wrap;" data-job="' + esc(j.id) + '">'
        + '<span style="flex:1; min-width:150px; font-size:13.5px; font-weight:700; color:' + T.ink2 + ';">' + esc(M.kindLabel(j.kind))
        + (n ? '<span style="font-family:' + MONO + '; font-size:11.5px; color:' + T.mute2 + '; font-weight:600; margin-left:7px;">' + n + (n === 1 ? ' folha' : ' folhas') + '</span>' : '')
        + '</span>'
        + chip(esc(j.requested_by || 'admin'), T.neuBg, T.neuFg, T.neuLn)
        + chip(esc(M.ageText(j.age_min)), T.neuBg, T.mute2, T.neuLn)
        + (j.is_test ? chip('teste', T.warnBg, T.warnFg, T.warnLn) : '')
        + (can
          ? btn('printJob', busy ? 'Imprimindo&hellip;' : esc(M.actionLabel(j)), esc(j.id),
            'border:0; cursor:pointer; border-radius:999px; min-height:46px; padding:0 22px; background:' + T.ink + '; color:#fff; font-weight:800; font-size:14px; font-family:' + SORA + ';')
          : chip('imprimindo', T.warnBg, T.warnFg, T.warnLn))
        + (note ? '<div style="width:100%; font-size:12px; color:' + T.mute2 + ';">' + esc(note) + '</div>' : '')
        + '</div>';
    });
    return h + '</div>';
  }

  // ════════════════════════════════════════════════════════════
  // LOGIN (PIN igual ao /op e ao /print)
  // ════════════════════════════════════════════════════════════
  function saveSession() {
    try {
      sessionStorage.setItem(SS_KEY, JSON.stringify({ t: S.session, p: S.person }));
    } catch (e) { /* modo privado: segue sem persistir */ }
  }
  function loadSession() {
    try {
      var raw = sessionStorage.getItem(SS_KEY);
      if (!raw) return false;
      var j = JSON.parse(raw);
      if (j && j.t) { S.session = j.t; S.person = j.p || null; return true; }
    } catch (e) {}
    return false;
  }
  function clearSession() {
    S.session = null; S.person = null;
    try { sessionStorage.removeItem(SS_KEY); } catch (e) {}
  }

  function submitPin() {
    if (S.busy) return;
    S.busy = true; render();
    api('auth/login', { method: 'POST', body: { pin: S.pin } })
      .then(function (j) {
        var tok = j && (j.session_token || j.token);
        if (!tok) throw new Error('PIN incorreto');
        S.session = tok; S.person = j.person || null;
        S.busy = false; S.pin = ''; S.pinError = ''; S.screen = 'hub'; S.scr = 'home';
        saveSession(); render(); loadAll(); startQueue(); focusSink();
      })
      .catch(function (e) {
        S.busy = false; S.pin = '';
        S.pinError = e && e.status === 429 ? 'Muitas tentativas. Espere um minuto e tente de novo.' : 'PIN errado. Tente de novo.';
        S.shake = true; render();
        setTimeout(function () { S.shake = false; render(); }, 420);
      });
  }

  function logout() {
    api('auth/logout', { method: 'POST', body: {} }).catch(function () {});
    stopStream();
    stopQueue();
    clearSession();
    S.screen = 'login'; S.pin = ''; S.scr = 'home';
    render();
  }

  // ════════════════════════════════════════════════════════════
  // DADOS
  // ════════════════════════════════════════════════════════════
  function loadAll() { loadTasks(); loadRecent(); loadContext(); }
  function loadTasks() {
    return api('stock/tasks').then(function (j) { S.tasks = j || {}; render(); })
      .catch(function () { S.tasks = { counts: [], restock: [], organize: [] }; render(); });
  }
  function loadRecent() {
    return api('stock/recent').then(function (j) { S.recent = (j && j.items) || []; render(); })
      .catch(function () { S.recent = []; render(); });
  }
  function loadContext() {
    return api('stock/context').then(function (j) { S.ctx = j || { bins: [], boxes: [] }; render(); })
      .catch(function () { S.ctx = { enabled: false, bins: [], boxes: [] }; render(); });
  }

  var lookupTimer = null;
  function doLookup(q) {
    S.lookup.q = q;
    if (lookupTimer) clearTimeout(lookupTimer);
    if (!q || q.trim().length < 2) { S.lookup.items = []; render(); return; }
    lookupTimer = setTimeout(function () {
      S.lookup.busy = true;
      api('stock/lookup?q=' + encodeURIComponent(q.trim()))
        .then(function (j) {
          S.lookup.busy = false;
          S.lookup.items = (j && (j.products || j.items)) || [];
          render();
        })
        .catch(function () { S.lookup.busy = false; S.lookup.items = []; render(); });
    }, 220);
  }

  // ════════════════════════════════════════════════════════════
  // SCAN · o coracao do hub
  // ════════════════════════════════════════════════════════════

  /**
   * Um codigo chegou (leitor USB, celular pareado ou digitado).
   * Pergunta ao servidor o que e (scan/resolve) e joga na tela ATIVA.
   */
  function dispatchScan(raw) {
    var code = normScan(raw);
    if (!code) return Promise.resolve(null);
    S.flash = Date.now(); render();
    return api('scan/resolve?barcode=' + encodeURIComponent(code))
      .then(function (j) { applyResolved(j || {}, code); return j; })
      .catch(function () {
        // servidor fora do ar nao pode travar o operador (REGRA #0):
        // usa o palpite local e deixa ele seguir pela busca manual.
        applyResolved({ ok: false, kind: guessKind(code) }, code);
        return null;
      });
  }

  /** Resultado do resolve → estado da tela ativa. */
  function applyResolved(j, code) {
    var kind = j && j.kind;
    var scr = S.scr;
    if (kind === 'bin' || kind === 'box') {
      var target = { kind: kind, bin: j.bin || null, box: j.box || null };
      if (scr === 'organizar') { S.org.target = target; }
      else if (scr === 'contar') { S.cnt.target = target; S.cnt.preview = null; autoProductFor(target, 'cnt'); }
      else { S.scr = 'organizar'; S.org.target = target; }
      toast(targetLabel(target) + ' selecionada');
    } else if (kind === 'product' && j.product) {
      setProduct(j.product);
      toast(j.product.nickname || j.product.name || j.product.canonical_name || 'Produto');
    } else {
      S.lookup.q = code;
      doLookup(code);
      toast('Não conheço o código ' + code + '. Busque o produto pelo nome ali em cima.');
    }
    render();
  }

  /**
   * Bin/caixa ja tem produto cadastrado? Entao adianta o passo.
   *
   * O peso da garrafa mora no PRODUTO, nao na prateleira: a linha do bin quase
   * nunca traz unit_weight_g. Sem ele a pesagem nao calcula nada, entao aqui a
   * gente completa pelo catalogo do stock/context (e, se ainda faltar, pergunta
   * ao servidor pelo lookup). Sem isso o operador escaneia o bin e ve
   * "sem peso da garrafa" mesmo com o produto cadastrado.
   */
  function autoProductFor(target, slot) {
    var src = target && (target.bin || target.box);
    if (!src || src.product_id == null) return;
    var p = { id: src.product_id, name: src.product || src.product_name || '', nickname: src.nickname || null,
      unit_weight_g: src.unit_weight_g == null ? null : src.unit_weight_g };
    S[slot].product = enrichProduct(p);
    if (slot === 'cnt') {
      recompute();
      if (S[slot].product.unit_weight_g == null) fetchWeight(S[slot].product, slot);
    }
  }

  /** Completa o produto com o que o catalogo local ja sabe (peso, apelido). */
  function enrichProduct(p) {
    if (!p || p.id == null) return p;
    var cat = (S.ctx && S.ctx.products) || [];
    var hit = cat.find(function (x) { return intOf(x.id) === intOf(p.id); });
    if (!hit) return p;
    return {
      id: p.id,
      name: p.name || hit.name || hit.canonical_name || '',
      nickname: p.nickname || hit.nickname || null,
      unit_weight_g: p.unit_weight_g == null ? (hit.unit_weight_g == null ? null : hit.unit_weight_g) : p.unit_weight_g,
    };
  }

  /** Ultimo recurso: pergunta o peso da garrafa ao servidor (busca por nome). */
  function fetchWeight(p, slot) {
    if (!p || !p.name) return;
    api('stock/lookup?q=' + encodeURIComponent(p.name))
      .then(function (j) {
        var list = (j && (j.products || j.items)) || [];
        var hit = list.find(function (x) { return intOf(x.id) === intOf(p.id); });
        if (!hit || hit.unit_weight_g == null) return;
        if (!S[slot].product || intOf(S[slot].product.id) !== intOf(p.id)) return;   // operador ja trocou
        S[slot].product.unit_weight_g = hit.unit_weight_g;
        if (slot === 'cnt') recompute();
        render();
      })
      .catch(function () { /* sem peso: a tela ja oferece contar na mao */ });
  }

  /** Produto escolhido vai pra tela ativa (sempre completado com o peso). */
  function setProduct(raw) {
    var p = enrichProduct(raw);
    var scr = S.scr;
    if (scr === 'organizar') S.org.product = p;
    else if (scr === 'contar') { S.cnt.product = p; recompute(); }
    else if (scr === 'entrada') S.ent.product = p;
    else if (scr === 'devolucao') S.dev.product = p;
    else if (scr === 'danificada') S.dan.product = p;
    else { S.scr = 'organizar'; S.org.product = p; }
    S.lookup.q = ''; S.lookup.items = [];
  }

  function recompute() {
    var w = S.cnt;
    var target = w.target && (w.target.bin || w.target.box);
    S.cnt.preview = weighPreview({
      gross_g: w.gross,
      tare_g: tareFor(target, w.preset, w.tareTyped),
      unit_weight_g: w.product && w.product.unit_weight_g,
    });
  }

  // ── celular pareado ─────────────────────────────────────────
  function pairPhone() {
    if (S.busy) return;
    S.busy = true; render();
    api('scan/pair', { method: 'POST', body: {} })
      .then(function (j) {
        S.busy = false;
        S.pair.code = j && j.code;
        S.pair.url = (j && j.url) || ('/scan/?c=' + (j && j.code));
        S.pair.expires_at = j && j.expires_at;
        S.pair.error = '';
        S.scr = 'parear';
        render();
        startStream();
      })
      .catch(function (e) {
        S.busy = false;
        S.pair.error = 'Não consegui gerar o código agora. Tente de novo, ou use o leitor de mão.';
        S.scr = 'parear'; render();
      });
  }

  function startStream() {
    stopStream();
    if (!S.pair.code || typeof EventSource === 'undefined') return;
    try {
      es = new EventSource(streamUrl(S.pair.code, S.session));
    } catch (e) { return; }
    es.onopen = function () { S.pair.connected = true; render(); };
    es.onerror = function () { S.pair.connected = false; render(); };
    es.onmessage = function (ev) {
      var d = null;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (!d) return;
      if (d.type === 'scan' && d.code) {
        S.pair.connected = true;
        S.pair.lastScan = d.code;
        dispatchScan(d.code);
      } else if (d.type === 'hello' || d.type === 'ping') {
        S.pair.connected = true; render();
      }
    };
    // renova o par (15 min) enquanto a tela estiver aberta
    if (keepTimer) clearInterval(keepTimer);
    keepTimer = setInterval(function () {
      if (!S.pair.code) return;
      api('scan/keepalive', { method: 'POST', body: { code: S.pair.code } }).catch(function () {});
    }, 60000);
  }
  function stopStream() {
    if (es) { try { es.close(); } catch (e) {} es = null; }
    if (keepTimer) { clearInterval(keepTimer); keepTimer = null; }
    S.pair.connected = false;
  }

  // ════════════════════════════════════════════════════════════
  // ACOES (POSTs)
  // ════════════════════════════════════════════════════════════
  function post(path, body, okMsg, after) {
    if (S.busy) return;
    S.busy = true; render();
    api(path, { method: 'POST', body: body })
      .then(function (j) {
        S.busy = false;
        toast(okMsg);
        if (after) after(j);
        loadRecent(); loadTasks();
        render();
      })
      .catch(function (e) {
        S.busy = false;
        toast(actionError(e));
        render();
      });
  }

  /**
   * Erro de ação vira instrução, nunca código (REGRA #0: o operador tem que
   * saber o que fazer AGORA). Só o 4xx com mensagem do servidor aparece
   * inteiro: ali o backend já explica o que falta.
   */
  function actionError(e) {
    var st = e && e.status;
    if (st === 401 || st === 403) return 'Sua sessão caiu. Digite o PIN de novo pra continuar.';
    if (st === 409) return 'Alguém registrou isso antes de você. Volte e confira em Registrado hoje.';
    if (st === 429) return 'Muitos registros seguidos. Espere alguns segundos e mande de novo.';
    if (st >= 500) return 'O sistema não respondeu. Espere um pouco e mande de novo. Nada foi perdido.';
    if (st == null) return 'Sem internet aqui. Confira a rede e mande de novo.';
    var m = e && e.message ? String(e.message) : '';
    return m && !/^HTTP\s/.test(m) ? m : 'Não deu pra registrar. Tente de novo.';
  }

  function submitOrganize() {
    var err = organizeError(S.org);
    if (err) { toast(err); return; }
    post('stock/organize', organizeBody(S.org), 'Guardado em ' + targetLabel(S.org.target) + '. Já está no sistema.', function () {
      S.org = { target: null, product: null, qty: '1' };
      loadContext();
    });
  }
  function submitWeigh() {
    var err = countError(S.cnt, 'weigh');
    if (err) { toast(err); return; }
    post('stock/count/weigh', weighBody(S.cnt), 'Contagem enviada. O admin aprova e o número muda.', function () {
      S.cnt = { target: null, product: null, mode: 'weigh', gross: '', qty: '', preset: S.cnt.preset, tareTyped: S.cnt.tareTyped, preview: null };
    });
  }
  function submitManual(qty) {
    var err = countError(S.cnt, 'manual');
    if (qty === 0) {
      err = S.cnt.target && S.cnt.product ? null
        : (S.cnt.target ? 'Diga qual produto está aí. Escaneie a garrafa ou busque pelo nome'
          : 'Escaneie a prateleira ou a caixa que você contou');
    }
    if (err) { toast(err); return; }
    post('stock/count/manual', manualBody(S.cnt, qty),
      qty === 0 ? 'Marcado como vazio. O admin aprova e o número zera.' : 'Contagem enviada. O admin aprova e o número muda.', function () {
      S.cnt = { target: null, product: null, mode: 'weigh', gross: '', qty: '', preset: S.cnt.preset, tareTyped: S.cnt.tareTyped, preview: null };
    });
  }
  function submitEntrada() {
    var err = boxNewError(S.ent);
    if (err) { toast(err); return; }
    post('stock/box/new', boxNewBody(S.ent), 'Caixa enviada. O admin aprova e sai o número da caixa.', function (j) {
      S.ent.lastBox = j && (j.request_id || j.box_number) ? j : null;
      S.ent = { product: null, qty: '', lot: '', area: '', lastBox: S.ent.lastBox };
    });
  }
  function submitDevolucao() {
    if (!S.dev.product) { toast('Escaneie a garrafa ou busque o produto pelo nome'); return; }
    var q = intOf(S.dev.qty);
    if (!q || q < 1) { toast('Coloque quantas garrafas voltaram, pelo menos 1'); return; }
    post('stock/propose', {
      product_id: S.dev.product.id, kind: 'return_in', qty: q,
      reason: String(S.dev.reason || '').trim() || null,
    }, 'Devolução enviada. O admin aprova e ela volta pro estoque.', function () {
      S.dev = { product: null, qty: '1', reason: '' };
    });
  }
  function submitDanificada() {
    if (!S.dan.product) { toast('Escaneie a garrafa ou busque o produto pelo nome'); return; }
    var q = intOf(S.dan.qty);
    if (!q || q < 1) { toast('Coloque quantas garrafas estão danificadas, pelo menos 1'); return; }
    post('stock/take', {
      product_id: S.dan.product.id, kind: 'damaged', qty: q,
      reason: String(S.dan.reason || '').trim() || null,
    }, 'Registrado. Já saiu do vendável e foi pra Separadas.', function () {
      S.dan = { product: null, qty: '1', reason: '' };
    });
  }
  function doRestock(binId, boxId) {
    var ctx = S.ctx || {};
    var bin = (ctx.bins || []).find(function (b) { return b.id === binId; });
    var box = (ctx.boxes || []).find(function (x) { return x.id === boxId; });
    if (!bin || !box) { toast('Esse local sumiu da lista. Volte pro hub e entre em Repor de novo.'); return; }
    var binQty = Math.max(0, intOf(bin.qty) || 0);
    var min = intOf(bin.min_qty) || 0;
    var target = (min * 2) || 48;
    var qty = Math.min(Math.max(0, intOf(box.qty) || 0), Math.max(1, target - binQty));
    post('stock/restock', { bin_id: bin.id, box_id: box.id, qty: qty },
      'Prateleira reposta. Saiu da caixa e entrou na prateleira.', function () {
      loadContext();
    });
  }

  // ── etiqueta 4x6 da caixa ───────────────────────────────────
  function printLabel(boxId) {
    api('stock/box/label?box_id=' + encodeURIComponent(boxId))
      .then(function (j) { openLabel(labelPayload((j && (j.label || j.data)) || j)); })
      .catch(function () { toast('A etiqueta ainda não está pronta. Ela sai depois que o admin aprovar a caixa.'); });
  }
  /* O DESENHO da etiqueta mora em /shared/label-sheet.js: um renderizador só
     pro hub, pra Central, pra estação /print e pra fila do celular. Duas cópias
     do mesmo papel viram duas etiquetas diferentes da mesma caixa. */
  function openLabel(L) {
    var HL = (typeof window !== 'undefined' && window.HF_LABELS) || null;
    if (!HL) { toast('O desenho da etiqueta não carregou. Recarregue a página e tente de novo.'); return; }
    var win = window.open('', '_blank', 'width=520,height=760');
    if (!win) { toast('O navegador bloqueou a janela. Libere os popups deste site e clique de novo.'); return; }
    win.document.write(HL.sheetHtml([L], { title: 'Etiqueta ' + String(L && L.code || '') }));
    win.document.close();
  }

  // ════════════════════════════════════════════════════════════
  // HTML
  // ════════════════════════════════════════════════════════════
  function microLbl(t) {
    return '<div style="font-family:' + MONO + '; font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:' + T.mute2 + '; font-weight:600;">' + t + '</div>';
  }
  function chip(txt, bg, fg, ln) {
    return '<span style="height:20px; display:inline-flex; align-items:center; padding:0 9px; border-radius:999px; font-family:' + MONO + '; font-size:10.5px; background:' + bg + '; color:' + fg + '; box-shadow:inset 0 0 0 1px ' + ln + ';">' + txt + '</span>';
  }
  function btn(act, label, arg, style) {
    return '<button data-act="' + act + '"' + (arg != null ? ' data-arg="' + esc(arg) + '"' : '') + ' style="' + (style || '') + '">' + label + '</button>';
  }
  var PILL = 'border:0; cursor:pointer; border-radius:999px; height:52px; padding:0 26px; background:' + T.ink + '; color:#fff; font-weight:800; font-size:16px; font-family:' + SORA + '; box-shadow:0 14px 30px -14px rgba(13,31,60,.6);';
  var GHOST = 'border:1px solid ' + T.line + '; background:#fff; cursor:pointer; border-radius:999px; min-height:46px; padding:0 22px; font-weight:700; font-size:14px; color:' + T.ink2 + '; font-family:' + SORA + ';';
  var INPUT = 'width:100%; box-sizing:border-box; padding:13px 15px; border-radius:12px; border:1px solid ' + T.line + '; font-size:16px; background:' + T.soft + '; color:' + T.ink2 + '; outline:none;';

  // ── login ───────────────────────────────────────────────────
  function loginHtml() {
    var dots = '';
    for (var i = 0; i < 4; i++) {
      var on = S.pin.length > i;
      dots += '<div style="width:16px; height:16px; border-radius:50%; transition:all .2s; background:' + (on ? AC : 'transparent') + '; border:2px solid ' + (on ? AC : 'rgba(15,40,90,.28)') + '; transform:' + (on ? 'scale(1.18)' : 'scale(1)') + ';"></div>';
    }
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'], kp = '';
    keys.forEach(function (k) {
      var isOk = k === '✓', isDel = k === '⌫';
      var base = 'aspect-ratio:1; border-radius:50%; cursor:pointer; font-family:' + SORA + '; font-weight:700; font-size:clamp(22px,3vw,28px); display:flex; align-items:center; justify-content:center; min-height:0;';
      var st = isOk ? base + 'border:0; color:#fff; background:linear-gradient(135deg,#19c277,' + AC + ');'
        : isDel ? base + 'border:1px solid rgba(15,40,90,.12); color:#6c819b; background:rgba(255,255,255,.6);'
          : base + 'border:1px solid ' + T.line + '; color:' + T.ink + '; background:#fff;';
      kp += '<button data-act="pinkey" data-arg="' + k + '" style="' + st + '">' + k + '</button>';
    });
    return '<div style="min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px;">'
      + '<div style="width:min(94vw,420px); ' + CARD + ' padding:34px 30px; text-align:center;' + (S.shake ? ' animation:hfShake .4s;' : '') + '">'
      + '<img src="/op/assets/healthfare-logo.png" alt="HealthFare" style="height:52px; width:auto; margin:0 auto 8px;">'
      + '<div style="font-family:' + MONO + '; font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:' + T.green + '; font-weight:600;">HealthFare</div>'
      + '<div style="font-family:' + SERIF + '; font-size:29px; color:' + T.ink + '; line-height:1.1; margin-bottom:18px;">Hub de <em style="color:' + T.green + ';">Estoque</em></div>'
      + '<div style="display:flex; justify-content:center; gap:16px; margin-bottom:10px;">' + dots + '</div>'
      + '<div style="min-height:22px; color:' + T.badFg + '; font-weight:700; font-size:14px; margin-bottom:12px;">' + esc(S.pinError) + '</div>'
      + '<div style="display:grid; grid-template-columns:repeat(3,1fr); gap:13px; max-width:320px; margin:0 auto;">' + kp + '</div>'
      + '<div style="margin-top:20px; font-size:12.5px; color:' + T.muted + ';">Toque seu PIN de 4 dígitos</div>'
      + '</div></div>';
  }

  // ── cabecalho do hub ────────────────────────────────────────
  /* Mesmo menu do /op (fonte unica em /op/nav.js): marca da casa, as 3 abas,
     quem esta logado e Sair. O operador ve a MESMA barra nas duas telas. */
  function navStrip() {
    var NAV = (typeof window !== 'undefined' && window.HF_NAV) || null;
    return NAV ? NAV.strip('estoque', { page: 'hub' }) : '';
  }
  function headerHtml() {
    var who = S.person ? (S.person.display_name || '') : '';
    var connected = S.pair.connected;
    return '<div style="padding:16px 26px 10px;">'
      + '<div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:12px;">'
      + '<img src="/op/assets/healthfare-logo.png" alt="HealthFare" style="height:30px; width:auto;">'
      + navStrip()
      + '<span style="flex:1; min-width:0;"></span>'
      + chip(connected ? 'celular conectado' : 'sem celular', connected ? T.okBg : T.neuBg, connected ? T.okFg : T.mute2, connected ? T.okLn : T.neuLn)
      + (who ? '<span style="font-size:13px; color:' + T.muted + '; font-weight:600;">' + esc(who) + '</span>' : '')
      + btn('logout', 'Sair', null, GHOST)
      + '</div>'
      + '<div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">'
      + (S.scr === 'home' ? '' : btn('go', '&larr; Voltar', 'home', GHOST))
      + '<div style="flex:1; min-width:180px;">'
      + '<div style="font-family:' + MONO + '; font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:' + T.green + '; font-weight:600;">&#9679; HealthFare &middot; Estoque</div>'
      + '<div style="font-family:' + SERIF + '; font-size:28px; color:' + T.ink + '; line-height:1.05;">' + screenTitle() + '</div>'
      + '<div style="font-size:13px; color:' + T.muted + '; margin-top:3px;">' + screenSub() + '</div>'
      + '</div>'
      + '</div></div>';
  }
  function screenTitle() {
    var m = { home: 'Hub de <em style="color:' + T.green + ';">Estoque</em>',
      organizar: '<em style="color:' + T.green + ';">Organizar</em>',
      contar: '<em style="color:' + T.green + ';">Contar</em>',
      repor: '<em style="color:' + T.green + ';">Repor</em>',
      entrada: '<em style="color:' + T.green + ';">Caixa nova</em>',
      devolucao: '<em style="color:' + T.green + ';">Devolução</em>',
      danificada: '<em style="color:' + T.green + ';">Danificada</em>',
      parear: 'Parear <em style="color:' + T.green + ';">celular</em>' };
    return m[S.scr] || m.home;
  }
  /** Uma linha respondendo "o que eu faço aqui?" (REGRA: toda tela explica). */
  function screenSub() {
    var m = {
      home: 'Escolha o que você vai fazer agora no estoque.',
      organizar: 'Guardar garrafa que ainda não tem lugar, na prateleira ou na caixa.',
      contar: 'Conferir quantas garrafas tem mesmo numa prateleira ou caixa.',
      repor: 'Tirar da caixa e encher a prateleira que está acabando.',
      entrada: 'Registrar uma caixa que acabou de chegar da produção.',
      devolucao: 'Garrafa que voltou de um cliente e chegou de volta aqui.',
      danificada: 'Garrafa quebrada, com rótulo ruim ou sem lacre.',
      parear: 'Use a câmera do celular como leitor de código desta tela.',
    };
    return m[S.scr] || m.home;
  }

  /** Barra de scan: o leitor USB digita aqui, e da pra buscar pelo nome. */
  function scanBarHtml(placeholder) {
    var h = '<div style="' + CARD + ' padding:14px 18px; margin-bottom:16px;">'
      + '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">'
      + '<span style="font-size:20px;">🔍</span>'
      + '<input data-input="lookup" value="' + esc(S.lookup.q || '') + '" placeholder="' + esc(placeholder || 'Escaneie ou digite o nome do produto') + '" style="' + INPUT + ' flex:1; min-width:200px; width:auto;">'
      + (S.pair.connected ? chip('celular conectado', T.okBg, T.okFg, T.okLn) : btn('pair', 'Parear celular', null, GHOST))
      + '</div>';
    if (S.lookup.busy) h += '<div style="color:' + T.mute2 + '; font-size:12.5px; padding:8px 2px;">buscando&hellip;</div>';
    (S.lookup.items || []).slice(0, 8).forEach(function (p) {
      h += '<button data-act="pickProduct" data-arg="' + esc(p.id) + '" style="display:block; width:100%; text-align:left; border:0; background:none; cursor:pointer; border-bottom:1px dotted ' + T.dot + '; min-height:48px; padding:11px 4px; font-size:15px; font-weight:600; color:' + T.ink2 + ';">'
        + esc(p.nickname || p.name || p.canonical_name || '')
        + (p.unit_weight_g ? '<span style="font-family:' + MONO + '; font-size:11px; color:' + T.mute2 + '; margin-left:8px;">' + p.unit_weight_g + ' g por garrafa</span>' : '')
        + '</button>';
    });
    if ((S.lookup.q || '').trim().length >= 2 && !S.lookup.busy && !(S.lookup.items || []).length) {
      h += '<div style="color:' + T.mute2 + '; font-size:12.5px; padding:8px 2px;">Nenhum produto com "' + esc(S.lookup.q) + '". Tente outro pedaço do nome.</div>';
    }
    return h + '</div>';
  }

  function productCard(p, clearAct) {
    if (!p) return '';
    return '<div style="display:flex; align-items:center; gap:10px; background:' + T.soft + '; border:1px solid ' + T.line + '; border-radius:12px; padding:11px 14px; margin-bottom:12px;">'
      + '<div style="flex:1; min-width:0;"><div style="font-family:' + SERIF + '; font-size:19px; color:' + T.ink + ';">' + esc(p.nickname || p.name || p.canonical_name || '') + '</div>'
      + (p.unit_weight_g ? '<div style="font-family:' + MONO + '; font-size:11px; color:' + T.mute2 + ';">' + p.unit_weight_g + ' g por garrafa</div>' : '')
      + '</div>'
      + btn(clearAct, 'trocar', null, 'border:0; background:none; cursor:pointer; color:' + T.mute2 + '; font-size:13px; font-weight:700; min-height:44px; padding:0 10px;')
      + '</div>';
  }
  /**
   * Cartão do local escolhido.
   *
   * CONTAGEM CEGA (S15 §11, regra do Bruno): na tela de Contar o operador NUNCA
   * pode ver quanto o sistema acha que tem ali, senão ele "conta" o número da
   * tela em vez de contar as garrafas, e a contagem deixa de valer. Por isso a
   * quantidade guardada só aparece onde ela ajuda sem contaminar (Organizar),
   * e nunca antes de confirmar uma contagem.
   */
  function targetCard(t, clearAct, showQty) {
    if (!t) return '';
    var src = t.bin || t.box || {};
    return '<div style="display:flex; align-items:center; gap:10px; background:' + T.neuBg + '; border:1px solid ' + T.neuLn + '; border-radius:12px; padding:11px 14px; margin-bottom:12px;">'
      + '<span style="font-size:19px;">' + (t.kind === 'bin' ? '🗄️' : '📦') + '</span>'
      + '<div style="flex:1; min-width:0;"><div style="font-family:' + MONO + '; font-size:15px; font-weight:700; color:' + T.ink + ';">' + esc(targetLabel(t)) + '</div>'
      + (src.product ? '<div style="font-size:12.5px; color:' + T.muted + ';">' + esc(src.product) + '</div>' : '')
      + (showQty && src.qty != null ? '<div style="font-family:' + MONO + '; font-size:11px; color:' + T.mute2 + ';">já tem ' + src.qty + ' aqui</div>' : '')
      + '</div>'
      + btn(clearAct, 'trocar', null, 'border:0; background:none; cursor:pointer; color:' + T.mute2 + '; font-size:13px; font-weight:700; min-height:44px; padding:0 10px;')
      + '</div>';
  }
  function qtyStepper(act, val, unit) {
    return '<div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">'
      + btn(act + 'Delta', '&minus;', '-1', 'border:1px solid ' + T.line + '; background:#fff; cursor:pointer; border-radius:12px; width:56px; height:56px; font-size:26px; color:' + T.ink + ';')
      + '<input data-input="' + act + '" inputmode="numeric" value="' + esc(String(val == null ? '' : val)) + '" style="width:100px; text-align:center; padding:13px 0; border-radius:12px; border:1px solid ' + T.line + '; font-size:24px; font-weight:800; color:' + T.ink + '; background:#fff;">'
      + btn(act + 'Delta', '+', '1', 'border:1px solid ' + T.line + '; background:#fff; cursor:pointer; border-radius:12px; width:56px; height:56px; font-size:24px; color:' + T.ink + ';')
      + '<span style="font-size:13px; color:' + T.muted + ';">' + esc(unit || 'garrafas') + '</span></div>';
  }

  // ── HOME ────────────────────────────────────────────────────
  function homeHtml() {
    var h = scanBarHtml('Escaneie a prateleira, a caixa ou o produto');
    h += queueAwaitHtml();
    h += queueHtml();
    h += day1Html();
    h += '<div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(215px,1fr)); gap:14px; margin-bottom:20px;">';
    MENU.forEach(function (m) {
      h += '<button data-act="go" data-arg="' + m.k + '" style="' + CARD + ' text-align:left; cursor:pointer; padding:18px; display:flex; flex-direction:column; gap:6px; min-height:112px;">'
        + '<span style="font-size:28px;">' + m.icon + '</span>'
        + '<span style="font-family:' + SORA + '; font-weight:800; font-size:17px; color:' + T.ink + ';">' + m.title + '</span>'
        + '<span style="font-size:12.5px; color:' + T.muted + '; line-height:1.3;">' + m.desc + '</span>'
        + '</button>';
    });
    h += '<button data-act="pair" style="' + CARD + ' text-align:left; cursor:pointer; padding:18px; display:flex; flex-direction:column; gap:6px; min-height:112px; border-color:' + (S.pair.connected ? T.okLn : T.line) + ';">'
      + '<span style="font-size:28px;">📱</span>'
      + '<span style="font-family:' + SORA + '; font-weight:800; font-size:17px; color:' + T.ink + ';">Parear celular</span>'
      + '<span style="font-size:12.5px; color:' + T.muted + '; line-height:1.3;">' + (S.pair.connected ? 'Conectado, pode escanear' : 'Usar a câmera como leitor') + '</span>'
      + '</button>';
    h += '</div>';
    // ponte discreta pro outro lado do sistema: quem entrou aqui e precisa da
    // picklist nao pode ficar procurando onde clicar.
    var NAV = (typeof window !== 'undefined' && window.HF_NAV) || null;
    if (NAV) h += '<div style="margin:-6px 0 18px;">' + NAV.crossLink() + '</div>';
    h += '<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:16px;">'
      + tasksHtml() + recentHtml() + '</div>';
    return h;
  }

  /**
   * Dia 1: nenhuma prateleira e nenhuma caixa cadastrada. Sem isso o operador
   * escaneia e nada acontece, e ele acha que o sistema está quebrado. Aqui a
   * tela DIZ o que falta e de quem depende (o admin cadastra em Locais).
   * Só aparece quando o contexto já chegou e veio mesmo vazio.
   */
  function day1Html() {
    if (!S.ctx) return '';
    var bins = S.ctx.bins || [], boxes = S.ctx.boxes || [];
    if (bins.length || boxes.length) return '';
    return '<div style="' + CARD + ' padding:18px 22px; margin-bottom:16px; border-color:' + T.warnLn + '; background:' + T.warnBg + ';">'
      + '<div style="font-family:' + SORA + '; font-weight:800; font-size:16px; color:' + T.warnFg + '; margin-bottom:4px;">Nada cadastrado ainda</div>'
      + '<div style="font-size:13.5px; color:' + T.warnFg + '; line-height:1.45;">O admin precisa cadastrar as prateleiras e as caixas em Locais. '
      + 'Enquanto isso não acontece, dá pra registrar Caixa nova, Devolução e Danificada normalmente.</div>'
      + '</div>';
  }

  function tasksHtml() {
    var h = '<div style="' + CARD + ' padding:16px 20px;">' + microLbl('Tarefas de hoje');
    if (!S.tasks) return h + '<div style="color:' + T.mute2 + '; font-size:12.5px; margin-top:8px;">carregando&hellip;</div></div>';
    var counts = S.tasks.counts || [], restock = S.tasks.restock || [], organize = S.tasks.organize || [];
    if (!counts.length && !restock.length && !organize.length) {
      return h + '<div style="color:' + T.okFg + '; font-size:13px; font-weight:600; margin-top:8px;">Tudo em dia por aqui.</div>'
        + '<div style="color:' + T.mute2 + '; font-size:12.5px; margin-top:3px;">Nada pra contar, repor ou organizar agora.</div></div>';
    }
    counts.forEach(function (c) {
      h += '<div style="border-top:1px dotted ' + T.dot + '; padding:9px 2px; display:flex; align-items:center; gap:8px;">'
        + chip('contar', T.warnBg, T.warnFg, T.warnLn)
        + '<span style="flex:1; min-width:0; font-size:13.5px; color:' + T.ink2 + '; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">'
        + esc(c.bin_code ? 'BIN ' + c.bin_code : c.box_number ? 'CAIXA ' + c.box_number : '') + ' ' + esc(c.product || '') + '</span>'
        + btn('taskCount', 'Contar', (c.bin_id ? 'bin:' + c.bin_id : 'box:' + c.box_id), 'border:0; cursor:pointer; border-radius:999px; min-height:44px; padding:0 18px; background:' + T.ink + '; color:#fff; font-weight:700; font-size:13px;')
        + '</div>';
    });
    restock.forEach(function (r) {
      h += '<div style="border-top:1px dotted ' + T.dot + '; padding:9px 2px; display:flex; align-items:center; gap:8px;">'
        + chip('repor', T.neuBg, T.neuFg, T.neuLn)
        + '<span style="flex:1; min-width:0; font-size:13.5px; color:' + T.ink2 + '; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">'
        + esc(r.bin_code ? 'BIN ' + r.bin_code : '') + ' ' + esc(r.product || '') + '</span>'
        + btn('go', 'Repor', 'repor', 'border:0; cursor:pointer; border-radius:999px; min-height:44px; padding:0 18px; background:' + T.ink + '; color:#fff; font-weight:700; font-size:13px;')
        + '</div>';
    });
    organize.forEach(function (o) {
      h += '<div style="border-top:1px dotted ' + T.dot + '; padding:9px 2px; display:flex; align-items:center; gap:8px;">'
        + chip('organizar', T.okBg, T.okFg, T.okLn)
        + '<span style="flex:1; min-width:0; font-size:13.5px; color:' + T.ink2 + '; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">'
        + esc(o.product || o.name || '') + '</span>'
        + '<span style="font-family:' + MONO + '; font-size:12px; color:' + T.ink + '; font-weight:700;">' + (o.qty || 0) + ' a organizar</span>'
        + btn('go', 'Organizar', 'organizar', 'border:0; cursor:pointer; border-radius:999px; min-height:44px; padding:0 18px; background:' + T.ink + '; color:#fff; font-weight:700; font-size:13px;')
        + '</div>';
    });
    return h + '</div>';
  }

  function recentHtml() {
    var h = '<div style="' + CARD + ' padding:16px 20px;">' + microLbl('Registrado hoje');
    if (!S.recent) return h + '<div style="color:' + T.mute2 + '; font-size:12.5px; margin-top:8px;">carregando&hellip;</div></div>';
    if (!S.recent.length) return h + '<div style="color:' + T.mute2 + '; font-size:12.5px; margin-top:8px;">Nada registrado ainda hoje. O que você fizer aqui aparece nesta lista.</div></div>';
    S.recent.forEach(function (r) {
      var sc = statusChip(r.status);
      h += '<div style="border-top:1px dotted ' + T.dot + '; padding:8px 2px; display:flex; align-items:center; gap:8px; font-size:13px; flex-wrap:wrap;">'
        + '<span style="flex:1; min-width:100px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:' + T.ink2 + '; font-weight:600;">' + esc(r.nickname || r.product || '') + '</span>'
        + '<span style="font-family:' + MONO + '; font-size:12px; color:' + T.ink + '; font-weight:700;">&times;' + (r.qty == null ? 0 : r.qty) + '</span>'
        + chip(esc(kindLabel(r.kind)), T.neuBg, T.neuFg, T.neuLn)
        + chip(sc.label, sc.bg, sc.fg, sc.ln)
        + (r.box_number ? btn('printLabel', 'Imprimir etiqueta', esc(r.box_id || r.box_number), 'border:1px solid ' + T.line + '; background:#fff; cursor:pointer; border-radius:999px; min-height:44px; padding:0 16px; font-size:12.5px; font-weight:700; color:' + T.ink2 + ';') : '')
        + '</div>';
    });
    return h + '</div>';
  }

  // ── ORGANIZAR ───────────────────────────────────────────────
  function organizarHtml() {
    var w = S.org;
    var h = scanBarHtml(w.target ? 'Agora escaneie a garrafa ou a caixa' : 'Escaneie a prateleira de destino');
    h += '<div style="' + CARD + ' padding:20px 22px; max-width:640px;">';
    h += stepLine(1, 'Onde vai guardar', !!w.target);
    if (w.target) h += targetCard(w.target, 'clearOrgTarget', true);
    else h += hint('Escaneie a etiqueta da prateleira (ex.: A03B2) ou da caixa. Sem leitor? Digite o código ali em cima.');
    h += stepLine(2, 'Qual produto', !!w.product);
    if (w.product) h += productCard(w.product, 'clearOrgProduct');
    else h += hint('Escaneie o código de barras da garrafa, ou busque o produto pelo nome ali em cima.');
    h += stepLine(3, 'Quantas garrafas', !!intOf(w.qty));
    h += qtyStepper('orgQty', w.qty, 'garrafas');
    h += btn('submitOrganize', S.busy ? 'Guardando&hellip;' : 'Guardar aqui', null, PILL + ' width:100%;');
    h += '<div style="font-size:12.5px; color:' + T.muted + '; margin-top:10px;">Vale na hora: sai de A organizar e entra na prateleira. Não precisa de aprovação.</div>';
    return h + '</div>';
  }

  /**
   * TARA: o que descontar do peso bruto. Ela some com a contagem inteira se
   * estiver errada, entao a tela mostra qual esta valendo, sempre.
   *
   * Ordem (regra do Bruno): a do proprio bin/caixa manda, senao o preset que o
   * operador escolher, senao o que ele digitar. Quando o local ja tem tara
   * cadastrada os presets ficam apagados: mexer neles ali nao mudaria nada, e
   * um botao que nao faz nada e pior que botao nenhum.
   */
  function tareHtml(w, tare) {
    var src = w.target && (w.target.bin || w.target.box);
    var fromTarget = !!(src && numOf(src.tare_g) > 0);
    var presets = (S.tasks && S.tasks.tares) || [];
    var h = '<div style="margin-bottom:12px;">' + microLbl('Quanto pesa vazia (tara)');
    if (fromTarget) {
      h += '<div style="font-size:12.5px; color:' + T.muted + '; margin:6px 0 8px;">'
        + 'Esse local já tem a tara cadastrada: ' + numOf(src.tare_g) + ' g. Usamos ela.</div>';
    } else if (presets.length) {
      h += '<div style="font-size:12.5px; color:' + T.muted + '; margin:6px 0 8px;">Escolha o que está segurando as garrafas:</div>';
    } else {
      h += '<div style="font-size:12.5px; color:' + T.muted + '; margin:6px 0 8px;">Sem tara cadastrada. Pese a caixa vazia e digite abaixo, ou deixe em branco se estiver pesando só as garrafas.</div>';
    }
    if (presets.length) {
      h += '<div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px;' + (fromTarget ? ' opacity:.45;' : '') + '">';
      presets.forEach(function (p) {
        var on = !fromTarget && w.preset && String(w.preset.id) === String(p.id);
        h += btn('cntTare', esc(p.name) + ' &middot; ' + (numOf(p.tare_g) || 0) + ' g', esc(p.id),
          'border:1px solid ' + (on ? T.ink : T.line) + '; cursor:pointer; border-radius:999px; min-height:44px; padding:0 16px;'
          + ' font-family:' + MONO + '; font-size:12px; font-weight:700;'
          + ' background:' + (on ? T.ink : '#fff') + '; color:' + (on ? '#fff' : T.muted) + ';');
      });
      if (!fromTarget && w.preset) {
        h += btn('cntTare', 'limpar', '', 'border:0; background:none; cursor:pointer; color:' + T.mute2 + '; font-size:12.5px; font-weight:700; min-height:44px; padding:0 10px;');
      }
      h += '</div>';
    }
    if (!fromTarget) {
      h += '<input data-input="cntTare" inputmode="decimal" value="' + esc(String(w.tareTyped || '')) + '" placeholder="ou digite a tara em gramas" style="' + INPUT + ' font-size:15px;">';
    }
    return h + '</div>';
  }

  // ── CONTAR ──────────────────────────────────────────────────
  function contarHtml() {
    var w = S.cnt;
    var pv = w.preview || weighPreview({ gross_g: w.gross, tare_g: tareFor(w.target && (w.target.bin || w.target.box), w.preset, w.tareTyped), unit_weight_g: w.product && w.product.unit_weight_g });
    var h = scanBarHtml(w.target ? 'Produto (se a prateleira não disser)' : 'Escaneie a prateleira ou a caixa');
    h += '<div style="' + CARD + ' padding:20px 22px; max-width:640px;">';
    h += stepLine(1, 'O que você contou', !!w.target);
    // showQty = false: contagem é CEGA, o operador não vê o número guardado.
    if (w.target) h += targetCard(w.target, 'clearCntTarget', false);
    else h += hint('Escaneie a prateleira ou a caixa que você está contando.');
    if (w.product) h += productCard(w.product, 'clearCntProduct');

    // Contagem cega: dizer POR QUE o número não aparece evita o "cadê o total?".
    h += '<div style="background:' + T.neuBg + '; border:1px solid ' + T.neuLn + '; border-radius:12px; padding:10px 14px; margin:4px 0 12px; font-size:12.5px; color:' + T.neuFg + ';">'
      + 'Conte sem olhar o sistema. O número que está guardado fica escondido de propósito, pra sua contagem valer.'
      + '</div>';

    // modo
    h += '<div style="display:inline-flex; border:1px solid ' + T.line + '; border-radius:10px; overflow:hidden; margin:0 0 14px;">'
      + btn('cntMode', 'Pesar', 'weigh', 'padding:0 20px; min-height:44px; border:0; cursor:pointer; font-weight:700; font-size:14px; background:' + (w.mode === 'weigh' ? T.ink : '#fff') + '; color:' + (w.mode === 'weigh' ? '#fff' : T.muted) + ';')
      + btn('cntMode', 'Contar na mão', 'manual', 'padding:0 20px; min-height:44px; border:0; cursor:pointer; font-weight:700; font-size:14px; background:' + (w.mode === 'manual' ? T.ink : '#fff') + '; color:' + (w.mode === 'manual' ? '#fff' : T.muted) + ';')
      + '</div>';

    if (w.mode === 'weigh') {
      var tare = tareFor(w.target && (w.target.bin || w.target.box), w.preset, w.tareTyped);
      h += '<div style="margin-bottom:12px;">' + microLbl('Peso na balança, com a caixa junto (gramas)')
        + '<input data-input="cntGross" inputmode="decimal" value="' + esc(String(w.gross || '')) + '" placeholder="ex.: 4820" style="' + INPUT + ' margin-top:6px; font-size:24px; font-weight:800; text-align:center;"></div>';
      h += tareHtml(w, tare);
      h += '<div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px;">'
        + chip(esc(tareText(w.target && (w.target.bin || w.target.box), w.preset, w.tareTyped)), T.neuBg, T.neuFg, T.neuLn)
        + chip(w.product && w.product.unit_weight_g ? 'garrafa ' + w.product.unit_weight_g + ' g' : 'sem peso da garrafa', w.product && w.product.unit_weight_g ? T.neuBg : T.warnBg, w.product && w.product.unit_weight_g ? T.neuFg : T.warnFg, w.product && w.product.unit_weight_g ? T.neuLn : T.warnLn)
        + '</div>';
      // previa (conta local; o servidor refaz e manda o valor final)
      if (pv.qty != null) {
        var cc = confChip(pv.confidence);
        h += '<div id="cntPreview" style="background:' + T.soft + '; border:1px solid ' + T.line + '; border-radius:14px; padding:14px 16px; margin-bottom:14px; text-align:center;">'
          + microLbl('Dá mais ou menos')
          + '<div style="font-family:' + SERIF + '; font-size:44px; color:' + T.ink + '; line-height:1.05;">' + pv.qty + '</div>'
          + '<div style="font-size:12.5px; color:' + T.muted + '; margin-bottom:8px;">líquido ' + pv.net_g + ' g &middot; sobra ' + pv.residual_g + ' g</div>'
          + chip(cc.label, cc.bg, cc.fg, cc.ln)
          + '</div>';
      } else if (numOf(w.gross) != null) {
        h += '<div id="cntPreview" style="background:' + T.warnBg + '; border:1px solid ' + T.warnLn + '; border-radius:14px; padding:12px 14px; margin-bottom:14px; font-size:13px; color:' + T.warnFg + '; font-weight:600;">Esse produto ainda não tem o peso da garrafa cadastrado, então a balança não conta sozinha. Toque em Contar na mão e conte as garrafas.</div>';
      }
      h += btn('submitWeigh', S.busy ? 'Enviando&hellip;' : 'Confirmar contagem', null, PILL + ' width:100%;');
    } else {
      h += '<div style="margin-bottom:4px;">' + microLbl('Quantas garrafas você contou') + '</div>';
      h += qtyStepper('cntQty', w.qty, 'garrafas');
      h += btn('submitManual', S.busy ? 'Enviando&hellip;' : 'Confirmar contagem', null, PILL + ' width:100%;');
    }
    h += '<div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">'
      + btn('emptyCount', 'Está vazio', null, 'border:1px solid ' + T.badLn + '; background:' + T.badBg + '; cursor:pointer; border-radius:999px; min-height:44px; padding:0 20px; font-weight:800; font-size:14px; color:' + T.badFg + ';')
      + '<span style="font-size:12.5px; color:' + T.muted + ';">não sobrou nenhuma garrafa aí</span>'
      + '</div>';
    h += '<div style="font-size:12.5px; color:' + T.muted + '; margin-top:10px;">A contagem vai pro admin. Ele aprova e o número muda. Até lá nada muda no total.</div>';
    return h + '</div>';
  }

  // ── REPOR ───────────────────────────────────────────────────
  function reporHtml() {
    var h = '<div style="' + CARD + ' padding:20px 22px; max-width:720px;">' + microLbl('Prateleiras pedindo reposição');
    if (!S.ctx) return h + '<div style="color:' + T.mute2 + '; font-size:12.5px; margin-top:10px;">carregando&hellip;</div></div>';
    var boxes = S.ctx.boxes || [];
    var allBins = S.ctx.bins || [];
    var rows = allBins.filter(function (b) { return !!b.needs_restock; }).map(function (b) {
      return { bin: b, boxes: boxes.filter(function (x) {
        return b.product_id != null && intOf(x.product_id) === intOf(b.product_id) && (intOf(x.qty) || 0) > 0;
      }) };
    }).filter(function (r) { return r.boxes.length > 0; });
    if (!rows.length) {
      // Dia 1: sem prateleira nenhuma o operador não pode fazer nada aqui,
      // e "está tudo cheio" seria mentira. Ensina o primeiro passo.
      if (!allBins.length) {
        return h + '<div style="margin-top:10px; font-size:13.5px; color:' + T.ink2 + ';">Nenhuma prateleira cadastrada ainda.</div>'
          + '<div style="margin-top:4px; font-size:13px; color:' + T.muted + ';">Peça pro admin cadastrar as prateleiras em Locais. Depois elas aparecem aqui sozinhas.</div></div>';
      }
      return h + '<div style="color:' + T.okFg + '; font-size:13.5px; font-weight:600; margin-top:10px;">Nenhuma prateleira precisando repor agora.</div></div>';
    }
    rows.forEach(function (r) {
      var b = r.bin;
      h += '<div style="border-top:1px dotted ' + T.dot + '; padding:12px 2px;">'
        + '<div style="display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; margin-bottom:8px;">'
        + '<span style="font-family:' + MONO + '; font-size:14px; font-weight:700; color:' + T.ink + ';">' + esc(placeLabel(b)) + '</span>'
        + '<span style="flex:1; min-width:0; font-size:13.5px; color:' + T.ink2 + '; font-weight:600;">' + esc(b.product || '') + '</span>'
        + chip('tem ' + (b.qty || 0) + ' &middot; mín ' + (b.min_qty || 0), T.warnBg, T.warnFg, T.warnLn)
        + '</div><div style="display:flex; flex-wrap:wrap; gap:8px;">';
      r.boxes.forEach(function (x) {
        var binQty = Math.max(0, intOf(b.qty) || 0);
        var min = intOf(b.min_qty) || 0;
        var q = Math.min(Math.max(0, intOf(x.qty) || 0), Math.max(1, (min * 2 || 48) - binQty));
        h += btn('restock', 'Repor ' + q + ' &middot; ' + esc(placeLabel(x)), b.id + ':' + x.id,
          'border:0; cursor:pointer; border-radius:999px; min-height:48px; padding:0 20px; background:' + T.ink + '; color:#fff; font-weight:800; font-size:14px; font-family:' + SORA + ';');
      });
      h += '</div></div>';
    });
    return h + '</div>';
  }

  // ── ENTRADA (caixa nova) ────────────────────────────────────
  function entradaHtml() {
    var w = S.ent;
    var h = scanBarHtml('Escaneie uma garrafa da caixa ou busque o produto');
    h += '<div style="' + CARD + ' padding:20px 22px; max-width:640px;">';
    h += stepLine(1, 'Que produto chegou', !!w.product);
    if (w.product) h += productCard(w.product, 'clearEntProduct');
    else h += hint('Escaneie o código de barras de uma garrafa da caixa, ou busque o produto pelo nome.');
    h += stepLine(2, 'Quantas garrafas na caixa', !!intOf(w.qty));
    h += '<input data-input="entQty" inputmode="numeric" value="' + esc(String(w.qty || '')) + '" placeholder="ex.: 48" style="' + INPUT + ' margin-bottom:14px; font-size:22px; font-weight:800; text-align:center;">';
    h += stepLine(3, 'Lote e área (pode pular)', !!String(w.lot || '').trim());
    h += '<input data-input="entLot" value="' + esc(w.lot || '') + '" placeholder="lote impresso na caixa (opcional)" style="' + INPUT + ' margin-bottom:12px;">';
    h += '<input data-input="entArea" value="' + esc(w.area || '') + '" placeholder="área onde a caixa vai ficar (opcional)" style="' + INPUT + ' margin-bottom:14px;">';
    h += btn('submitEntrada', S.busy ? 'Enviando&hellip;' : 'Enviar caixa nova', null, PILL + ' width:100%;');
    h += '<div style="font-size:12.5px; color:' + T.muted + '; margin-top:10px;">Vai pro admin. Quando ele aprovar sai o número da caixa, e ele aparece em Registrado hoje com o botão de imprimir a etiqueta.</div>';
    return h + '</div>';
  }

  // ── DEVOLUCAO / DANIFICADA ──────────────────────────────────
  function simpleHtml(slot) {
    var w = S[slot];
    var isDan = slot === 'dan';
    var h = scanBarHtml('Escaneie a garrafa ou busque o produto');
    h += '<div style="' + CARD + ' padding:20px 22px; max-width:640px;">';
    h += stepLine(1, 'Qual produto', !!w.product);
    if (w.product) h += productCard(w.product, isDan ? 'clearDanProduct' : 'clearDevProduct');
    else h += hint('Escaneie o código de barras da garrafa, ou busque o produto pelo nome.');
    h += stepLine(2, 'Quantas garrafas', !!intOf(w.qty));
    h += qtyStepper(isDan ? 'danQty' : 'devQty', w.qty, 'garrafas');
    h += '<input data-input="' + (isDan ? 'danReason' : 'devReason') + '" value="' + esc(w.reason || '') + '" placeholder="' + (isDan ? 'o que aconteceu? (opcional)' : 'de onde voltou? (opcional)') + '" style="' + INPUT + ' margin-bottom:14px;">';
    h += btn(isDan ? 'submitDanificada' : 'submitDevolucao', S.busy ? 'Enviando&hellip;' : (isDan ? 'Registrar danificada' : 'Enviar devolução'), null, PILL + ' width:100%;');
    h += '<div style="font-size:12.5px; color:' + T.muted + '; margin-top:10px;">'
      + (isDan ? 'Vale na hora: sai do vendável e vai pra Separadas. Não precisa de aprovação.'
        : 'Vai pro admin. Ele aprova e a garrafa volta pro estoque.')
      + '</div>';
    return h + '</div>';
  }

  // ── PAREAR CELULAR ──────────────────────────────────────────
  function pairHtml() {
    var h = '<div style="' + CARD + ' padding:24px; max-width:520px; text-align:center;">';
    if (!S.pair.code) {
      h += '<div style="font-size:44px; margin-bottom:6px;">📱</div>'
        + '<div style="font-size:14px; color:' + T.muted + '; margin-bottom:18px;">Aponte a câmera do celular pro QR e ele vira o leitor de código de barras desta tela.</div>'
        + (S.pair.error ? '<div style="color:' + T.badFg + '; font-weight:700; font-size:13.5px; margin-bottom:12px;">' + esc(S.pair.error) + '</div>' : '')
        + btn('pair', S.busy ? 'Gerando&hellip;' : 'Gerar QR do celular', null, PILL);
      return h + '</div>';
    }
    var full = absUrl(S.pair.url);
    h += '<div id="pairQr" style="display:flex; justify-content:center; margin-bottom:14px;">' + qrSvg(full, 200) + '</div>';
    h += microLbl('Código do par')
      + '<div style="font-family:' + MONO + '; font-size:34px; font-weight:700; letter-spacing:.18em; color:' + T.ink + '; margin:2px 0 10px;">' + esc(S.pair.code) + '</div>';
    h += '<div style="margin-bottom:14px;">'
      + chip(S.pair.connected ? 'celular conectado' : 'esperando o celular', S.pair.connected ? T.okBg : T.warnBg, S.pair.connected ? T.okFg : T.warnFg, S.pair.connected ? T.okLn : T.warnLn)
      + '</div>';
    h += '<div style="font-size:13px; color:' + T.muted + '; margin-bottom:12px;">'
      + (S.pair.connected
        ? 'Pronto. O que você escanear no celular cai direto nesta tela.'
        : 'Abra a câmera do celular e aponte pro QR. Se ele não abrir, digite o endereço abaixo no navegador do celular.')
      + '</div>';
    if (S.pair.lastScan) {
      h += '<div style="background:' + T.okBg + '; border:1px solid ' + T.okLn + '; border-radius:12px; padding:10px 14px; margin-bottom:12px;">'
        + microLbl('Último código lido') + '<div style="font-family:' + MONO + '; font-size:16px; font-weight:700; color:' + T.okFg + ';">' + esc(S.pair.lastScan) + '</div></div>';
    }
    h += '<div style="font-size:12.5px; color:' + T.muted + '; word-break:break-all;">' + esc(full) + '</div>';
    h += '<div style="margin-top:16px; display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">'
      + btn('pair', 'Gerar outro código', null, GHOST)
      + btn('go', 'Voltar pro hub', 'home', GHOST)
      + '</div>';
    return h + '</div>';
  }
  function absUrl(u) {
    var s = String(u || '');
    if (/^https?:/i.test(s)) return s;
    if (typeof location === 'undefined') return s;
    return location.origin + (s.indexOf('/') === 0 ? s : '/' + s);
  }
  function qrSvg(text, size) {
    var QR = (typeof window !== 'undefined' && window.qrcode) || null;
    if (!QR) return '<div style="width:' + size + 'px; height:' + size + 'px; background:' + T.soft + '; border:1px solid ' + T.line + '; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:12px; color:' + T.mute2 + ';">QR não carregou</div>';
    try {
      var q = QR(0, 'M');
      q.addData(String(text));
      q.make();
      var cell = Math.max(2, Math.floor(size / (q.getModuleCount() + 2)));
      return q.createSvgTag({ cellSize: cell, margin: cell });
    } catch (e) {
      return '<div style="font-size:12px; color:' + T.mute2 + ';">QR não carregou</div>';
    }
  }

  // ── pecinhas ────────────────────────────────────────────────
  function stepLine(n, label, done) {
    return '<div style="display:flex; align-items:center; gap:9px; margin:2px 0 8px;">'
      + '<span style="width:22px; height:22px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-family:' + MONO + '; font-size:11px; font-weight:700; background:' + (done ? T.okBg : T.neuBg) + '; color:' + (done ? T.okFg : T.neuFg) + '; box-shadow:inset 0 0 0 1px ' + (done ? T.okLn : T.neuLn) + ';">' + (done ? '✓' : n) + '</span>'
      + '<span style="font-family:' + MONO + '; font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:' + T.mute2 + '; font-weight:600;">' + label + '</span></div>';
  }
  function hint(t) {
    return '<div style="background:' + T.soft + '; border:1px dashed ' + T.line + '; border-radius:12px; padding:12px 14px; margin-bottom:14px; font-size:13px; color:' + T.muted + ';">' + t + '</div>';
  }
  function toastHtml() {
    if (!S.toastMsg) return '';
    return '<div style="position:fixed; left:50%; bottom:26px; transform:translateX(-50%); z-index:60; background:' + T.ink + '; color:#fff; padding:14px 24px; border-radius:999px; font-weight:700; font-size:14.5px; box-shadow:0 18px 40px -16px rgba(13,31,60,.7); max-width:90vw; text-align:center;">' + esc(S.toastMsg) + '</div>';
  }
  function flashHtml() {
    if (!S.flash || Date.now() - S.flash > 500) return '';
    return '<div style="position:fixed; inset:0; background:#2e8b3c; opacity:.2; pointer-events:none; z-index:50; animation:hfFlash .5s forwards;"></div>';
  }

  function hubHtml() {
    var body = S.scr === 'organizar' ? organizarHtml()
      : S.scr === 'contar' ? contarHtml()
        : S.scr === 'repor' ? reporHtml()
          : S.scr === 'entrada' ? entradaHtml()
            : S.scr === 'devolucao' ? simpleHtml('dev')
              : S.scr === 'danificada' ? simpleHtml('dan')
                : S.scr === 'parear' ? pairHtml()
                  : homeHtml();
    return headerHtml()
      + '<div class="hf-scroll" style="padding:6px 26px 60px; max-width:1180px; margin:0 auto;">' + body + '</div>'
      + toastHtml() + flashHtml();
  }

  function render() {
    if (!el) return;
    el.innerHTML = S.screen === 'login' ? loginHtml() : hubHtml();
    if (S.screen !== 'login') focusSink();
  }

  // ════════════════════════════════════════════════════════════
  // EVENTOS
  // ════════════════════════════════════════════════════════════
  var ACT = {
    pinkey: function (k) {
      if (k === '⌫') { S.pin = S.pin.slice(0, -1); S.pinError = ''; render(); }
      else if (k === '✓') { if (S.pin.length === 4) submitPin(); }
      else if (/\d/.test(k) && S.pin.length < 4) {
        S.pin += k; S.pinError = ''; render();
        if (S.pin.length === 4) submitPin();
      }
    },
    logout: function () { logout(); },
    go: function (scr) {
      S.scr = SCREENS.indexOf(scr) >= 0 ? scr : 'home';
      S.lookup.q = ''; S.lookup.items = [];
      render();
      if (S.scr === 'repor') loadContext();
    },
    pair: function () { pairPhone(); },
    pickProduct: function (id) {
      var p = (S.lookup.items || []).find(function (x) { return String(x.id) === String(id); });
      if (p) { setProduct(p); render(); }
    },
    taskCount: function (arg) {
      var parts = String(arg || '').split(':');
      var kind = parts[0], id = intOf(parts[1]);
      var ctx = S.ctx || {};
      var src = kind === 'bin'
        ? (ctx.bins || []).find(function (b) { return b.id === id; })
        : (ctx.boxes || []).find(function (b) { return b.id === id; });
      S.scr = 'contar';
      if (src) {
        S.cnt.target = { kind: kind, bin: kind === 'bin' ? src : null, box: kind === 'box' ? src : null };
        autoProductFor(S.cnt.target, 'cnt');
      }
      render();
    },
    clearOrgTarget: function () { S.org.target = null; render(); },
    clearOrgProduct: function () { S.org.product = null; render(); },
    clearCntTarget: function () { S.cnt.target = null; S.cnt.preview = null; render(); },
    clearCntProduct: function () { S.cnt.product = null; recompute(); render(); },
    clearEntProduct: function () { S.ent.product = null; render(); },
    clearDevProduct: function () { S.dev.product = null; render(); },
    clearDanProduct: function () { S.dan.product = null; render(); },
    orgQtyDelta: function (d) { S.org.qty = String(Math.max(1, (intOf(S.org.qty) || 1) + intOf(d))); render(); },
    cntQtyDelta: function (d) { S.cnt.qty = String(Math.max(0, (intOf(S.cnt.qty) || 0) + intOf(d))); render(); },
    devQtyDelta: function (d) { S.dev.qty = String(Math.max(1, (intOf(S.dev.qty) || 1) + intOf(d))); render(); },
    danQtyDelta: function (d) { S.dan.qty = String(Math.max(1, (intOf(S.dan.qty) || 1) + intOf(d))); render(); },
    cntMode: function (m) { S.cnt.mode = m === 'manual' ? 'manual' : 'weigh'; render(); },
    /* Preset de tara (chips vindos de stock/tasks.tares). Tocar no que ja esta
       escolhido desmarca: e o jeito mais rapido de corrigir sem procurar botao. */
    cntTare: function (id) {
      var list = (S.tasks && S.tasks.tares) || [];
      var p = list.find(function (x) { return String(x.id) === String(id); });
      S.cnt.preset = (p && (!S.cnt.preset || String(S.cnt.preset.id) !== String(p.id))) ? p : null;
      if (S.cnt.preset) S.cnt.tareTyped = '';    // preset manda no digitado
      recompute(); render();
    },
    emptyCount: function () { submitManual(0); },
    submitOrganize: function () { submitOrganize(); },
    submitWeigh: function () { submitWeigh(); },
    submitManual: function () { submitManual(); },
    submitEntrada: function () { submitEntrada(); },
    submitDevolucao: function () { submitDevolucao(); },
    submitDanificada: function () { submitDanificada(); },
    restock: function (arg) {
      var p = String(arg || '').split(':');
      doRestock(intOf(p[0]), intOf(p[1]));
    },
    printLabel: function (boxId) { printLabel(boxId); },
    // fila do celular: pega o job, imprime e marca como feito
    printJob: function (id) { if (queue) queue.take(id); },
    // etiquetas de envio: quem viu o papel sair e quem fecha o job
    printJobDone: function () { if (queue) queue.confirm(); },
    printJobFail: function () { if (queue) queue.fail('n&atilde;o saiu na 4x6'); },
  };

  var INPUTS = {
    lookup: function (v) { doLookup(v); },
    orgQty: function (v) { S.org.qty = v; },
    cntQty: function (v) { S.cnt.qty = v; },
    cntGross: function (v) { S.cnt.gross = v; recompute(); renderPreview(); },
    cntTare: function (v) { S.cnt.tareTyped = v; S.cnt.preset = null; recompute(); renderPreview(); },
    entQty: function (v) { S.ent.qty = v; },
    entLot: function (v) { S.ent.lot = v; },
    entArea: function (v) { S.ent.area = v; },
    devQty: function (v) { S.dev.qty = v; },
    devReason: function (v) { S.dev.reason = v; },
    danQty: function (v) { S.dan.qty = v; },
    danReason: function (v) { S.dan.reason = v; },
  };

  /** Previa da pesagem sem re-render (nao rouba o foco de quem digita). */
  function renderPreview() {
    if (!el) return;
    var node = el.querySelector('#cntPreview');
    var pv = S.cnt.preview;
    if (!node) { render(); return; }
    if (!pv || pv.qty == null) { render(); return; }
    var cc = confChip(pv.confidence);
    node.innerHTML = microLbl('Dá mais ou menos')
      + '<div style="font-family:' + SERIF + '; font-size:44px; color:' + T.ink + '; line-height:1.05;">' + pv.qty + '</div>'
      + '<div style="font-size:12.5px; color:' + T.muted + '; margin-bottom:8px;">líquido ' + pv.net_g + ' g &middot; sobra ' + pv.residual_g + ' g</div>'
      + chip(cc.label, cc.bg, cc.fg, cc.ln);
  }

  // ── leitor USB: o teclado "digita" no sink invisivel ────────
  function focusSink() {
    if (!sink) return;
    // nao rouba o foco de quem esta digitando de verdade
    var a = document.activeElement;
    if (a && a !== sink && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
    try { sink.focus({ preventScroll: true }); } catch (e) { try { sink.focus(); } catch (e2) {} }
  }

  function bindEvents() {
    document.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      var fn = ACT[b.getAttribute('data-act')];
      if (fn) { e.preventDefault(); fn(b.getAttribute('data-arg')); }
    });
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var k = t.getAttribute('data-input');
      if (!k) return;
      var fn = INPUTS[k];
      if (fn) fn(t.value);
    });
    // Enter no sink = fim do codigo do leitor USB
    if (sink) {
      sink.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var v = normScan(sink.value);
        sink.value = '';
        if (v) dispatchScan(v);
      });
    }
    // PIN por teclado fisico
    document.addEventListener('keydown', function (e) {
      if (S.screen !== 'login') return;
      if (/^\d$/.test(e.key) && S.pin.length < 4) {
        S.pin += e.key; S.pinError = ''; render();
        if (S.pin.length === 4) submitPin();
      } else if (e.key === 'Backspace') { S.pin = S.pin.slice(0, -1); S.pinError = ''; render(); }
      else if (e.key === 'Enter' && S.pin.length === 4) submitPin();
    });
    document.addEventListener('click', function () { focusSink(); });
  }

  function boot() {
    el = document.getElementById('hf-est');
    sink = document.getElementById('scanSink');
    if (!el) return;
    bindEvents();
    if (loadSession()) { S.screen = 'hub'; render(); loadAll(); startQueue(); focusSink(); }
    else render();
    // service worker: mesma casca do /op
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/op/sw.js').catch(function () {});
    }
  }

  return {
    boot: boot, render: render, state: S, dispatchScan: dispatchScan, api: api,
    acts: ACT, inputs: INPUTS,
    queue: function () { return queue; }, startQueue: startQueue, stopQueue: stopQueue,
    _: {
      guessKind: guessKind, normScan: normScan, weighPreview: weighPreview, tareFor: tareFor,
      placeLabel: placeLabel, targetLabel: targetLabel, targetBody: targetBody,
      organizeBody: organizeBody, organizeError: organizeError,
      weighBody: weighBody, manualBody: manualBody, countError: countError,
      tareSource: tareSource, tareText: tareText,
      boxNewBody: boxNewBody, boxNewError: boxNewError, labelPayload: labelPayload,
      streamUrl: streamUrl, kindLabel: kindLabel, statusChip: statusChip,
      confChip: confChip, intOf: intOf, numOf: numOf, esc: esc, SCREENS: SCREENS, MENU: MENU,
    },
  };
}));
