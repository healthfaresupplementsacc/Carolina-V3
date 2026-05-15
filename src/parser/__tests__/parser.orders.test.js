'use strict';
/**
 * Orders parsing — "ordens" must win over supplement extraction.
 * B10: "F- ordens da segunda impressao feitas" was being confused with a
 * supplement match. Now broader patterns + early routing handle these.
 */

const { parseMessage } = require('../index');

function msg(text, opts = {}) {
  return {
    ts: opts.ts || '1700000000.000000',
    user: opts.user || 'U07FG34TMPF', // Simone
    text,
    username: opts.username || 'simone',
  };
}

describe('B10 — "ordens" priority over supplement match', () => {
  test('"F- ordens da segunda impressao feitas" → orders_finish', () => {
    const r = parseMessage(msg('F- ordens da segunda impressao feitas'));
    expect(r).toBeTruthy();
    expect(r.type).toBe('orders_finish');
  });

  test('"F: ordens" → orders_finish', () => {
    const r = parseMessage(msg('F: ordens'));
    expect(r.type).toBe('orders_finish');
  });

  test('"F: ordens 2 impressao" → orders_finish', () => {
    const r = parseMessage(msg('F: ordens 2 impressao'));
    expect(r.type).toBe('orders_finish');
  });

  test('"ordens feitas" → orders_finish (no tag prefix)', () => {
    const r = parseMessage(msg('ordens feitas'));
    expect(r.type).toBe('orders_finish');
  });

  test('"ordens prontas" → orders_finish', () => {
    const r = parseMessage(msg('ordens prontas'));
    expect(r.type).toBe('orders_finish');
  });

  test('"ordens impacotadas" → orders_finish', () => {
    const r = parseMessage(msg('ordens impacotadas'));
    expect(r.type).toBe('orders_finish');
  });

  test('"ja terminei as ordens" → orders_finish (already worked)', () => {
    const r = parseMessage(msg('ja terminei as ordens'));
    expect(r.type).toBe('orders_finish');
  });

  test('"acabei as ordens" → orders_finish', () => {
    const r = parseMessage(msg('acabei as ordens'));
    expect(r.type).toBe('orders_finish');
  });

  test('"F/ ordens da manha prontas" → orders_finish (slash separator)', () => {
    const r = parseMessage(msg('F/ ordens da manha prontas'));
    expect(r.type).toBe('orders_finish');
  });

  test('orders_finish does NOT swallow supplement when "ordens" not present', () => {
    const r = parseMessage(msg('F: Berberine'));
    expect(r.type).toBe('finish');
    expect(r.supplement).toBe('Berberine');
  });
});
