/* Code 128 encoder (S15 Fase 3) — implementação própria, SEM CDN e SEM
   dependência externa. Gera as barras de um código pra imprimir na etiqueta
   4x6 de prateleira e de caixa (LabelsPrintPage).

   Por que escrever à mão: a etiqueta é impressa e lida por scanner de verdade;
   um CDN quebrado no dia da impressão pararia o armazém. O encoder é pequeno e
   o padrão é estável desde 1981.

   Suporta Code128 B (ASCII 32..126) e Code128 C (pares de dígitos, metade das
   barras). O modo é escolhido automaticamente: trechos de 4 ou mais dígitos em
   posição par viram C, o resto vira B. Isso é o que os leitores esperam e é o
   que mantém a etiqueta estreita pra caber nos 4 polegadas.

   API:
     encode128(text)     → { widths:[n...], modules, text }  (larguras alternando
                            barra/espaço, começando por BARRA)
     svg128(text, opts)  → string com o <svg> pronto (viewBox em módulos)

   Sem travessão em texto de UI (o SVG não tem texto, o código humano é
   desenhado pela página).
*/

// 107 padrões (0..106). Cada string tem 6 dígitos = larguras alternando
// barra/espaço começando por barra. Tabela oficial do Code 128.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '233111',
];

const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;
const STOP = 106;

const isDigit = (ch) => ch >= '0' && ch <= '9';

/** Quantos dígitos seguidos a partir de i. */
function digitRun(s, i) {
  let n = 0;
  while (i + n < s.length && isDigit(s[i + n])) n += 1;
  return n;
}

/* Regra de troca pro modo C (padrão da indústria):
   - no início: 4+ dígitos, ou o texto INTEIRO sendo um número par de dígitos;
   - no meio: 6+ dígitos (a troca custa 1 símbolo, só compensa em run longo);
   - só entra número PAR de dígitos em C; sobrando 1, ele sai em B.

   Codifica o texto em valores de símbolo Code 128 (sem check/stop). */
function toValues(text) {
  const s = String(text);
  const out = [];
  let mode = null;          // 'B' | 'C'
  let i = 0;

  while (i < s.length) {
    const run = digitRun(s, i);
    const atStart = out.length === 0;
    const wholeRest = run === s.length - i;
    // pares completos disponíveis a partir daqui
    const useC = run >= 2 && (
      (atStart && (run >= 4 || (wholeRest && run % 2 === 0)))
      || (!atStart && run >= 6)
      || (mode === 'C' && run >= 2)
    );

    if (useC) {
      // entra (ou continua) em C com um número PAR de dígitos
      const pairs = Math.floor(run / 2);
      if (mode !== 'C') {
        out.push(atStart ? { start: START_C } : { v: CODE_C });
        mode = 'C';
      }
      for (let k = 0; k < pairs; k += 1) {
        out.push({ v: Number(s.slice(i + k * 2, i + k * 2 + 2)) });
      }
      i += pairs * 2;
      continue;
    }

    // modo B: um caractere ASCII imprimível
    if (mode !== 'B') {
      out.push(atStart ? { start: START_B } : { v: CODE_B });
      mode = 'B';
    }
    const code = s.charCodeAt(i);
    // fora de 32..126 vira '?' (a etiqueta nunca usa acento, mas não quebra)
    const val = code >= 32 && code <= 126 ? code - 32 : '?'.charCodeAt(0) - 32;
    out.push({ v: val });
    i += 1;
  }

  if (!out.length) out.push({ start: START_B });   // texto vazio: só start
  return out;
}

/**
 * Codifica `text` em larguras de barra/espaço.
 * @returns {{widths:number[], modules:number, text:string}}
 *   widths[0] é uma BARRA, widths[1] um ESPAÇO, e assim por diante.
 */
export function encode128(text) {
  const parts = toValues(text);
  const start = parts[0].start != null ? parts[0].start : START_B;
  const data = parts.slice(1).map((p) => p.v);

  // checksum = (start + Σ posição × valor) mod 103
  let sum = start;
  data.forEach((v, idx) => { sum += v * (idx + 1); });
  const check = sum % 103;

  const symbols = [start, ...data, check, STOP];
  const widths = [];
  symbols.forEach((sym) => {
    const pat = PATTERNS[sym];
    for (let k = 0; k < pat.length; k += 1) widths.push(Number(pat[k]));
  });
  // barra final obrigatória de 2 módulos do STOP (o padrão '233111' já tem 6
  // elementos; o Code 128 acrescenta ainda 2 módulos de barra de término)
  widths.push(2);

  const modules = widths.reduce((a, b) => a + b, 0);
  return { widths, modules, text: String(text) };
}

/**
 * SVG de barras pronto pra imprimir. viewBox em módulos (largura = nº de
 * módulos, altura = `heightModules`), então o SVG escala sozinho com CSS.
 * @param {string} text
 * @param {{height?:number, className?:string, color?:string}} opts
 */
export function svg128(text, opts = {}) {
  const { widths, modules } = encode128(text);
  const h = opts.height || 40;
  const color = opts.color || '#000';
  let x = 0;
  let bars = '';
  widths.forEach((w, idx) => {
    if (idx % 2 === 0) bars += `<rect x="${x}" y="0" width="${w}" height="${h}" fill="${color}"/>`;
    x += w;
  });
  const cls = opts.className ? ` class="${opts.className}"` : '';
  return `<svg${cls} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${modules} ${h}" `
       + `preserveAspectRatio="none" shape-rendering="crispEdges" role="img" `
       + `aria-label="Code 128 ${String(text).replace(/[<>&"]/g, '')}">${bars}</svg>`;
}

/** Componente-friendly: devolve os rects como array pra montar em JSX. */
export function bars128(text, height = 40) {
  const { widths, modules } = encode128(text);
  const rects = [];
  let x = 0;
  widths.forEach((w, idx) => {
    if (idx % 2 === 0) rects.push({ x, w, h: height });
    x += w;
  });
  return { rects, modules, height };
}

export default { encode128, svg128, bars128 };
