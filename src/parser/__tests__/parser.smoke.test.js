'use strict';
/**
 * Smoke tests for the parser — baseline checks that pre-existing behavior
 * still works. Each subsequent commit adds focused tests for the bug it fixes.
 */

const { parseMessage, extractSupplement, extractBatch, extractTaskType } = require('../index');

function msg(text, opts = {}) {
  return {
    ts: opts.ts || '1700000000.000000',
    user: opts.user || 'U08JC85HMNE', // Vitor by default (personal account)
    text,
    username: opts.username || 'vitor',
  };
}

describe('parser smoke', () => {
  test('exports the public API', () => {
    expect(typeof parseMessage).toBe('function');
    expect(typeof extractSupplement).toBe('function');
    expect(typeof extractBatch).toBe('function');
    expect(typeof extractTaskType).toBe('function');
  });

  test('returns null for empty text', () => {
    expect(parseMessage(msg(''))).toBeNull();
    expect(parseMessage(msg('   '))).toBeNull();
  });

  test('recognizes classic "S: Supplement batch" as start', () => {
    const r = parseMessage(msg('S: Berberine 0119'));
    expect(r).toBeTruthy();
    expect(r.type).toBe('start');
    expect(r.supplement).toBe('Berberine');
    expect(r.batch).toBe('0119');
  });

  test('recognizes classic "F: Supplement" as finish', () => {
    const r = parseMessage(msg('F: Berberine'));
    expect(r.type).toBe('finish');
    expect(r.supplement).toBe('Berberine');
  });

  test('recognizes "P:" production count', () => {
    const r = parseMessage(msg('P: Graviola 0124 - 256'));
    expect(r.type).toBe('count');
    expect(r.supplement).toBe('Graviola');
    expect(r.count).toBe(256);
  });

  test('extractSupplement normalizes aliases', () => {
    expect(extractSupplement('berberina')).toBe('Berberine');
    expect(extractSupplement('cha verde')).toBe('Green Tea');
    expect(extractSupplement('fenugreco')).toBe('Fenugreek');
  });

  test('extractBatch picks 4-digit numbers', () => {
    expect(extractBatch('Saw Palmetto 0104')).toBe('0104');
    expect(extractBatch('FO-12345 batch')).toBe('FO-12345');
  });

  test('extractTaskType detects limpeza, revisao, producao, label', () => {
    expect(extractTaskType('iniciando limpeza geral')).toBe('limpeza');
    expect(extractTaskType('revisao do Glutathione')).toBe('revisao');
    expect(extractTaskType('linha de producao')).toBe('producao');
    expect(extractTaskType('colocando label')).toBe('label');
    expect(extractTaskType('comecei a formula')).toBeNull();
  });

  test('recognizes orders start with count', () => {
    const r = parseMessage(msg('Simone - impressao das ordens - 188', {
      user: 'U07FG34TMPF',
      username: 'simone',
    }));
    expect(r.type).toBe('orders_start');
    expect(r.orderCount).toBe(188);
  });

  test('recognizes pause start', () => {
    const r = parseMessage(msg('vou almocar'));
    expect(r.type).toBe('pause_start');
  });

  test('recognizes pause end (voltei)', () => {
    const r = parseMessage(msg('voltei'));
    expect(r.type).toBe('pause_end');
  });

  test('returns ignore for known noise', () => {
    expect(parseMessage(msg('estoque real')).type).toBe('ignore');
  });
});
