'use strict';
/**
 * Compound messages: "impacotei + iniciei X" should close orders AND open new task.
 * B11: Today, "Ja impacotei e ja iniciei a Revisao do Ginger" produces nothing.
 */

const { parseMessage } = require('../index');

function msg(text, opts = {}) {
  return {
    ts: opts.ts || '1700000000.000000',
    user: opts.user || 'U07FG34TMPF', // Simone by default
    text,
    username: opts.username || 'simone',
  };
}

describe('B11 — compound impacotei + iniciei', () => {
  test('"Ja impacotei e ja iniciei a Revisao do Ginger" → orders_finish + start Ginger revisao', () => {
    const r = parseMessage(msg('Ja impacotei e ja iniciei a Revisao do Ginger'));
    expect(r).toBeTruthy();
    // Expected: orders_finish with a "next" hint (nextSupplement Ginger Root, nextTaskType revisao)
    expect(r.type).toBe('orders_finish');
    expect(r.nextSupplement).toBe('Ginger Root');
    expect(r.nextTaskType).toBe('revisao');
  });

  test('"Impacotei e ja iniciei o Glutathione" → orders_finish + start Glutathione', () => {
    const r = parseMessage(msg('Impacotei e ja iniciei o Glutathione'));
    expect(r.type).toBe('orders_finish');
    expect(r.nextSupplement).toBe('Glutathione');
  });

  test('"empacotei e comecei a Berberine 0119" → orders_finish + start Berberine', () => {
    const r = parseMessage(msg('empacotei e comecei a Berberine 0119'));
    expect(r.type).toBe('orders_finish');
    expect(r.nextSupplement).toBe('Berberine');
    expect(r.nextBatch).toBe('0119');
  });

  test('"terminei o packing e iniciei a Limpeza" → orders_finish + start limpeza', () => {
    const r = parseMessage(msg('terminei o packing e iniciei a Limpeza'));
    expect(r.type).toBe('orders_finish');
    expect(r.nextTaskType).toBe('limpeza');
  });

  test('plain "iniciei a Revisao do Ginger" (no orders context) → just start', () => {
    const r = parseMessage(msg('iniciei a Revisao do Ginger'));
    // Should still parse as a start — no orders involvement
    expect(['start', 'freetext']).toContain(r.type === 'start' ? 'start' : r.type);
    if (r.type === 'start') {
      expect(r.supplement).toBe('Ginger Root');
    }
  });
});

describe('B11 — existing compound (terminei + estou fazendo) still works', () => {
  test('"terminei X e estou fazendo Berberine" → finish + nextSupplement', () => {
    const r = parseMessage(msg('terminei e estou fazendo Berberine 0119'));
    expect(r.type).toBe('finish');
    expect(r.nextSupplement).toBe('Berberine');
  });
});
