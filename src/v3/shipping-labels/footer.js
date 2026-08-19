'use strict';
/**
 * HEALTHFARE V3 — RODAPÉ DA ETIQUETA + FOLHA DIVISÓRIA (S15.37).
 *
 * O que a Veeqo entrega é uma página 4x6 (288x432pt, conferido nos três PDFs
 * reais de 08-19) com a faixa de baixo — os ~0.6in abaixo do tracking — em
 * branco. É lá que a nossa linha entra:
 *
 *   BENF-300  ·  A03B2  ·  3 gar  ·  9x12  ·  Pick: 5  Pack: 10
 *
 * POR QUE UMA LINHA SÓ, E POR QUE NESSA ORDEM
 * Quem lê isso está com a etiqueta na mão e o pacote na outra, com pressa. A
 * ordem é a ordem das perguntas: o QUE é (nickname), ONDE pego (local), QUANTAS
 * garrafas, QUE envelope, e por último quem responde por isso. Duas linhas
 * exigiriam escolher o que ler primeiro; uma linha se lê inteira de um golpe.
 *
 * POR QUE UMA TARJA BRANCA POR BAIXO
 * A gente desenha um retângulo branco de 0.30in antes do texto. Sem ele, se a
 * Veeqo um dia mudar o layout e encostar algum texto ali embaixo, o nosso rodapé
 * imprimiria POR CIMA do deles e sairia um borrão ilegível. A tarja garante que
 * a nossa linha sempre nasce em papel limpo. Ela cobre só 0.30in dos 0.6in
 * livres, então nunca chega perto do tracking/código de barras.
 *
 * INTERROGAÇÃO EM VEZ DE PALPITE
 * Envelope desconhecido vira '?', picker/packer desconhecido vira '?'. Nunca
 * inventamos: um '?' faz o operador olhar; um chute faz ele confiar e errar.
 *
 * DM Serif (a fonte da STYLE-KIT) não existe no pdf-lib sem embutir arquivo de
 * fonte, então divisória usa Helvetica-Bold. É papel de armazém, não editorial.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PT_PER_IN = 72;
const PAGE_W = 4 * PT_PER_IN;    // 288
const PAGE_H = 6 * PT_PER_IN;    // 432
/** altura da tarja branca; o espaço livre da Veeqo é ~0.6in, usamos metade */
const STRIP_H = 0.30 * PT_PER_IN;  // 21.6
const FONT_SIZE = 8;
const SEP = '  ·  ';

/** Junta os pedaços do rodapé já com os '?' no lugar do que não se sabe. */
function footerText(info = {}) {
  const nicks = (info.nicknames || []).filter(Boolean);
  let nick = nicks[0] || (info.sku || '?');
  if (nicks.length > 1) nick += ' +' + (nicks.length - 1);

  const local = info.bin_code || info.shelf_code || 'sem local';
  const bottles = Number(info.bottles) || 0;
  const env = info.envelope || '?';

  const pickers = (info.picker_ids || []).filter((x) => x != null && String(x).trim() !== '');
  const pick = pickers.length ? pickers.join(',') : '?';
  const pack = (info.packer_id != null && String(info.packer_id).trim() !== '')
    ? String(info.packer_id) : '?';

  return [nick, local, bottles + ' gar', env].join(SEP)
    + SEP + 'Pick: ' + pick + '  Pack: ' + pack;
}

/**
 * Encolhe a fonte até a linha caber na largura da página. Cortar com "..." seria
 * pior: o pedaço cortado é justamente o Pick/Pack do fim. 8pt é o normal; um
 * pedido misto com nickname comprido desce até 6pt e ainda se lê.
 */
function fitSize(font, text, maxWidth, start = FONT_SIZE, min = 6) {
  let size = start;
  while (size > min && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.5;
  return size;
}

/**
 * Carimba o rodapé na primeira página de um PDF de etiqueta e devolve a página
 * já COPIADA dentro de `out` (o doc de saída). Trabalhar direto no doc de saída
 * evita reabrir/reserializar cada etiqueta duas vezes.
 *
 * @param {PDFDocument} out  documento de saída
 * @param {Buffer|Uint8Array} labelBytes  PDF de UMA etiqueta (da Veeqo)
 * @param {object} info  ver footerText()
 * @param {object} fonts {helv}
 */
async function stampLabel(out, labelBytes, info, fonts) {
  const src = await PDFDocument.load(labelBytes);
  const [page] = await out.copyPages(src, [0]);
  out.addPage(page);

  const { width } = page.getSize();
  const text = footerText(info);
  const size = fitSize(fonts.helv, text, width - 12);

  // tarja branca: papel limpo garantido pra nossa linha
  page.drawRectangle({
    x: 0, y: 0, width, height: STRIP_H, color: rgb(1, 1, 1),
  });
  page.drawText(text, {
    x: 6,
    y: (STRIP_H - size) / 2 + 1,
    size,
    font: fonts.helv,
    color: rgb(0, 0, 0),
  });
  return page;
}

/**
 * Folha divisória de um grupo de produto. Preto no branco, grande, sem enfeite:
 * ela existe pra ser vista de longe no meio de uma pilha de etiquetas, enquanto
 * alguém separa as pilhas por produto.
 *
 * @param {PDFDocument} out
 * @param {object} g {nickname, count, location, envelope}
 * @param {object} fonts {helv, bold}
 */
function addDivider(out, g, fonts) {
  const page = out.addPage([PAGE_W, PAGE_H]);
  const cx = PAGE_W / 2;

  const nick = String(g.nickname || '?');
  // nickname grande, encolhendo até caber na largura da folha
  const nickSize = fitSize(fonts.bold, nick, PAGE_W - 32, 28, 12);
  page.drawText(nick, {
    x: cx - fonts.bold.widthOfTextAtSize(nick, nickSize) / 2,
    y: PAGE_H / 2 + 40, size: nickSize, font: fonts.bold, color: rgb(0, 0, 0),
  });

  const count = String(g.count || 0) + (Number(g.count) === 1 ? ' etiqueta' : ' etiquetas');
  page.drawText(count, {
    x: cx - fonts.helv.widthOfTextAtSize(count, 14) / 2,
    y: PAGE_H / 2 + 10, size: 14, font: fonts.helv, color: rgb(0, 0, 0),
  });

  const loc = String(g.location || 'sem local');
  page.drawText(loc, {
    x: cx - fonts.bold.widthOfTextAtSize(loc, 18) / 2,
    y: PAGE_H / 2 - 22, size: 18, font: fonts.bold, color: rgb(0, 0, 0),
  });

  if (g.envelope) {
    const env = 'Envelope ' + g.envelope;
    page.drawText(env, {
      x: cx - fonts.helv.widthOfTextAtSize(env, 12) / 2,
      y: PAGE_H / 2 - 48, size: 12, font: fonts.helv, color: rgb(0, 0, 0),
    });
  }
  return page;
}

/** Fontes padrão embutidas (sem arquivo externo, sem CDN). */
async function loadFonts(doc) {
  return {
    helv: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
}

module.exports = {
  footerText, stampLabel, addDivider, loadFonts, fitSize,
  PAGE_W, PAGE_H, STRIP_H, FONT_SIZE,
};
