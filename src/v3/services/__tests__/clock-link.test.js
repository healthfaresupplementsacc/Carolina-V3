'use strict';
/** clock-link — regra de match nome↔roster NGTeco (Bruno 08-21). */

const { matchName, tokens } = require('../clock-link');

// espelho do roster real (inclui as 3 "Ana" que motivaram a regra conservadora)
const ROSTER = [
  { first: 'Caroline', last: 'Braga de Almeida', code: '42' },
  { first: 'Ana Kesya', last: 'Leite Oliveira Cardoso', code: '39' },
  { first: 'Ana Beatriz', last: 'Santos Oliveira', code: '18' },
  { first: 'Ana Maria', last: 'Castro', code: '16' },
  { first: 'Bruno', last: 'Sarmento', code: '38' },
  { first: 'Simone', last: 'Mauri', code: '10' },
  { first: 'Norjelen', last: 'Hernández', code: '35' },
  { first: 'Bruno', last: 'Camp', code: 'BRUNO' },
].map((r) => ({ code: r.code, name: `${r.first} ${r.last}`, toks: tokens(`${r.first} ${r.last}`) }));

describe('tokens()', () => {
  test('normaliza acento e caixa', () => {
    expect(tokens('Hernández')).toEqual(['hernandez']);
    expect(tokens('  Ana  KESYA ')).toEqual(['ana', 'kesya']);
  });
});

describe('matchName()', () => {
  test('nome+sobrenome parcial vincula (Caroline Braga → #42)', () => {
    const r = matchName('Caroline Braga', ROSTER, new Set());
    expect(r.status).toBe('matched');
    expect(r.match.code).toBe('42');
  });

  test('um token só nunca vincula sozinho (double-check do Bruno)', () => {
    const r = matchName('Simone', ROSTER, new Set());
    expect(r.status).toBe('needs_full_name');
    expect(r.candidates.map((c) => c.code)).toEqual(['10']);
  });

  test('"Ana" é ambígua entre as 3 e não vincula', () => {
    const r = matchName('Ana', ROSTER, new Set());
    expect(r.status).toBe('needs_full_name');
    expect(r.candidates).toHaveLength(3);
  });

  test('"Ana Kesya" resolve pra única Ana certa', () => {
    const r = matchName('Ana Kesya', ROSTER, new Set());
    expect(r.status).toBe('matched');
    expect(r.match.code).toBe('39');
  });

  test('sobrenome errado não vincula', () => {
    expect(matchName('Caroline Silva', ROSTER, new Set()).status).toBe('not_found');
  });

  test('primeiro token tem que ser o primeiro nome (não casa só por conter)', () => {
    expect(matchName('Braga Caroline', ROSTER, new Set()).status).toBe('not_found');
  });

  test('acento não atrapalha (Norjelen Hernandez sem acento)', () => {
    const r = matchName('Norjelen Hernandez', ROSTER, new Set());
    expect(r.status).toBe('matched');
    expect(r.match.code).toBe('35');
  });

  test('dois Brunos: sobrenome decide', () => {
    expect(matchName('Bruno Sarmento', ROSTER, new Set()).match.code).toBe('38');
    expect(matchName('Bruno Camp', ROSTER, new Set()).match.code).toBe('BRUNO');
  });

  test('código já usado por outra pessoa → code_taken, nunca rouba', () => {
    const r = matchName('Caroline Braga', ROSTER, new Set(['42']));
    expect(r.status).toBe('code_taken');
    expect(r.match).toBeUndefined();
  });

  test('vazio → not_found', () => {
    expect(matchName('', ROSTER, new Set()).status).toBe('not_found');
  });
});
