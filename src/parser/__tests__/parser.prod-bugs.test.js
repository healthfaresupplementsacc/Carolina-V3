'use strict';
/**
 * Regression for parser bugs found in production (2026-05-15 diagnostic):
 *
 * Bug A — Catalog gaps. Operators say "Apple Cider" (not "Apple Cider Vinegar")
 *         and "Potassium" (not "Potassium Iodide"), and produce "Citrus" /
 *         "Citrus Bergamot" + "Feminiva" which were missing entirely.
 *         Result: extractSupplement returned null → handleStart never
 *         created tasks (asked user "qual suplemento?" instead).
 *
 * Bug B — ORDERS_START_REGEX matched "F: impressao das ordens" before the
 *         tag detection had a chance, opening a new orders_session when
 *         the user meant orders_finish. Fix mirrors the hasFinishTag guard
 *         that ORDERS_CONTINUE_PATTERNS already had (Entrega 1 B10).
 */

const { parseMessage, extractSupplement } = require('../index');

function msg(text, opts = {}) {
  return {
    ts: opts.ts || '1700000000.000000',
    user: opts.user || 'U08JC85HMNE',
    text,
    username: opts.username || 'vitor',
  };
}

describe('Bug A — alias catalog gaps fixed', () => {
  test('"Apple Cider" alone now maps to Apple Cider Vinegar', () => {
    expect(extractSupplement('Apple Cider')).toBe('Apple Cider Vinegar');
    expect(extractSupplement('apple cider')).toBe('Apple Cider Vinegar');
  });

  test('"cider" alone also maps (very short alias)', () => {
    expect(extractSupplement('cider')).toBe('Apple Cider Vinegar');
  });

  test('"Potassium" alone now maps to Potassium Iodide', () => {
    expect(extractSupplement('Potassium')).toBe('Potassium Iodide');
    expect(extractSupplement('potassium')).toBe('Potassium Iodide');
  });

  test('"Citrus" maps to Citrus Bergamot (new canonical)', () => {
    expect(extractSupplement('Citrus')).toBe('Citrus Bergamot');
    expect(extractSupplement('citrus bergamot')).toBe('Citrus Bergamot');
    expect(extractSupplement('bergamota')).toBe('Citrus Bergamot');
  });

  test('"Feminiva" recognized as canonical', () => {
    expect(extractSupplement('Feminiva')).toBe('Feminiva');
    expect(extractSupplement('feminiva')).toBe('Feminiva');
  });

  test('"fenngreff" typo maps to Fenugreek', () => {
    expect(extractSupplement('Fenngreff')).toBe('Fenugreek');
  });

  test('the actual failing prod messages now produce start + supplement', () => {
    let r;
    r = parseMessage(msg('S-Bruno- Apple Cider 0131- nas capsulas', {
      user: 'U08JC85HMNE',
    }));
    expect(r.type).toBe('start');
    expect(r.operator).toBe('Bruno');
    expect(r.supplement).toBe('Apple Cider Vinegar');
    expect(r.batch).toBe('0131');

    r = parseMessage(msg('S-Bruno- Potassium rodando'));
    expect(r.type).toBe('start');
    expect(r.operator).toBe('Bruno');
    expect(r.supplement).toBe('Potassium Iodide');

    r = parseMessage(msg('S: Revisao Apple Cider (0131) - "Formula rodando ainda na maquina, revisando o que tem pronto".'));
    expect(r.type).toBe('start');
    expect(r.operator).toBe('Vitor');
    expect(r.supplement).toBe('Apple Cider Vinegar');
    expect(r.taskType).toBe('revisao');
    expect(r.batch).toBe('0131');
  });
});

describe('Bug B — F: orders is finish, not start', () => {
  test('"F: impressao das ordens" → orders_finish (NOT orders_start)', () => {
    const r = parseMessage(msg('F: impressao das ordens', {
      user: 'U07FG34TMPF', username: 'simone',
    }));
    expect(r.type).toBe('orders_finish');
    expect(r.operator).toBe('Simone');
  });

  test('"F- impressao das ordens" with hyphen separator → orders_finish', () => {
    const r = parseMessage(msg('F- impressao das ordens', {
      user: 'U07FG34TMPF', username: 'simone',
    }));
    expect(r.type).toBe('orders_finish');
  });

  test('"F; impressao das ordens" with semicolon → orders_finish', () => {
    const r = parseMessage(msg('F; impressao das ordens', {
      user: 'U07FG34TMPF', username: 'simone',
    }));
    expect(r.type).toBe('orders_finish');
  });

  test('"F/ impressao das ordens" with slash → orders_finish', () => {
    const r = parseMessage(msg('F/ impressao das ordens', {
      user: 'U07FG34TMPF', username: 'simone',
    }));
    expect(r.type).toBe('orders_finish');
  });

  test('"F impressao das ordens" (whitespace only, no separator) → orders_finish', () => {
    const r = parseMessage(msg('F impressao das ordens', {
      user: 'U07FG34TMPF', username: 'simone',
    }));
    expect(r.type).toBe('orders_finish');
  });

  test('regression: bare "S: impressao das ordens" still → orders_start', () => {
    const r = parseMessage(msg('S: impressao das ordens - 152', {
      user: 'U07FG34TMPF', username: 'simone',
    }));
    expect(r.type).toBe('orders_start');
    expect(r.orderCount).toBe(152);
  });

  test('regression B10: "F- ordens da segunda impressao feitas" → orders_finish', () => {
    const r = parseMessage(msg('F- ordens da segunda impressao feitas', {
      user: 'U07FG34TMPF', username: 'simone',
    }));
    expect(r.type).toBe('orders_finish');
  });

  test('regression: "imprimindo as ordens" without any tag → orders_start (start path still works)', () => {
    const r = parseMessage(msg('imprimindo as ordens - 188', {
      user: 'U07FG34TMPF', username: 'simone',
    }));
    expect(r.type).toBe('orders_start');
    expect(r.orderCount).toBe(188);
  });
});
