'use strict';
/**
 * P&P — O QUE CONTA COMO O MESMO TRABALHO (09-30).
 *
 * "A 2ª impressão de ordens e a impressão de ordens no fim das contas dão tudo
 *  no mesmo, é um botão que não tem necessidade e só deixa as coisas mais
 *  confusas pro operador. Quando a gente precisa das estatísticas do P&P, vai
 *  sempre incluir empacotamento e impressão de ordens, porque é tudo a mesma
 *  coisa."
 *
 * Então: UM lugar define isso, e todo mundo importa daqui. Antes cada arquivo
 * repetia ['order_printing','order_printing_2'] e bastava um esquecer pra
 * estatística sair pela metade.
 *
 * `order_printing_2` está DESATIVADA (migration 097): não aparece mais no
 * kiosk e ninguém cria nova. Mas os 74 eventos antigos continuam no banco,
 * intactos — histórico não se mexe — e contam como impressão de ordens em
 * QUALQUER métrica. Por isso ela segue nesta lista: é leitura, não escrita.
 */

// impressão de ordens (a de hoje + a antiga 2ª, que é o mesmo trabalho)
const ORDER_PRINTING = ['order_printing', 'order_printing_2'];

// empacotamento
const PACKING = ['packaging'];

// P&P inteiro = impressão + empacotamento. É isto que vai em toda estatística.
const PNP = [...ORDER_PRINTING, ...PACKING];

/** Pra usar em SQL: slug = ANY($1::text[]) */
const asArray = (list) => list.slice();

/** Pra usar em SQL literal: IN ('a','b') */
const asSqlIn = (list) => list.map((s) => `'${s}'`).join(',');

module.exports = { ORDER_PRINTING, PACKING, PNP, asArray, asSqlIn };
