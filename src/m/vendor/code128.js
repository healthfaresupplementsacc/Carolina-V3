'use strict';
/* ============================================================
   HEALTHFARE — Code 128 (B/C) → SVG. Implementacao propria (S15 Fase 3).

   Por que nao uma lib: a etiqueta e impressa do kiosk /op, que roda offline
   e sem CDN. Sao 107 padroes de barra, cabe aqui.

   Uso:
     HF_CODE128.svg('BX-0451', {width: 460, height: 90})  → string <svg>
     HF_CODE128.encode('BX-0451')                          → [103, 34, ...] (codigos)
     HF_CODE128.pattern('BX-0451')                         → '11010010000...' (bits)

   Regras do simbolo:
     - START B (103) para texto, START C (105) para digitos em par;
     - troca pra C (99) quando aparecem 4+ digitos seguidos (par), volta pra B (100);
     - checksum = (start + soma(valor_i * posicao_i)) % 103;
     - STOP = 106 (padrao de 13 modulos, os outros tem 11).
   ============================================================ */
(function (root, factory) {
  var C = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
  if (root) root.HF_CODE128 = C;
}(typeof window !== 'undefined' ? window : null, function () {

  // 107 padroes (0..106). Cada um: larguras de 6 barras/espacos alternando
  // barra-espaco-barra-espaco-barra-espaco, somando 11 modulos (o STOP soma 13).
  var PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
  ];
  var START_B = 103, START_C = 105, CODE_C = 99, CODE_B = 100, STOP = 106;

  function isDigits(s) { return /^[0-9]+$/.test(s); }

  // Quantos digitos seguem a partir de i.
  function digitRun(text, i) {
    var n = 0;
    while (i + n < text.length && text.charCodeAt(i + n) >= 48 && text.charCodeAt(i + n) <= 57) n++;
    return n;
  }

  /**
   * Vale a pena entrar no modo C aqui? Regra classica:
   *  - no inicio: 4+ digitos (ou o texto inteiro sendo digitos pares);
   *  - no meio: 6+ digitos;
   *  e sempre com um numero PAR de digitos pra consumir (o C come de 2 em 2).
   */
  function shouldUseC(run, atStart, isEnd) {
    if (run < 2) return false;
    if (isEnd && run >= 2 && run % 2 === 0) return true;
    if (atStart) return run >= 4;
    return run >= 6;
  }

  /** texto → lista de valores Code128 (sem checksum, sem stop). */
  function encode(text) {
    var s = String(text == null ? '' : text);
    if (!s) return [START_B];
    var out = [];
    var i = 0;
    var mode = null;                                  // 'B' | 'C'

    var startRun = digitRun(s, 0);
    if (shouldUseC(startRun, true, startRun === s.length)) { out.push(START_C); mode = 'C'; }
    else { out.push(START_B); mode = 'B'; }

    while (i < s.length) {
      var run = digitRun(s, i);
      if (mode === 'C') {
        if (run >= 2) {
          // consome pares enquanto sobrar par (deixa 1 digito impar pro modo B)
          var take = run - (run % 2);
          for (var k = 0; k < take; k += 2) out.push(parseInt(s.substr(i + k, 2), 10));
          i += take;
          if (i < s.length) { out.push(CODE_B); mode = 'B'; }
        } else { out.push(CODE_B); mode = 'B'; }
      } else {
        if (shouldUseC(run, false, i + run === s.length)) { out.push(CODE_C); mode = 'C'; continue; }
        var ch = s.charCodeAt(i);
        // Code B cobre ASCII 32..127 → valor = code - 32. Fora disso vira '?'.
        var v = (ch >= 32 && ch <= 127) ? ch - 32 : 31;
        out.push(v);
        i++;
      }
    }
    return out;
  }

  /** checksum modulo 103 (start conta peso 1, os demais peso da posicao). */
  function checksum(codes) {
    var sum = codes[0] || 0;
    for (var i = 1; i < codes.length; i++) sum += codes[i] * i;
    return sum % 103;
  }

  /** codigos → string de bits ('1' = barra, '0' = espaco). */
  function pattern(text) {
    var codes = encode(text);
    var full = codes.concat([checksum(codes), STOP]);
    var bits = '';
    for (var i = 0; i < full.length; i++) {
      var p = PATTERNS[full[i]];
      if (!p) continue;
      for (var j = 0; j < p.length; j++) {
        var w = parseInt(p.charAt(j), 10);
        var on = (j % 2 === 0) ? '1' : '0';           // comeca em barra
        for (var k = 0; k < w; k++) bits += on;
      }
    }
    return bits;
  }

  /** bits → retangulos agrupados (menos nos no SVG, imprime melhor). */
  function bars(bits, moduleW, height) {
    var r = '', i = 0;
    while (i < bits.length) {
      if (bits.charAt(i) === '0') { i++; continue; }
      var n = 0;
      while (i + n < bits.length && bits.charAt(i + n) === '1') n++;
      r += '<rect x="' + (i * moduleW).toFixed(2) + '" y="0" width="' + (n * moduleW).toFixed(2)
        + '" height="' + height + '" fill="#000"/>';
      i += n;
    }
    return r;
  }

  /**
   * SVG pronto pra etiqueta. opts: {width, height, quiet (modulos), text (bool)}
   * A largura do modulo se ajusta pra caber na width pedida (quiet zone inclusa).
   */
  function svg(text, opts) {
    var o = opts || {};
    var W = o.width || 420;
    var H = o.height || 80;
    var quiet = o.quiet == null ? 10 : o.quiet;
    var bits = pattern(text);
    if (!bits) return '';
    var total = bits.length + quiet * 2;
    var mod = W / total;
    var inner = bars(bits, mod, H);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" shape-rendering="crispEdges">'
      + '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fff"/>'
      + '<g transform="translate(' + (quiet * mod).toFixed(2) + ',0)">' + inner + '</g>'
      + '</svg>';
  }

  return { svg: svg, pattern: pattern, encode: encode, checksum: checksum, PATTERNS: PATTERNS,
    START_B: START_B, START_C: START_C, CODE_B: CODE_B, CODE_C: CODE_C, STOP: STOP };
}));
