'use strict';
/* ============================================================
   HEALTHFARE Operator · CENTRAL DE P&P & ESTOQUE (workspace).

   Extraído de src/op/app.js (S15 Fase 2). app.js só chama daqui:
     HF_WS.init(deps) uma vez, e depois
     HF_WS.banner() / HF_WS.load() / HF_WS.inner() / HF_WS.key() /
     HF_WS.print() / HF_WS.allowed() / HF_WS.slugs / HF_WS.acts / HF_WS.input()

   Visual = STYLE-KIT (ground dot-grid, título serif com itálico verde,
   pill navy, chips tonais): tokens inline IDÊNTICOS aos do app.js original.

   Fase 2 (S15-PHASE2-PLAN):
   - "Registrar": Peguei do estoque · Danificada · Entrada · Contagem.
     pick/damaged → POST stock/take · entrada/count → POST stock/propose.
   - Card "Repor prateleira": bins com needs_restock + caixas do produto,
     um toque → POST stock/restock.
   - "Registrado hoje": chip de estado (pendente/aprovado/recusado/aplicado).

   Este arquivo NÃO toca o DOM ao carregar (dá pra testar em node).
   ============================================================ */
(function (root, factory) {
  var WS = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = WS;
  if (root) root.HF_WS = WS;
}(typeof window !== 'undefined' ? window : null, function () {

  // ── deps injetadas pelo app.js (nunca importadas) ───────────
  var D = {
    S: null, CFG: null, DATA: null,
    api: function () { return Promise.resolve(null); },
    toast: function () {},
    render: function () {},
    esc: function (s) { return String(s == null ? '' : s); },
    isSandbox: function () { return false; },
    typeMeta: function () { return {}; },
    openWindow: function () { return null; },
  };

  // slugs de task que abrem a Central (P&P + organização de estoque)
  var WS_SLUGS = { order_printing: 1, order_printing_2: 1, stock_organization: 1 };

  // ── tokens STYLE-KIT (mesmos valores inline do app.js original) ─
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
  function microLbl(t) { return '<div style="font-family:' + MONO + '; font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:' + T.mute2 + '; font-weight:600;">' + t + '</div>'; }
  function chip(txt, bg, fg, ln) {
    return '<span style="height:20px; display:inline-flex; align-items:center; padding:0 9px; border-radius:999px; font-family:' + MONO + '; font-size:10.5px; background:' + bg + '; color:' + fg + '; box-shadow:inset 0 0 0 1px ' + ln + ';">' + txt + '</span>';
  }

  // ════════════════════════════════════════════════════════════
  // HELPERS PUROS (testáveis sem DOM)
  // ════════════════════════════════════════════════════════════

  // Nome LIMPO do produto: sem marca, sem mg, sem contagem, sem marketing.
  function cleanName(g) {
    var src = String((g && g.product) || '').trim();
    if (!src) {
      src = String((g && g.title) || '').split('|')[0];
      src = src.replace(/\s*[\d.,]+\s*(mg|mcg)\b.*$/i, '')
               .replace(/\s*\d+\s*(veg(an)?\s*)?(capsules?|caps|tablets?|tabs|softgels?|count|ct)\b.*$/i, '');
    }
    return src.replace(/healthfare|healtfare/ig, '')
      .replace(/\s*-\s*C\d+\s*$/i, '')
      .replace(/\b[\d.,]+\s*(mg|mcg)\b/ig, '')
      .replace(/[^A-Za-z0-9\-+' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function mgOf(g) {
    var m = String((g && g.product) || '').match(/([\d.,]+)\s*(mg|mcg)/i)
         || String((g && g.title) || '').match(/([\d.,]+)\s*(mg|mcg)/i);
    return m ? (m[1] + m[2].toLowerCase()) : '';
  }
  function capsOf(g) {
    var cd = String((g && g.content_desc) || '').match(/(\d+)\s*(caps?|capsules?|tabs?|tablets?|softgels?|count|ct)/i);
    if (cd) return cd[1] + (/tab/i.test(cd[2]) ? 'tabs' : 'caps');
    var m = String((g && g.title) || '').match(/(\d+)\s*(?:veg(?:an)?\s*)?(capsules?|caps|tablets?|tabs|softgels?|count|ct)\b/i);
    return m ? m[1] + (/tab/i.test(m[2]) ? 'tabs' : 'caps') : '';
  }
  // Casepack ("C2"): é outro produto, não pode sumir.
  function packOf(g) {
    var m = String((g && g.sku) || '').match(/\bC(\d+)\b/i) || String((g && g.product) || '').match(/\bC(\d+)\b/i);
    return m ? 'C' + m[1] : '';
  }
  // Título CURTO: nome + mg + caps [+ casepack].
  function shortTitle(g) {
    var pack = packOf(g), mg = mgOf(g), caps = capsOf(g);
    return (cleanName(g) + (mg ? ' ' + mg : '') + (caps ? ' ' + caps : '') + (pack ? ' · ' + pack : '')).trim()
      || String((g && g.sku) || '?');
  }
  // Título do PRINT: nome COMPLETO + mg/caps, all caps.
  function printTitle(g) {
    var pack = packOf(g), mg = mgOf(g), caps = capsOf(g);
    return (cleanName(g).toUpperCase() + (mg ? ' ' + mg : '') + (caps ? '/' + caps : '')
      + (pack ? ' ' + pack : '')).trim() || String((g && g.sku) || '?');
  }
  function locationOf(g) {
    var loc = [];
    var L = (g && g.location) || {};
    if (L.shelf) loc.push('SHELF ' + L.shelf);
    if (L.bin) loc.push('BIN ' + L.bin);
    if (L.pallet) loc.push('PALLET ' + L.pallet);
    return loc.length ? loc.join(' · ') : 'LOCAL A DEFINIR';
  }
  // nome curto de um bin/caixa pro seletor de destino
  function placeLabel(p) {
    if (!p) return '';
    if (p.bin_code) return 'BIN ' + p.bin_code + (p.shelf_code ? ' · ' + p.shelf_code : '');
    if (p.box_number) return 'CAIXA ' + p.box_number + (p.area ? ' · ' + p.area : '');
    return String(p.id || '');
  }

  // Regra de quantidade do "Repor": enche o bin até 2x o mínimo (fallback 48),
  // limitado pelo que a caixa tem, nunca menos que 1.
  function restockQty(bin, box) {
    var binQty = Math.max(0, parseInt((bin && bin.qty) || 0, 10) || 0);
    var min = parseInt((bin && bin.min_qty) || 0, 10) || 0;
    var target = (min * 2) || 48;
    var gap = Math.max(1, target - binQty);
    var boxQty = Math.max(0, parseInt((box && box.qty) || 0, 10) || 0);
    return Math.min(boxQty, gap);
  }

  // "Registrado hoje": status → chip tonal.
  var STATUS_CHIP = {
    pending:  { label: 'pendente', bg: T.warnBg, fg: T.warnFg, ln: T.warnLn },
    approved: { label: 'aprovado', bg: T.okBg,   fg: T.okFg,   ln: T.okLn },
    rejected: { label: 'recusado', bg: T.badBg,  fg: T.badFg,  ln: T.badLn },
    applied:  { label: 'aplicado', bg: T.neuBg,  fg: T.neuFg,  ln: T.neuLn },
  };
  function statusChip(status) {
    return STATUS_CHIP[String(status || '').toLowerCase()] || STATUS_CHIP.applied;
  }
  var KIND_LABEL = {
    take: 'Peguei', pick: 'Peguei', damaged: 'Danificada',
    entrada: 'Entrada', count: 'Contagem', restock: 'Reposição', return_in: 'Devolução',
  };
  function kindLabel(kind) { return KIND_LABEL[String(kind || '')] || 'Registro'; }

  // ── builders de payload (contrato S15 Fase 2) ───────────────
  var KINDS = ['pick', 'damaged', 'entrada', 'count'];
  function isProposal(kind) { return kind === 'entrada' || kind === 'count'; }
  function submitPath(kind) { return isProposal(kind) ? '/api/v3/op/stock/propose' : '/api/v3/op/stock/take'; }
  function takeBody(w) {
    return {
      product_id: w.sel.id,
      qty: parseInt(w.qty, 10),
      kind: w.kind === 'damaged' ? 'damaged' : 'pick',
      reason: (w.reason || '').trim() || null,
    };
  }
  function proposeBody(w) {
    var b = {
      product_id: w.sel.id,
      kind: w.kind === 'count' ? 'count' : 'entrada',
      qty: parseInt(w.qty, 10),
      reason: (w.reason || '').trim() || null,
    };
    var dest = String(w.dest || '');
    if (dest.indexOf('bin:') === 0) b.bin_id = parseInt(dest.slice(4), 10);
    else if (dest.indexOf('box:') === 0) b.box_id = parseInt(dest.slice(4), 10);
    return b;
  }
  function submitBody(w) { return isProposal(w.kind) ? proposeBody(w) : takeBody(w); }
  function restockBody(bin, box) {
    return { bin_id: bin.id, box_id: box.id, qty: restockQty(bin, box) };
  }
  var TOASTS = {
    pick: 'Registrado. Vai pra aprovação do admin, já saiu do disponível.',
    damaged: 'Danificada registrada (Separadas)',
    entrada: 'Enviado pra aprovação',
    count: 'Enviado pra aprovação',
    restock: 'Prateleira reposta',
  };
  function submitToast(kind) { return TOASTS[kind] || TOASTS.pick; }
  // Contagem EXIGE local (o admin aplica o count no bin/caixa informado).
  function validate(w) {
    if (!w || !w.sel) return 'Escolha o suplemento';
    var qty = parseInt(w.qty, 10);
    if (!qty || qty < 1) return 'Quantidade inválida';
    if (qty > 5000) return 'Quantidade muito alta';
    if (w.kind === 'count' && !w.dest) return 'Escolha onde você contou';
    return null;
  }
  // bins/boxes do contexto filtrados pelo produto escolhido
  function placesFor(ctx, productId) {
    var c = ctx || {};
    var pid = productId == null ? null : parseInt(productId, 10);
    var pick = function (arr) {
      return (arr || []).filter(function (x) {
        if (pid == null) return true;
        return x.product_id == null || parseInt(x.product_id, 10) === pid;
      });
    };
    return { bins: pick(c.bins), boxes: pick(c.boxes) };
  }
  // Card "Repor prateleira": bins com needs_restock + as caixas DAQUELE produto.
  function restockList(ctx) {
    var c = ctx || {};
    var boxes = c.boxes || [];
    return (c.bins || []).filter(function (b) { return !!b.needs_restock; }).map(function (b) {
      return {
        bin: b,
        boxes: boxes.filter(function (x) {
          return b.product_id != null && parseInt(x.product_id, 10) === parseInt(b.product_id, 10) && (parseInt(x.qty, 10) || 0) > 0;
        }),
      };
    }).filter(function (r) { return r.boxes.length > 0; });
  }

  // ════════════════════════════════════════════════════════════
  // ESTADO + DADOS
  // ════════════════════════════════════════════════════════════
  function st() {
    var S = D.S || {};
    S.ws = S.ws || { picklist: null, recent: null, q: '', sel: null, qty: '1', kind: 'pick', reason: '', dest: '', ctx: null, busy: false };
    if (S.ws.dest === undefined) S.ws.dest = '';
    return S.ws;
  }
  function allowed() { return (D.CFG && D.CFG.workspace === true) || D.isSandbox(); }
  function wsTask() {
    return ((D.S && D.S.myTasks) || []).find(function (t) {
      return WS_SLUGS[t.slug] || (D.typeMeta(t.slug) || {}).counts_as_pp;
    }) || null;
  }
  function supps() {
    var w = st();
    var q = (w.q || '').toLowerCase().trim();
    if (!q || q.length < 2) return [];
    return ((D.DATA && D.DATA.supplements) || []).filter(function (s) {
      if ((s.canonical_name || '').toLowerCase().indexOf(q) >= 0) return true;
      return (s.aliases || []).some(function (a) { return String(a).toLowerCase().indexOf(q) >= 0; });
    }).slice(0, 8);
  }
  function loadRecent() {
    var w = st();
    return D.api('/api/v3/op/stock/recent').then(function (r) { w.recent = (r && r.items) || []; D.render(); })
      .catch(function () { w.recent = []; D.render(); });
  }
  function loadContext() {
    var w = st();
    return D.api('/api/v3/op/stock/context').then(function (r) { w.ctx = r || { enabled: false }; D.render(); })
      .catch(function () { w.ctx = { enabled: false, bins: [], boxes: [] }; D.render(); });
  }
  function load() {
    var w = st();
    D.api('/api/v3/op/picklist').then(function (r) { w.picklist = r; D.render(); }).catch(function () { w.picklist = { groups: [], total_orders: 0 }; D.render(); });
    loadRecent();
    loadContext();
    // falta de estoque cruzada com o EMS (pode demorar: Veeqo + EMS)
    D.api('/api/v3/op/stock-gaps').then(function (r) { w.gaps = r; D.render(); }).catch(function () { w.gaps = { items: [] }; D.render(); });
  }

  // ════════════════════════════════════════════════════════════
  // HTML
  // ════════════════════════════════════════════════════════════
  function banner() {
    if (!allowed() || !wsTask()) return '';
    return '<div style="background:linear-gradient(135deg,#0d1f3c,#1a3a6b); border-radius:20px; padding:18px 20px; display:flex; align-items:center; gap:16px; box-shadow:0 22px 44px -20px rgba(13,31,60,.6);">'
      + '<span style="flex:none; width:50px; height:50px; border-radius:16px; background:rgba(255,255,255,.12); display:flex; align-items:center; justify-content:center; font-size:26px;">📦</span>'
      + '<div style="flex:1; min-width:0;"><div style="font-family:Georgia,serif; font-weight:400; font-size:21px; color:#fff; line-height:1.1;">Central de <em style="color:#7fd696; font-style:italic;">P&amp;P &amp; Estoque</em></div>'
      + '<div style="font-size:13px; color:rgba(255,255,255,.75); margin-top:2px;">Picklist do dia, registrar saída de estoque e organização</div></div>'
      + '<button data-act="openWorkspace" style="border:0; cursor:pointer; border-radius:999px; height:46px; padding:0 26px; background:#fff; color:#0d1f3c; font-weight:800; font-size:15px; font-family:' + SORA + '; box-shadow:0 10px 24px -10px rgba(0,0,0,.4);">Abrir</button>'
      + '</div>';
  }

  // Painel "Falta de estoque": o que está zerado/baixo pro P&P de hoje + o EMS.
  function gapsHtml() {
    var w = st();
    var g = w.gaps;
    if (!g) return '<div style="color:' + T.mute2 + '; font-size:12.5px;">verificando estoque…</div>';
    var items = g.items || [];
    if (!items.length) return '<div style="color:' + T.okFg + '; font-size:13px; font-weight:600;">✓ Tudo que precisa hoje tem estoque.</div>';
    var h = '';
    items.forEach(function (x) {
      var crit = x.severity === 'critical';
      h += '<div style="border-radius:12px; padding:10px 12px; margin-bottom:8px; background:' + (crit ? T.badBg : T.warnBg)
        + '; border:1px solid ' + (crit ? T.badLn : T.warnLn) + ';">'
        + '<div style="display:flex; align-items:baseline; gap:8px; flex-wrap:wrap;">'
        + '<span style="font-weight:800; font-size:13.5px; color:' + (crit ? T.badFg : T.warnFg) + ';">' + D.esc(x.product || x.sku) + '</span>'
        + '<span style="font-family:' + MONO + '; font-size:11px; color:' + T.muted + ';">precisa ' + x.needed + ' · tem ' + x.stock + '</span>'
        + (x.status === 'out' ? '<span style="height:19px; display:inline-flex; align-items:center; padding:0 8px; border-radius:999px; font-family:' + MONO + '; font-size:10px; background:' + T.badFg + '; color:#fff; font-weight:700;">ZERADO</span>' : '')
        + '</div>'
        + '<div style="font-size:12.5px; color:' + (crit ? T.badFg : T.warnFg) + '; margin-top:3px; font-weight:' + (crit ? '700' : '500') + ';">' + D.esc(x.advice) + '</div>'
        + '</div>';
    });
    return h;
  }

  // ENVELOPES no topo do papel: quantos de cada tamanho separar (1 por ORDEM).
  function envelopesHtml(pl) {
    var env = (pl && pl.envelopes) || {};
    var sizes = Object.keys(env).sort(function (a, b) {
      if (a === 'BX') return 1; if (b === 'BX') return -1;   // caixa por último
      return (parseFloat(a) || 0) - (parseFloat(b) || 0);
    });
    if (!sizes.length && !(pl && pl.envelopes_unknown)) return '';
    var h = '<div class="env"><span class="ttl">ENVELOPES:</span> ';
    sizes.forEach(function (s) { h += '<span class="e">' + D.esc(s) + ' <b>' + env[s] + '</b></span>'; });
    var pend = (pl.envelopes_unknown || 0) + (pl.envelopes_mixed || 0);
    if (pend) h += '<span class="warn">+ ' + pend + ' outras a definir</span>';
    return h + '</div>';
  }

  // PRINT 4x6: linha 1 = SKU + nome/mg/caps; linha do meio = LOCATION e QTY
  // em MAIÚSCULAS GRANDES (difícil de errar).
  function print() {
    var w = st();
    if (!w.picklist || !(w.picklist.groups || []).length) { D.toast('Picklist vazia'); return; }
    var rows = '';
    (w.picklist.groups || []).forEach(function (g) {
      var tot = (g.orders || []).reduce(function (n, o) { return n + (Number(o.bottles) || 0); }, 0);
      rows += '<div class="row">'
        + '<div class="id"><span class="sku">' + D.esc(g.sku || '?') + '</span> <span class="nm">' + D.esc(printTitle(g)) + '</span></div>'
        + '<div class="big"><span class="loc">' + D.esc(locationOf(g)) + '</span><span class="qty">QTY <b>' + tot + '</b></span></div>'
        + '</div>';
    });
    var doc = '<!doctype html><html><head><meta charset="utf-8"><title>Picklist</title><style>'
      + '@page { size: 4in 6in; margin: 0.12in; }'
      + 'body { font-family: Arial, Helvetica, sans-serif; margin: 0; color: #000; }'
      + '.hdr { font-size: 10px; font-weight: bold; border-bottom: 2px solid #000; padding: 1px 0 3px; }'
      + '.env { font-size: 11px; font-weight: 900; border-bottom: 2px solid #000; padding: 3px 0 4px; margin-bottom: 3px; }'
      + '.env .ttl { font-size: 8.5px; font-weight: bold; letter-spacing: .06em; }'
      + '.env .e { display: inline-block; margin-right: 10px; }'
      + '.env .e b { font-size: 15px; }'
      + '.env .warn { display: block; font-size: 8.5px; font-weight: bold; margin-top: 1px; }'
      + '.row { break-inside: avoid; border-bottom: 1.5px solid #000; padding: 4px 0 5px; }'
      + '.id { font-size: 10px; line-height: 1.15; }'
      + '.sku { font-family: Consolas, monospace; font-weight: bold; }'
      + '.nm { font-weight: bold; }'
      + '.big { display: flex; justify-content: space-between; align-items: baseline; margin-top: 2px; }'
      + '.loc { font-size: 17px; font-weight: 900; letter-spacing: .01em; }'
      + '.qty { font-size: 14px; font-weight: 900; white-space: nowrap; margin-left: 8px; }'
      + '.qty b { font-size: 22px; }'
      + '</style></head><body>'
      + '<div class="hdr">PICKLIST &middot; ' + D.esc(new Date().toLocaleDateString('pt-BR')) + ' &middot; '
      + (w.picklist.total_orders || 0) + ' ORDENS &middot; ' + (w.picklist.total_bottles || 0) + ' BOTTLES</div>'
      + envelopesHtml(w.picklist)
      + rows + '<script>window.onload=function(){window.print();}<\/script></body></html>';
    var win = D.openWindow();
    if (!win) { D.toast('Popup bloqueado. Libera popup pra imprimir'); return; }
    win.document.write(doc); win.document.close();
  }

  function key() {
    var S = D.S || {};
    if (!S.workspaceOpen) return 'ws-off';
    var w = st();
    return 'ws|' + w.q + '|' + (w.sel ? w.sel.id : 0) + '|' + w.qty + '|' + w.kind + '|' + (w.dest || '') + '|' + (w.busy ? 1 : 0)
      + '|' + (w.picklist ? (w.picklist.total_orders + '.' + (w.picklist.groups || []).length) : 'L')
      + '|' + (w.recent ? w.recent.length : 'L')
      + '|' + (w.ctx ? restockList(w.ctx).length : 'L')
      // gaps chega por último (Veeqo+EMS): sem ele na key a camada nunca remontava
      // e o card ficava preso em "verificando estoque".
      + '|' + (w.gaps ? ((w.gaps.items || []).length + '.' + (w.gaps.out_count || 0)) : 'L');
  }

  // ── coluna 2: segmento Registrar ────────────────────────────
  var SEG = [
    { k: 'pick', label: 'Peguei do estoque', on: T.ink },
    { k: 'damaged', label: 'Danificada', on: T.badFg },
    { k: 'entrada', label: 'Entrada', on: T.okFg },
    { k: 'count', label: 'Contagem', on: T.neuFg },
  ];
  function segHtml(w) {
    var h = '<div style="display:inline-flex; flex-wrap:wrap; border:1px solid ' + T.line + '; border-radius:10px; overflow:hidden; margin-bottom:12px;">';
    SEG.forEach(function (s) {
      var on = w.kind === s.k;
      h += '<button data-act="wsKind" data-arg="' + s.k + '" style="padding:9px 14px; border:0; cursor:pointer; font-weight:700; font-size:13px; background:' + (on ? s.on : '#fff') + '; color:' + (on ? '#fff' : T.muted) + ';">' + s.label + '</button>';
    });
    return h + '</div>';
  }
  function destHtml(w) {
    if (!isProposal(w.kind)) return '';
    var req = w.kind === 'count';
    var pl = placesFor(w.ctx, w.sel && w.sel.id);
    var h = '<div style="margin-bottom:12px;">'
      + '<div style="font-family:' + MONO + '; font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:' + T.mute2 + '; margin-bottom:6px;">'
      + (req ? 'Onde você contou (obrigatório)' : 'Onde guardou (opcional)') + '</div>';
    if (!w.ctx) h += '<div style="color:' + T.mute2 + '; font-size:12.5px;">carregando locais&hellip;</div>';
    else if (!pl.bins.length && !pl.boxes.length) h += '<div style="color:' + T.mute2 + '; font-size:12.5px;">nenhum local cadastrado pra esse produto.</div>';
    else {
      h += '<div style="display:flex; flex-wrap:wrap; gap:7px;">';
      if (!req) h += destBtn(w, '', 'sem local');
      pl.bins.forEach(function (b) { h += destBtn(w, 'bin:' + b.id, placeLabel(b)); });
      pl.boxes.forEach(function (x) { h += destBtn(w, 'box:' + x.id, placeLabel(x)); });
      h += '</div>';
    }
    return h + '</div>';
  }
  function destBtn(w, val, label) {
    var on = String(w.dest || '') === val;
    return '<button data-act="wsDest" data-arg="' + val + '" style="border:1px solid ' + (on ? T.ink : T.line) + '; cursor:pointer; border-radius:999px; height:32px; padding:0 14px; font-family:' + MONO + '; font-size:11.5px; font-weight:700; background:' + (on ? T.ink : '#fff') + '; color:' + (on ? '#fff' : T.muted) + ';">' + D.esc(label) + '</button>';
  }
  function submitLabel(w) {
    if (w.busy) return 'Registrando&hellip;';
    if (w.kind === 'damaged') return 'Registrar danificada';
    if (w.kind === 'entrada') return 'Enviar entrada';
    if (w.kind === 'count') return 'Enviar contagem';
    return 'Registrar sa&iacute;da';
  }
  function reasonPlaceholder(w) {
    if (w.kind === 'damaged') return 'o que aconteceu? (opcional)';
    if (w.kind === 'entrada') return 'de onde veio? (opcional)';
    if (w.kind === 'count') return 'observa&ccedil;&atilde;o da contagem (opcional)';
    return 'motivo &middot; ex.: extra pro pedido 12-345 (opcional)';
  }

  // ── card "Repor prateleira" ─────────────────────────────────
  function restockHtml() {
    var w = st();
    var h = '<div style="' + CARD + ' padding:16px 20px;">' + microLbl('Repor prateleira');
    if (!w.ctx) { return h + '<div style="color:' + T.mute2 + '; font-size:12.5px; margin-top:8px;">carregando&hellip;</div></div>'; }
    var rows = restockList(w.ctx);
    if (!rows.length) return h + '<div style="color:' + T.okFg + '; font-size:13px; font-weight:600; margin-top:8px;">✓ Nenhuma prateleira precisando repor.</div></div>';
    rows.forEach(function (r) {
      var b = r.bin;
      h += '<div style="border-top:1px dotted ' + T.dot + '; padding:9px 2px; display:flex; flex-direction:column; gap:6px;">'
        + '<div style="display:flex; align-items:baseline; gap:8px; flex-wrap:wrap;">'
        + '<span style="font-family:' + MONO + '; font-size:13px; font-weight:700; color:' + T.ink + ';">' + D.esc(placeLabel(b)) + '</span>'
        + '<span style="flex:1; min-width:0; font-size:13px; color:' + T.ink2 + '; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + D.esc(b.product || '') + '</span>'
        + chip('tem ' + (b.qty || 0) + ' &middot; m&iacute;n ' + (b.min_qty || 0), T.warnBg, T.warnFg, T.warnLn)
        + '</div><div style="display:flex; flex-wrap:wrap; gap:7px;">';
      r.boxes.forEach(function (x) {
        var q = restockQty(b, x);
        h += '<button data-act="wsRestock" data-arg="' + b.id + ':' + x.id + '" ' + (w.busy ? 'disabled' : '')
          + ' style="border:0; cursor:pointer; border-radius:999px; height:34px; padding:0 16px; background:' + T.ink + '; color:#fff; font-weight:800; font-size:12.5px; font-family:' + SORA + ';">Repor ' + q + ' &middot; ' + D.esc(placeLabel(x)) + '</button>';
      });
      h += '</div></div>';
    });
    return h + '</div>';
  }

  // ── "Registrado hoje" ───────────────────────────────────────
  function recentHtml() {
    var w = st();
    var h = '<div style="' + CARD + ' padding:16px 20px;">' + microLbl('Registrado hoje');
    if (!w.recent) return h + '<div style="color:' + T.mute2 + '; font-size:12.5px; margin-top:8px;">carregando&hellip;</div></div>';
    if (!w.recent.length) return h + '<div style="color:' + T.mute2 + '; font-size:12.5px; margin-top:8px;">Nada registrado ainda.</div></div>';
    w.recent.forEach(function (r) {
      var sc = statusChip(r.status);
      h += '<div style="border-top:1px dotted ' + T.dot + '; padding:7px 2px; display:flex; align-items:center; gap:8px; font-size:13px;">'
        + '<span style="flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:' + T.ink2 + '; font-weight:600;">' + D.esc(r.nickname || r.product) + '</span>'
        + '<span style="font-family:' + MONO + '; font-size:12px; color:' + T.ink + '; font-weight:700;">&times;' + r.qty + '</span>'
        + chip(D.esc(kindLabel(r.kind)), T.neuBg, T.neuFg, T.neuLn)
        + chip(sc.label, sc.bg, sc.fg, sc.ln)
        + '</div>';
    });
    return h + '</div>';
  }

  function inner() {
    var w = st();
    var h = '<div style="position:absolute; inset:0; display:flex; flex-direction:column; background:#f4f8fc; background-image:radial-gradient(circle,rgba(26,58,107,.06) 1px,transparent 1px); background-size:26px 26px;">';
    // header
    h += '<div style="flex:none; display:flex; align-items:center; gap:16px; padding:22px 34px 8px;">'
      + '<button data-act="closeWorkspace" style="border:1px solid ' + T.line + '; background:#fff; cursor:pointer; border-radius:999px; height:42px; padding:0 20px; font-weight:700; font-size:14px; color:' + T.ink2 + '; font-family:' + SORA + ';">&larr; Voltar</button>'
      + '<div style="flex:1; min-width:0;"><div style="font-family:' + MONO + '; font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:' + T.green + '; font-weight:600;">&#9679; HEALTHFARE P&amp;P &middot; CENTRAL</div>'
      + '<div style="font-family:' + SERIF + '; font-weight:400; font-size:30px; color:' + T.ink + '; line-height:1.05;">Central de <em style="color:' + T.green + ';">P&amp;P &amp; Estoque</em></div></div>'
      + (D.isSandbox() ? '<span style="height:24px; display:inline-flex; align-items:center; padding:0 12px; border-radius:999px; font-family:' + MONO + '; font-size:11px; background:rgba(10,154,166,.12); color:#06707a; box-shadow:inset 0 0 0 1px rgba(10,154,166,.35);">sandbox &middot; n&atilde;o conta no estoque real</span>' : '')
      + '<button data-act="wsPrint" style="border:0; cursor:pointer; border-radius:999px; height:46px; padding:0 26px; background:' + T.ink + '; color:#fff; font-weight:800; font-size:15px; font-family:' + SORA + '; box-shadow:0 10px 24px -10px rgba(13,31,60,.5); display:inline-flex; align-items:center; gap:8px;">&#128424; PRINT</button>'
      + '</div>';
    // body: 2 colunas
    h += '<div class="hf-scroll" style="flex:1; overflow-y:auto; padding:14px 34px 40px;"><div style="display:grid; grid-template-columns:1.2fr 1fr; gap:20px; max-width:1240px; margin:0 auto;">';

    // ── FALTA DE ESTOQUE (largura toda, antes das colunas)
    var gp = w.gaps;
    if (!gp || (gp.items || []).length) {
      var nCrit = gp ? (gp.critical_count || 0) : 0;
      h += '<div style="grid-column:1 / -1; background:#fff; border:1px solid ' + (nCrit ? T.badLn : T.line)
        + '; border-radius:18px; box-shadow:0 1px 2px rgba(13,31,60,.03),0 10px 30px rgba(13,31,60,.05); padding:16px 20px;">'
        + '<div style="display:flex; align-items:baseline; gap:10px; margin-bottom:10px;">'
        + microLbl('Falta de estoque pro P&amp;P de hoje')
        + (gp && gp.out_count ? '<span style="height:20px; display:inline-flex; align-items:center; padding:0 9px; border-radius:999px; font-family:' + MONO + '; font-size:10.5px; background:' + T.badBg + '; color:' + T.badFg + '; font-weight:800; box-shadow:inset 0 0 0 1px ' + T.badLn + ';">' + gp.out_count + ' zerado(s)</span>' : '')
        + (gp && gp.low_count ? '<span style="height:20px; display:inline-flex; align-items:center; padding:0 9px; border-radius:999px; font-family:' + MONO + '; font-size:10.5px; background:' + T.warnBg + '; color:' + T.warnFg + '; font-weight:800; box-shadow:inset 0 0 0 1px ' + T.warnLn + ';">' + gp.low_count + ' baixo(s)</span>' : '')
        + '</div>' + gapsHtml() + '</div>';
    }

    // ── coluna 1: PICKLIST
    h += '<div style="' + CARD + ' padding:18px 20px;">';
    h += '<div style="display:flex; align-items:baseline; gap:10px; margin-bottom:10px;">' + microLbl('Imprimir ordem &middot; picklist de hoje') + '<span style="flex:1;"></span>'
      + '<button data-act="wsReload" style="border:1px solid ' + T.line + '; background:' + T.soft + '; cursor:pointer; border-radius:999px; height:30px; padding:0 14px; font-size:12px; font-weight:700; color:' + T.ink2 + ';">Atualizar</button></div>';
    if (!w.picklist) h += '<div style="color:' + T.mute2 + '; font-size:13px; padding:14px 0;">Carregando picklist&hellip;</div>';
    else if (!(w.picklist.groups || []).length) h += '<div style="color:' + T.mute2 + '; font-size:13px; padding:14px 0;">Nenhum pedido pendente pra separar agora.</div>';
    else {
      h += '<div style="display:flex; gap:8px; margin-bottom:12px;">'
        + '<span style="height:24px; display:inline-flex; align-items:center; padding:0 12px; border-radius:999px; font-family:' + MONO + '; font-size:11px; background:' + T.neuBg + '; color:' + T.neuFg + '; box-shadow:inset 0 0 0 1px ' + T.line + ';">' + w.picklist.total_orders + ' pedidos</span>'
        + '<span style="height:24px; display:inline-flex; align-items:center; padding:0 12px; border-radius:999px; font-family:' + MONO + '; font-size:11px; background:' + T.neuBg + '; color:' + T.neuFg + '; box-shadow:inset 0 0 0 1px ' + T.line + ';">' + (w.picklist.total_bottles || 0) + ' garrafas</span>'
        + '<span style="height:24px; display:inline-flex; align-items:center; padding:0 12px; border-radius:999px; font-family:' + MONO + '; font-size:11px; background:' + T.neuBg + '; color:' + T.neuFg + '; box-shadow:inset 0 0 0 1px ' + T.line + ';">' + (w.picklist.product_count || (w.picklist.groups || []).length) + ' produtos</span></div>';
      // ENVELOPES a separar (mesma conta do papel)
      var envK = Object.keys(w.picklist.envelopes || {});
      if (envK.length || w.picklist.envelopes_unknown) {
        h += '<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:-4px 0 12px;">'
          + '<span style="font-family:' + MONO + '; font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:' + T.mute2 + ';">Envelopes:</span>';
        envK.sort(function (a, b) { if (a === 'BX') return 1; if (b === 'BX') return -1; return (parseFloat(a) || 0) - (parseFloat(b) || 0); })
          .forEach(function (s) {
            h += '<span style="height:26px; display:inline-flex; align-items:center; gap:5px; padding:0 12px; border-radius:999px; font-family:' + MONO + '; font-size:12px; background:' + T.ink + '; color:#fff; font-weight:700;">' + D.esc(s) + ' <b style="font-size:14px;">' + w.picklist.envelopes[s] + '</b></span>';
          });
        var pend = (w.picklist.envelopes_unknown || 0) + (w.picklist.envelopes_mixed || 0);
        if (pend) h += '<span style="height:26px; display:inline-flex; align-items:center; padding:0 12px; border-radius:999px; font-family:' + MONO + '; font-size:11px; background:' + T.warnBg + '; color:' + T.warnFg + '; box-shadow:inset 0 0 0 1px ' + T.warnLn + ';">+' + pend + ' sem tamanho</span>';
        h += '</div>';
      }
      (w.picklist.groups || []).forEach(function (g) {
        var loc = [];
        if (g.location && g.location.shelf) loc.push('SHELF ' + g.location.shelf);
        if (g.location && g.location.bin) loc.push('BIN ' + g.location.bin);
        if (g.location && g.location.pallet) loc.push('PALLET ' + g.location.pallet);
        var totBottles = (g.orders || []).reduce(function (n, o) { return n + (Number(o.bottles) || 0); }, 0);
        var lbl = function (t) { return '<span style="font-family:' + MONO + '; font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:' + T.mute2 + ';">' + t + '</span> '; };
        h += '<div style="border-top:1px dotted ' + T.dot + '; padding:10px 2px; display:flex; flex-direction:column; gap:3px;">'
          + '<div style="display:flex; align-items:baseline; gap:10px;">' + lbl('SKU:')
          + '<span style="font-family:' + MONO + '; font-size:14px; font-weight:700; color:' + T.ink + ';">' + D.esc(g.sku || '?') + '</span>'
          + '<span style="flex:1;"></span>'
          + lbl('QTY:') + '<span style="font-family:' + MONO + '; font-size:16px; font-weight:800; color:' + T.ink + ';">' + totBottles + '</span></div>'
          + '<div style="display:flex; align-items:baseline; gap:6px; min-width:0;">' + lbl('Title:')
          + '<span style="font-size:13.5px; color:' + T.ink2 + '; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + D.esc(shortTitle(g)) + '</span></div>'
          + '<div style="display:flex; align-items:baseline; gap:6px;">' + lbl('Location:')
          // escapa CADA parte e só depois junta com o separador (senão o &middot; vira texto)
          + '<span style="font-family:' + MONO + '; font-size:12px; color:' + (loc.length ? T.neuFg : T.mute2) + '; font-weight:600;">' + (loc.length ? loc.map(D.esc).join(' &middot; ') : 'local a definir') + '</span></div>'
          + '</div>';
      });
    }
    h += '</div>';

    // ── coluna 2: REGISTRAR + repor + recentes
    h += '<div style="display:flex; flex-direction:column; gap:16px;">';
    h += '<div style="' + CARD + ' padding:18px 20px;">';
    h += '<div style="margin-bottom:8px;">' + microLbl('Registrar') + '</div>';
    h += '<div style="font-size:12.5px; color:' + T.muted + '; margin-bottom:10px;">Pegou garrafa fora de um pedido, achou uma danificada, guardou entrada nova ou contou a prateleira? Registra aqui em 3 segundos. Nunca trava, s&oacute; registra.</div>';
    if (!w.sel) {
      h += '<input data-input="wsQ" data-focus="wsQ" value="' + D.esc(w.q || '') + '" placeholder="busque o suplemento&hellip;" style="width:100%; box-sizing:border-box; padding:12px 14px; border-radius:12px; border:1px solid ' + T.line + '; font-size:15px; background:' + T.soft + '; color:' + T.ink2 + '; outline:none;">';
      var list = supps();
      if ((w.q || '').length >= 2 && !list.length) h += '<div style="color:' + T.mute2 + '; font-size:12.5px; padding:8px 2px;">nada com &quot;' + D.esc(w.q) + '&quot;</div>';
      list.forEach(function (s) {
        h += '<button data-act="wsPick" data-arg="' + s.id + '" style="display:block; width:100%; text-align:left; border:0; background:none; cursor:pointer; border-bottom:1px dotted ' + T.dot + '; padding:9px 4px; font-size:14.5px; font-weight:600; color:' + T.ink2 + ';">' + D.esc(s.canonical_name) + '</button>';
      });
    } else {
      h += '<div style="display:flex; align-items:center; gap:10px; background:' + T.soft + '; border:1px solid ' + T.line + '; border-radius:12px; padding:10px 14px; margin-bottom:12px;">'
        + '<div style="flex:1; font-family:' + SERIF + '; font-size:19px; color:' + T.ink + ';">' + D.esc(w.sel.canonical_name) + '</div>'
        + '<button data-act="wsClear" style="border:0; background:none; cursor:pointer; color:' + T.mute2 + '; font-size:13px; font-weight:700;">trocar</button></div>';
      // qty stepper
      h += '<div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">'
        + '<button data-act="wsQtyDelta" data-arg="-1" style="border:1px solid ' + T.line + '; background:#fff; cursor:pointer; border-radius:12px; width:52px; height:52px; font-size:26px; color:' + T.ink + ';">&minus;</button>'
        + '<input data-input="wsQty" inputmode="numeric" value="' + D.esc(String(w.qty || '1')) + '" style="width:90px; text-align:center; padding:12px 0; border-radius:12px; border:1px solid ' + T.line + '; font-size:22px; font-weight:800; color:' + T.ink + '; background:#fff;">'
        + '<button data-act="wsQtyDelta" data-arg="1" style="border:1px solid ' + T.line + '; background:#fff; cursor:pointer; border-radius:12px; width:52px; height:52px; font-size:24px; color:' + T.ink + ';">+</button>'
        + '<span style="font-size:13px; color:' + T.muted + ';">garrafas</span></div>';
      // segmento de tipo + destino (entrada/contagem)
      h += segHtml(w);
      h += destHtml(w);
      h += '<input data-input="wsReason" data-focus="wsReason" value="' + D.esc(w.reason || '') + '" placeholder="' + reasonPlaceholder(w) + '" style="width:100%; box-sizing:border-box; padding:11px 14px; border-radius:12px; border:1px solid ' + T.line + '; font-size:14px; background:' + T.soft + '; color:' + T.ink2 + '; outline:none; margin-bottom:14px;">';
      h += '<button data-act="wsSubmit" ' + (w.busy ? 'disabled' : '') + ' style="width:100%; border:0; cursor:pointer; border-radius:999px; height:52px; background:' + T.ink + '; color:#fff; font-weight:800; font-size:16px; font-family:' + SORA + '; box-shadow:0 14px 30px -14px rgba(13,31,60,.6);">' + submitLabel(w) + '</button>';
    }
    h += '</div>';
    h += restockHtml();
    h += recentHtml();
    h += '</div>';        // fim coluna 2
    h += '</div></div>';  // fim grid + scroll
    h += '</div>';
    return h;
  }

  // ════════════════════════════════════════════════════════════
  // ACT handlers (delegados pelo app.js)
  // ════════════════════════════════════════════════════════════
  var acts = {
    openWorkspace: function () { D.S.workspaceOpen = true; load(); D.render(); },
    closeWorkspace: function () { D.S.workspaceOpen = false; D.render(); },
    wsReload: function () { var w = st(); w.picklist = null; load(); D.render(); },
    wsPrint: function () { print(); },
    wsPick: function (arg) {
      var id = parseInt(arg, 10);
      var s = ((D.DATA && D.DATA.supplements) || []).find(function (x) { return x.id === id; });
      if (s) { var w = st(); w.sel = s; w.q = ''; w.dest = ''; D.render(); }
    },
    wsClear: function () { var w = st(); w.sel = null; w.qty = '1'; w.dest = ''; D.render(); },
    wsQtyDelta: function (arg) {
      var w = st();
      w.qty = String(Math.max(1, (parseInt(w.qty, 10) || 1) + parseInt(arg, 10)));
      D.render();
    },
    wsKind: function (arg) {
      var w = st();
      w.kind = KINDS.indexOf(arg) >= 0 ? arg : 'pick';
      if (!isProposal(w.kind)) w.dest = '';
      D.render();
    },
    wsDest: function (arg) { var w = st(); w.dest = arg || ''; D.render(); },
    wsSubmit: function () {
      var w = st(); if (w.busy) return;
      var err = validate(w);
      if (err) { D.toast(err); return; }
      var kind = w.kind;
      w.busy = true; D.render();
      D.api(submitPath(kind), { method: 'POST', body: submitBody(w) })
        .then(function () {
          D.toast(submitToast(kind));
          w.sel = null; w.qty = '1'; w.reason = ''; w.dest = ''; w.busy = false;
          loadRecent();
          if (kind !== 'pick') loadContext();
        })
        .catch(function (e) { w.busy = false; D.toast('Erro: ' + (e && e.message ? e.message : e)); D.render(); });
    },
    // Repor prateleira: um toque, aplica na hora (StockService.restock).
    wsRestock: function (arg) {
      var w = st(); if (w.busy) return;
      var parts = String(arg || '').split(':');
      var binId = parseInt(parts[0], 10), boxId = parseInt(parts[1], 10);
      var ctx = w.ctx || {};
      var bin = (ctx.bins || []).find(function (b) { return b.id === binId; });
      var box = (ctx.boxes || []).find(function (x) { return x.id === boxId; });
      if (!bin || !box) { D.toast('Local n&atilde;o encontrado'); return; }
      w.busy = true; D.render();
      D.api('/api/v3/op/stock/restock', { method: 'POST', body: restockBody(bin, box) })
        .then(function () {
          w.busy = false;
          D.toast(TOASTS.restock);
          loadContext(); loadRecent();
        })
        .catch(function (e) { w.busy = false; D.toast('Erro: ' + (e && e.message ? e.message : e)); D.render(); });
    },
  };

  // inputs (delegados pelo app.js): true = tratei
  function input(k, v) {
    var w = st();
    if (k === 'wsQ') { w.q = v; D.S._focus = 'wsQ'; D.render(); return true; }
    if (k === 'wsQty') { w.qty = v; return true; }
    if (k === 'wsReason') { w.reason = v; return true; }
    return false;
  }

  function init(deps) {
    Object.keys(deps || {}).forEach(function (k) { D[k] = deps[k]; });
    return WS;
  }

  var WS = {
    init: init, acts: acts, input: input,
    banner: banner, load: load, inner: inner, key: key, print: print,
    allowed: allowed, task: wsTask, slugs: WS_SLUGS, state: st,
    // helpers puros (testes)
    _: {
      cleanName: cleanName, mgOf: mgOf, capsOf: capsOf, packOf: packOf,
      shortTitle: shortTitle, printTitle: printTitle, locationOf: locationOf,
      placeLabel: placeLabel, restockQty: restockQty, statusChip: statusChip,
      kindLabel: kindLabel, isProposal: isProposal, submitPath: submitPath,
      takeBody: takeBody, proposeBody: proposeBody, submitBody: submitBody,
      restockBody: restockBody, submitToast: submitToast, validate: validate,
      placesFor: placesFor, restockList: restockList, KINDS: KINDS,
    },
  };
  return WS;
}));
