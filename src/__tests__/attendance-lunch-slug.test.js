'use strict';
/* PAUSA NÃO É ALMOÇO (Bruno 08-20, caso Vitor).
 *
 * O Vitor fez uma pausa de 30min pra DESCARREGAR ARROZ (break 10:52→11:22) e às
 * 11:52 o Tracker escreveu no canal dos operadores:
 *   "@Vitor faltou bater o ponto no almoço hoje (saída e volta)."
 * Ele respondeu: "Mas eu nem sai pro almoco ainda kk" — e estava certo.
 *
 * Causa: `_checkLunchPunchPair` media contra LUNCH_SLUGS = ['lunch','break'], então
 * QUALQUER pausa fechada virava "almoço" e, como ninguém bate ponto pra descarregar
 * caminhão, o worker cobrava batidas que nunca deveriam existir. O gate `_verifyClaim`
 * não salvou porque ele também olhava a mesma lista: os dois concordavam no erro.
 *
 * Regra: a cobrança de batida de almoço olha SÓ 'lunch'. Os outros usos de
 * LUNCH_SLUGS (estado de pausa, fechar o evento na batida de volta, verificação de
 * volta) seguem incluindo 'break' de propósito.
 *
 * O teste lê o FONTE: o furo era qual constante a query recebia, não o resultado de
 * um cálculo, então é isso que precisa ficar travado.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'workers', 'attendance-sync.js');
const src = fs.readFileSync(SRC, 'utf8');

/** Recorta o corpo de um método pelo nome, até o próximo método no mesmo nível. */
function methodBody(name) {
  const i = src.indexOf(`async ${name}(`);
  expect(i).toBeGreaterThan(-1);
  const rest = src.slice(i);
  const next = rest.slice(1).search(/\n {2}(?:async )?[a-zA-Z_]\w*\(/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('pausa não é almoço (caso Vitor 08-20)', () => {
  test('existe a constante ONLY_LUNCH e ela é só lunch', () => {
    const m = src.match(/const ONLY_LUNCH\s*=\s*\[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const slugs = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    expect(slugs).toEqual(['lunch']);
  });

  test('LUNCH_SLUGS continua com break (os outros usos dependem disso)', () => {
    const m = src.match(/const LUNCH_SLUGS\s*=\s*\[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const slugs = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    expect(slugs).toContain('lunch');
    expect(slugs).toContain('break');
  });

  test('_checkLunchPunchPair cobra batida SÓ de lunch, nunca de break', () => {
    const body = methodBody('_checkLunchPunchPair');
    expect(body).toContain('ONLY_LUNCH');
    // se voltar a passar LUNCH_SLUGS aqui, o arroz do Vitor vira almoço de novo
    expect(body).not.toMatch(/\[today,\s*LUNCH_SLUGS\]/);
  });

  test('_verifyClaim usa ONLY_LUNCH quando a acusação é lunch_punch_missing', () => {
    const body = methodBody('_verifyClaim');
    expect(body).toMatch(/lunch_punch_missing'\s*\?\s*ONLY_LUNCH\s*:\s*LUNCH_SLUGS/);
  });

  test('a cobrança do MESMO dia não vai mais pro operador; o dia seguinte cobra (Bruno 09-28)', () => {
    // 09-28: o NGTeco atrasa ~45min e o "você não bateu" do mesmo dia acusava inocente.
    // O texto acusatório do mesmo dia SAIU do canal do operador (fica só admin + audit)...
    expect(src).not.toContain('você não bateu o ponto ${qual}. Já reportei.');
    expect(src).not.toContain('Já ajustei aqui');
    // ...e a cobrança séria existe no dia seguinte, confirmada, com a escala de 30 dias.
    expect(src).toContain('_nextDayPunchWarnings');
    expect(src).toContain("require('./punch-warning')");
    const body = methodBody('_checkLunchPunchPair');
    expect(body).not.toMatch(/this\._operators\(/);
  });
});
