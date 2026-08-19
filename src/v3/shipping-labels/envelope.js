'use strict';
/**
 * HEALTHFARE V3 — QUAL ENVELOPE CABE (S15.37).
 *
 * Regra do saco perfeito (Bruno 08-06): 1 envelope por ORDEM, não por produto.
 * Junta TODAS as garrafas do pedido, olha a COR da garrafa e escolhe o MENOR
 * envelope que cabe. Preto e branco ocupam volumes diferentes, por isso a cor
 * manda: 1 branca = 4x8, 1 preta = 7x10, 2 pretas = 9x12.
 *
 * ESTA LÓGICA JÁ EXISTIA em src/v3/data/router.js:1092-1117 (o resumo de
 * envelopes da picklist). Foi COPIADA pra cá em vez de importada porque aquele
 * arquivo tem 2106 linhas e está na lista de "não adicione linhas" do CLAUDE.md —
 * exportar de lá exigiria mexer nele. A regra é a mesma, linha por linha; se um
 * dia a picklist mudar de regra, os dois lugares mudam juntos (a picklist conta
 * quantos envelopes de cada tamanho o dia gasta; aqui a gente carimba o tamanho
 * numa etiqueta específica).
 *
 * O QUE NÃO É DECIDIDO AQUI: pedido de cores MISTAS. Bruno ainda não definiu a
 * regra (a pergunta "3 pretas cabe uma branca junto?" está aberta com o operador).
 * Até ele definir, devolvemos 'misto?' — com a interrogação de propósito, pra
 * quem separa saber que tem que olhar, em vez de confiar num palpite nosso.
 * Chutar aqui seria pior que não responder: o operador embalaria errado confiando.
 *
 * Nada aqui escreve no banco. Só lê v3.bottle_size_tiers.
 */

/** Sem cor cadastrada no produto, ou sem faixa que sirva. */
const UNKNOWN = null;
/** Cores misturadas no mesmo pedido: regra ainda não definida pelo Bruno. */
const MIXED = 'misto?';

/**
 * Carrega as faixas do banco, uma vez por composição.
 * @returns {Promise<Array<{bottle_color, min_bottles, max_bottles, package_size}>>}
 */
async function loadTiers(db) {
  const r = await db.query(
    `SELECT bottle_color, min_bottles, max_bottles, package_size
       FROM v3.bottle_size_tiers ORDER BY bottle_color, min_bottles`);
  return r.rows || [];
}

/**
 * O envelope de UM pedido.
 *
 * @param {Array} tiers        faixas de loadTiers()
 * @param {number} bottles     total de garrafas do pedido (qty * units_per_pack)
 * @param {Array<string>} colors  cores das garrafas do pedido (com repetição, tanto faz)
 * @returns {string|null} package_size, 'misto?' ou null (desconhecido)
 */
function pickEnvelope(tiers, bottles, colors) {
  const set = new Set();
  for (const c of (colors || [])) {
    if (c == null) continue;
    const s = String(c).trim().toLowerCase();
    if (s) set.add(s);
  }
  // cores mistas: regra a definir (mesmo comportamento do router.js:1109)
  if (set.size > 1) return MIXED;
  const color = set.size === 1 ? [...set][0] : null;
  if (!color) return UNKNOWN;              // produto sem cor cadastrada
  const n = Number(bottles) || 0;
  if (n <= 0) return UNKNOWN;
  const t = (tiers || []).find((x) => x.bottle_color === color
    && n >= x.min_bottles && (x.max_bottles == null || n <= x.max_bottles));
  // acima da maior faixa a tabela já traz o BX (é uma faixa com max_bottles NULL);
  // se nem isso existir pra essa cor, é desconhecido de verdade.
  return t ? t.package_size : UNKNOWN;
}

module.exports = { loadTiers, pickEnvelope, MIXED, UNKNOWN };
