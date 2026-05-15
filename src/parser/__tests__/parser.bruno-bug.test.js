'use strict';
/**
 * Bug "Bruno ignorado" — two distinct issues found in 30d production scan:
 *
 *   Bug A: OPERATOR_PREFIX_REGEX only accepted '-' and ':' as separators.
 *          Operators frequently type "Bruno , X" or "Bruno; X" or
 *          "Bruno / X" instead of the canonical "Bruno - X". Result: no
 *          prefix match → falls back to account owner (usually Vitor) or
 *          null operator.
 *
 *   Bug B: parseMessage returned { type:'unknown', raw, ts } WITHOUT the
 *          resolved operator. Downstream code that depends on
 *          parsed.operator (pending-question response routing,
 *          per-operator urgency, etc.) lost the attribution. Same for
 *          'ignore' returns.
 */

const { parseMessage } = require('../index');

function msg(text, opts = {}) {
  return {
    ts: opts.ts || '1700000000.000000',
    user: opts.user || 'U08JC85HMNE', // Vitor's account by default
    text,
    username: opts.username || 'vitor',
  };
}

describe('Bug A — OPERATOR_PREFIX_REGEX accepts more separators', () => {
  test('"Bruno , parada , estou no almoco" → operator=Bruno (comma separator)', () => {
    const r = parseMessage(msg('Bruno , parada , estou no almoco'));
    expect(r.operator).toBe('Bruno');
  });

  test('"Bruno; F: Berberine" → operator=Bruno + finish (semicolon)', () => {
    const r = parseMessage(msg('Bruno; F: Berberine'));
    expect(r.type).toBe('finish');
    expect(r.operator).toBe('Bruno');
    expect(r.supplement).toBe('Berberine');
  });

  test('"Ana, voltei" → operator=Ana + pause_end (comma)', () => {
    const r = parseMessage(msg('Ana, voltei', { user: 'U0AU8N8FA00' }));
    expect(r.type).toBe('pause_end');
    expect(r.operator).toBe('Ana');
  });

  test('"Bruno / S: Berberine" → operator=Bruno + start (slash)', () => {
    const r = parseMessage(msg('Bruno / S: Berberine'));
    expect(r.type).toBe('start');
    expect(r.operator).toBe('Bruno');
  });

  test('"Bruno - X" with hyphen STILL works (regression)', () => {
    const r = parseMessage(msg('Bruno - voltei'));
    expect(r.type).toBe('pause_end');
    expect(r.operator).toBe('Bruno');
  });

  test('"Bruno: X" with colon STILL works (regression)', () => {
    const r = parseMessage(msg('Bruno: voltei'));
    expect(r.type).toBe('pause_end');
    expect(r.operator).toBe('Bruno');
  });
});

describe('Bug B — unknown/ignore returns include operator', () => {
  test('"Bruno - mquina que esta fazendo o Potassium em revisao de 5-10 min" → unknown but operator=Bruno', () => {
    // No tag, no clear freetext pattern, but Bruno prefix is present.
    // Before: { type:'unknown', operator: undefined }
    // After:  { type:'unknown', operator: 'Bruno' }
    const r = parseMessage(msg('Bruno - mquina que esta fazendo o Potassium em revisao de 5-10 min'));
    // Note: with the new Potassium alias, this might now parse as a
    // freetext start — but the operator must be Bruno either way.
    expect(r.operator).toBe('Bruno');
  });

  test('"Bruno- Henrique. Foi retirado a formula Kayenne?" → unknown + operator=Bruno', () => {
    const r = parseMessage(msg('Bruno- Henrique. Foi retirado a formula Kayenne?'));
    expect(r.operator).toBe('Bruno');
  });

  test('"Bruno, sem contexto algum aqui assim" → unknown OR ignore + operator=Bruno', () => {
    const r = parseMessage(msg('Bruno, sem contexto algum aqui assim'));
    expect(r.operator).toBe('Bruno');
    expect(['unknown', 'ignore']).toContain(r.type);
  });

  test('"estoque real" without prefix → ignore + operator=Vitor (account owner)', () => {
    // No prefix; non-shared account; should still attribute to owner.
    const r = parseMessage(msg('estoque real'));
    expect(r.type).toBe('ignore');
    expect(r.operator).toBe('Vitor');
  });

  test('"hi" tiny message → ignore + operator from account', () => {
    const r = parseMessage(msg('hi'));
    expect(r.type).toBe('ignore');
    expect(r.operator).toBe('Vitor'); // fallback to account owner
  });

  test('"Ana - hi" tiny message with prefix → ignore + operator=Ana (prefix wins)', () => {
    const r = parseMessage(msg('Ana - hi', { user: 'U0AU8N8FA00' }));
    expect(r.type).toBe('ignore');
    expect(r.operator).toBe('Ana');
  });
});

describe('Bug A — pre-existing behavior preserved', () => {
  test('plain message without prefix on Vitor account → operator=Vitor', () => {
    const r = parseMessage(msg('S: Berberine 0119'));
    expect(r.operator).toBe('Vitor');
  });

  test('"S: ordens" from Production Line (shared) → needsOperatorClarification', () => {
    const r = parseMessage(msg('S: ordens', { user: 'U0AU8N8FA00' }));
    expect(r.type).toBe('orders_start');
  });
});
