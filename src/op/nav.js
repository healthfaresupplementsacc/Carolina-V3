'use strict';
/* ============================================================
   HEALTHFARE Operator · MENU PERSISTENTE (nav segmentada).

   UMA fonte pras duas telas do operador:
     /op            (home da linha + Central de P&P)  → ws.js injeta no banner()
     /op/estoque.html (hub de estoque)                → estoque.js no header

   window.HF_NAV.strip(active) devolve o HTML da tira. Os 3 destinos:
     linha    → /op/            (home da linha de produção)
     central  → Central de P&P & Estoque (picklist + PRINT + registrar)
     estoque  → /op/estoque.html (hub do galpão)

   Como cada tira age depende da página:
   - no /op a "Central" é uma CAMADA da própria página, então o botão usa
     data-act="openWorkspace" (act que já existe no ws.js) e "Linha" usa
     data-act="closeWorkspace". Só "Estoque" navega de verdade.
   - no hub tudo é link: "Central" vai pra /op/?ws=1 (deep link que abre a
     Central logo depois do login) e "Linha" pra /op/.

   Visual = STYLE-KIT (pill navy no ativo, branco com borda no resto).
   Alvo de toque >= 44px: a tela é tocada com luva no galpão.
   PT-BR, sem em dash.

   Este arquivo NÃO toca o DOM ao carregar (dá pra exigir em node e testar).
   ============================================================ */
(function (root, factory) {
  var NAV = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = NAV;
  if (root) root.HF_NAV = NAV;
}(typeof window !== 'undefined' ? window : null, function () {

  var T = {
    ink: '#0d1f3c', ink2: '#1c2b3a', muted: '#54687c',
    line: '#d4e2f0', green: '#2e8b3c',
  };
  var SORA = '\'Sora\',sans-serif';
  var MONO = '\'DM Mono\',monospace';

  // Os 3 lugares onde o operador trabalha. A ordem é a do dia dele:
  // linha de produção → separar/imprimir ordens → guardar no estoque.
  var ITEMS = [
    { k: 'linha', label: 'Linha', icon: '🏭', hint: 'Suas tarefas da linha' },
    { k: 'central', label: 'Central de P&P', icon: '🖨', hint: 'Picklist e impressão das ordens' },
    { k: 'estoque', label: 'Estoque', icon: '📦', hint: 'Organizar, contar e repor' },
  ];

  /**
   * O que cada botão faz, por página.
   *   page 'op'  → Central e Linha são camadas (acts do ws.js); Estoque navega.
   *   page 'hub' → tudo é link de volta pro /op.
   * Devolve os atributos do <button>/<a> já prontos.
   */
  function attrsFor(page, k) {
    if (page === 'hub') {
      if (k === 'linha') return { href: '/op/' };
      if (k === 'central') return { href: '/op/?ws=1' };
      return { act: 'go', arg: 'home' };          // já estamos no hub
    }
    if (k === 'linha') return { act: 'closeWorkspace' };
    if (k === 'central') return { act: 'openWorkspace' };
    return { href: '/op/estoque.html' };
  }

  function itemStyle(on) {
    return 'display:inline-flex; align-items:center; justify-content:center; gap:7px;'
      + ' min-height:44px; padding:0 18px; border-radius:999px; cursor:pointer;'
      + ' font-family:' + SORA + '; font-weight:800; font-size:14px; letter-spacing:.01em;'
      + ' text-decoration:none; white-space:nowrap; transition:background .18s, color .18s;'
      + (on
        ? ' border:0; background:' + T.ink + '; color:#fff; box-shadow:0 10px 22px -12px rgba(13,31,60,.7);'
        : ' border:1px solid ' + T.line + '; background:rgba(255,255,255,.92); color:' + T.muted + ';');
  }

  /**
   * A tira. `active` é 'linha' | 'central' | 'estoque'.
   * `opts.page` é 'op' (padrão) ou 'hub'.
   */
  function strip(active, opts) {
    var o = opts || {};
    var page = o.page === 'hub' ? 'hub' : 'op';
    var cur = ITEMS.some(function (i) { return i.k === active; }) ? active : 'linha';
    var h = '<nav data-nav="op" aria-label="Menu do operador"'
      + ' style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;'
      + ' padding:6px; border-radius:999px; background:rgba(255,255,255,.6);'
      + ' border:1px solid rgba(255,255,255,.85); backdrop-filter:blur(14px);'
      + ' box-shadow:0 12px 30px -22px rgba(15,40,90,.5);">';
    ITEMS.forEach(function (it) {
      var on = it.k === cur;
      var a = attrsFor(page, it.k);
      var label = '<span aria-hidden="true" style="font-size:15px;">' + it.icon + '</span>'
        + '<span>' + it.label + '</span>';
      var common = ' data-nav-item="' + it.k + '" title="' + it.hint + '"'
        + (on ? ' aria-current="page"' : '')
        + ' style="' + itemStyle(on) + '"';
      if (a.href) h += '<a href="' + a.href + '"' + common + '>' + label + '</a>';
      else h += '<button type="button" data-act="' + a.act + '"' + (a.arg ? ' data-arg="' + a.arg + '"' : '') + common + '>' + label + '</button>';
    });
    // Uma linha dizendo em que lugar do sistema o operador está, sem gritar.
    h += '<span style="flex:1; min-width:0;"></span>'
      + '<span style="font-family:' + MONO + '; font-size:10px; letter-spacing:.12em;'
      + ' text-transform:uppercase; color:' + T.green + '; font-weight:600; padding-right:10px;">'
      + hintOf(cur) + '</span>';
    return h + '</nav>';
  }

  function hintOf(k) {
    var m = { linha: 'Linha de produção', central: 'P&P do dia', estoque: 'Galpão' };
    return m[k] || m.linha;
  }

  /**
   * Link discreto do hub pra Central: quem entrou no estoque e precisa da
   * picklist não pode ficar procurando onde clicar.
   */
  function crossLink() {
    return '<a href="/op/?ws=1" style="display:inline-flex; align-items:center; gap:8px;'
      + ' min-height:44px; padding:0 16px; border-radius:999px; text-decoration:none;'
      + ' border:1px dashed ' + T.line + '; background:rgba(255,255,255,.7);'
      + ' font-family:' + SORA + '; font-weight:700; font-size:13.5px; color:' + T.ink2 + ';">'
      + '<span aria-hidden="true">🖨</span>'
      + 'Precisa da picklist ou imprimir? Central de P&amp;P</a>';
  }

  return { strip: strip, crossLink: crossLink, ITEMS: ITEMS, _: { attrsFor: attrsFor, hintOf: hintOf } };
}));
