'use strict';
/**
 * Entrega 3 Fase 5.2 — detectPhaseHint natural-language phase keywords.
 */
const { detectPhaseHint } = require('../index');

describe('detectPhaseHint', () => {
  test.each([
    ['Encapsulação Green Tea 0098',           'Encapsulação'],
    ['encapsulando o Berberine',              'Encapsulação'],
    ['mixando o po do Rutin',                 'Mix'],
    ['misturando a formula',                  'Mix'],
    ['rodando tablet do Potassium',           'Tablet'],
    ['revisão do Glutathione',                'Revisão'],
    ['revisando capsulas',                    'Revisão'],
    ['linha de produção do Saw Palmetto',     'Linha de Produção'],
    ['fazendo a contagem dos bottles',        'Contagem'],
    ['formulação do Apple Cider',             'Formulação'],
    ['formulando o proximo',                  'Formulação'],
    ['impressão das ordens',                  'Imprimir ordens'],
    ['imprimindo as ordens da manha',         'Imprimir ordens'],
    ['empacotando os pedidos',                'Empacotar'],
    ['impacotei tudo',                        'Empacotar'],
    ['colando label nos envelopes',           'Colar label no envelope'],
    ['separando os bottles pra ordem',        'Separar bottles'],
    ['imprimir label pro FBA',                'Imprimir label/FNSKU'],
    ['colocando FNSKU nas caixas',            'Imprimir label/FNSKU'],
    ['encaixotando o Rutin',                  'Encaixotar'],
    ['fechar caixas pra enviar',              'Encaixotar'],
  ])('"%s" → %s', (text, expected) => {
    expect(detectPhaseHint(text)).toBe(expected);
  });

  test('returns null for non-phase text', () => {
    expect(detectPhaseHint('bom dia pessoal')).toBeNull();
    expect(detectPhaseHint('')).toBeNull();
    expect(detectPhaseHint(null)).toBeNull();
  });

  test('Mix matches before Encapsulação when both could apply', () => {
    // "mix" listed first in PHASE_HINTS — order matters
    expect(detectPhaseHint('mixando antes de encapsular')).toBe('Mix');
  });
});
