'use strict';
/* ============================================================
   HEALTHFARE · RENDERIZADOR ÚNICO DE ETIQUETA 4x6 (/shared/label-sheet.js)

   Por que existe: até agora o MESMO desenho de etiqueta estava copiado em
   src/op/estoque.js (openLabel) e em src/op/ws.js (printLabel). Duas cópias =
   duas etiquetas diferentes da mesma caixa no dia em que alguém mexe numa só,
   e a caixa no palete fica com identificação que não bate. Agora é UM lugar:
   estoque.js, ws.js, a estação /print e a fila do celular chamam daqui.

   Uso:
     window.HF_LABELS.sheetHtml(labels, {title})  → documento HTML completo,
       uma folha 4x6 por etiqueta, com window.print() no onload;
     window.HF_LABELS.labelHtml(label)            → só o corpo de UMA etiqueta.

   Cada label = { kind:'bin'|'box', code, line2, line3, url }.
   A variante 'box' mostra produto (line2) e quantidade/lote (line3): é o mesmo
   contrato que o backend devolve em GET /api/v3/warehouse/labels.

   Depende de dois globais já vendorados (SEM CDN, a estação é offline):
     window.HF_CODE128 (/op/vendor/code128.js) → barras Code 128;
     window.qrcode     (/op/vendor/qrcode.min.js) → QR da URL do local.
   Se algum faltar, a etiqueta SAI MESMO ASSIM, só sem aquela parte: papel com o
   código humano gigante ainda serve pro operador; papel nenhum não serve.

   PT-BR, sem em dash. Este arquivo não toca o DOM ao carregar (dá pra exigir
   em node e testar).
   ============================================================ */
(function (root, factory) {
  var L = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = L;
  if (root) root.HF_LABELS = L;
}(typeof window !== 'undefined' ? window : null, function () {

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /** Barras Code 128 como SVG. Sem a lib vendorada devolve ''. */
  function barcodeSvg(code) {
    var W = typeof window !== 'undefined' ? window : null;
    var C128 = (W && W.HF_CODE128) || (typeof global !== 'undefined' && global.HF_CODE128) || null;
    if (!C128 || !code) return '';
    try { return C128.svg(String(code), { width: 520, height: 90 }); } catch (e) { return ''; }
  }

  /** QR pequeno da URL do local. Sem a lib vendorada devolve ''. */
  function qrTag(text) {
    var W = typeof window !== 'undefined' ? window : null;
    var QR = (W && W.qrcode) || (typeof global !== 'undefined' && global.qrcode) || null;
    if (!QR || !text) return '';
    try {
      var q = QR(0, 'M');
      q.addData(String(text));
      q.make();
      return q.createSvgTag({ cellSize: 3, margin: 0 });
    } catch (e) { return ''; }
  }

  /* CSS da folha. É EXATAMENTE o mesmo que estava inline no estoque.js e no
     ws.js (mesmos tamanhos, mesmas margens): a etiqueta impressa hoje e a de
     amanhã têm que sair idênticas. A única adição é .sheet-page, que separa
     as folhas quando vem mais de uma etiqueta de uma vez. */
  var CSS = ''
    + '@page { size: 4in 6in; margin: 0.15in; }'
    + 'body { font-family: Arial, Helvetica, sans-serif; margin:0; color:#000; }'
    + '.sheet-page { page-break-after: always; break-after: page; }'
    + '.sheet-page:last-child { page-break-after: auto; break-after: auto; }'
    + '.code { font-size: 54px; font-weight: 900; letter-spacing:.02em; line-height:1; margin-bottom:8px; }'
    + '.l2 { font-size: 19px; font-weight: 700; line-height:1.15; margin-bottom:4px; }'
    + '.l3 { font-size: 16px; font-weight: 700; margin-bottom:10px; }'
    + '.bar { margin: 6px 0 4px; }'
    + '.foot { display:flex; align-items:flex-end; justify-content:space-between; margin-top:8px; }'
    + '.qr { width:96px; height:96px; }'
    + '.hf { font-size:10px; font-weight:700; letter-spacing:.08em; }';

  /**
   * Corpo de UMA etiqueta (sem <html>): código gigante, linha do produto,
   * linha de quantidade/lote, barras e o rodapé HEALTHFARE + QR.
   */
  function labelHtml(label) {
    var L = label || {};
    var code = String(L.code == null ? '' : L.code);
    return '<div class="code">' + esc(code) + '</div>'
      + (L.line2 ? '<div class="l2">' + esc(L.line2) + '</div>' : '')
      + (L.line3 ? '<div class="l3">' + esc(L.line3) + '</div>' : '')
      + '<div class="bar">' + barcodeSvg(code) + '</div>'
      + '<div class="foot"><div class="hf">HEALTHFARE</div><div class="qr">' + qrTag(L.url || code) + '</div></div>';
  }

  /**
   * Documento inteiro pronto pro window.open + document.write.
   * Uma folha 4x6 por etiqueta; imprime sozinho ao carregar.
   */
  function sheetHtml(labels, opts) {
    var list = Array.isArray(labels) ? labels : (labels ? [labels] : []);
    var o = opts || {};
    var title = o.title || (list.length === 1 ? 'Etiqueta ' + String((list[0] && list[0].code) || '') : 'Etiquetas (' + list.length + ')');
    var pages = list.map(function (L) {
      return '<div class="sheet-page">' + labelHtml(L) + '</div>';
    }).join('');
    if (!pages) pages = '<div class="sheet-page"><div class="l2">Nenhuma etiqueta pra imprimir.</div></div>';
    return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>' + esc(title) + '</title>'
      + '<style>' + CSS + '</style></head><body>'
      + pages
      + '<script>window.onload=function(){window.print();}<\/script>'
      + '</body></html>';
  }

  return { sheetHtml: sheetHtml, labelHtml: labelHtml, _: { esc: esc, CSS: CSS } };
}));
