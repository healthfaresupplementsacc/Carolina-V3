'use strict';
/**
 * Item B from smoke test report: accept "almoço" (with cedilla),
 * "saindo pro almoço", "hora do almoço", etc. Previously the regex used
 * the bracket class [c] which only matched "almoco/almocar" — accented
 * forms were silently treated as 'unknown'.
 */

const { parseMessage } = require('../index');

function msg(text, opts = {}) {
  return {
    ts: opts.ts || '1700000000.000000',
    user: opts.user || 'U08JC85HMNE',
    text,
    username: opts.username || 'vitor',
  };
}

describe('Item B — almoço variants', () => {
  test('"vou almoçar" → pause_start', () => {
    expect(parseMessage(msg('vou almoçar')).type).toBe('pause_start');
  });

  test('"vou almoçar" (with cedilla) on Vitor account → operator Vitor', () => {
    const r = parseMessage(msg('vou almoçar'));
    expect(r.type).toBe('pause_start');
    expect(r.operator).toBe('Vitor');
  });

  test('"indo almoçar" → pause_start', () => {
    expect(parseMessage(msg('indo almoçar')).type).toBe('pause_start');
  });

  test('"saindo pro almoço" → pause_start', () => {
    expect(parseMessage(msg('saindo pro almoço')).type).toBe('pause_start');
  });

  test('"saindo pra almoçar" → pause_start', () => {
    expect(parseMessage(msg('saindo pra almoçar')).type).toBe('pause_start');
  });

  test('"hora do almoço" → pause_start', () => {
    expect(parseMessage(msg('hora do almoço')).type).toBe('pause_start');
  });

  test('"no almoço" → pause_start', () => {
    expect(parseMessage(msg('no almoço')).type).toBe('pause_start');
  });

  test('non-accented forms still work', () => {
    expect(parseMessage(msg('vou almocar')).type).toBe('pause_start');
    expect(parseMessage(msg('indo almocar')).type).toBe('pause_start');
    expect(parseMessage(msg('saindo pro almoco')).type).toBe('pause_start');
  });

  test('"Ana - vou almoçar" from Vitor account → operator Ana (N1 + Item B together)', () => {
    const r = parseMessage(msg('Ana - vou almoçar'));
    expect(r.type).toBe('pause_start');
    expect(r.operator).toBe('Ana');
  });
});
