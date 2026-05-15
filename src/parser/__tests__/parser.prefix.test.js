'use strict';
/**
 * Bug N1 (CRITICAL) + Item A from smoke test report:
 *
 * When a message starts with 'Nome - ' or 'Nome:' and Nome is a known operator,
 * that prefix MUST win over the account owner — even on personal/non-shared
 * accounts. Previously, on Vitor's account (non-shared, owner=Vitor) a message
 * 'Ana - voltei' was attributed to Vitor because resolveOperator used the
 * account owner whenever the account wasn't marked shared.
 */

const { parseMessage } = require('../index');

function msg(text, opts = {}) {
  return {
    ts: opts.ts || '1700000000.000000',
    user: opts.user || 'U08JC85HMNE', // Vitor's user id (personal, non-shared)
    text,
    username: opts.username || 'vitor',
  };
}

describe('Bug N1 — prefix wins over account owner on personal accounts', () => {
  test('"Ana - voltei" from Vitor account → operator Ana, not Vitor', () => {
    const r = parseMessage(msg('Ana - voltei'));
    expect(r.type).toBe('pause_end');
    expect(r.operator).toBe('Ana');
  });

  test('"Bruno - S: Berberine 0119" from Vitor account → operator Bruno', () => {
    const r = parseMessage(msg('Bruno - S: Berberine 0119'));
    expect(r.type).toBe('start');
    expect(r.operator).toBe('Bruno');
    expect(r.supplement).toBe('Berberine');
  });

  test('"Simone - F: Berberine" from Vitor account → operator Simone', () => {
    const r = parseMessage(msg('Simone - F: Berberine'));
    expect(r.type).toBe('finish');
    expect(r.operator).toBe('Simone');
  });

  test('"Ana: vou almocar" from Vitor account → operator Ana, not Vitor', () => {
    const r = parseMessage(msg('Ana: vou almocar'));
    expect(r.type).toBe('pause_start');
    expect(r.operator).toBe('Ana');
  });

  test('"Bruno - ajudando o Vitor na linha de producao" → operator Bruno', () => {
    const r = parseMessage(msg('Bruno - ajudando o Vitor na linha de producao'));
    expect(r.type).toBe('join_producao');
    expect(r.operator).toBe('Bruno');
  });

  test('no prefix on Vitor account still resolves to Vitor', () => {
    const r = parseMessage(msg('S: Berberine 0119'));
    expect(r.type).toBe('start');
    expect(r.operator).toBe('Vitor');
  });

  test('no prefix on Simone account still resolves to Simone', () => {
    const r = parseMessage(msg('S: ordens - 100', {
      user: 'U07FG34TMPF',
      username: 'simone',
    }));
    expect(r.type).toBe('orders_start');
    expect(r.operator).toBe('Simone');
  });

  test('shared account (Production Line) without prefix still asks who is posting', () => {
    const r = parseMessage(msg('S: Berberine 0119', {
      user: 'U0AU8N8FA00',
      username: 'production line',
    }));
    expect(r.type).toBe('start');
    // No prefix on shared account → no operator resolved, needs clarification
    expect(r.operator).toBeFalsy();
    expect(r.needsOperatorClarification).toBe(true);
  });
});

describe('Bug N1 — Bruno blocking still applies on cross-account prefix', () => {
  test('"Bruno - X" from Bruno-owner account (U03URLL1D4L) → blocked', () => {
    // Bruno Camp (owner) can't post production work as Bruno-worker.
    // BRUNO_ALLOWED_ACCOUNTS lists Vitor, Simone, Production Line.
    const r = parseMessage(msg('Bruno - S: Berberine 0119', {
      user: 'U03URLL1D4L', // Bruno Camp's owner ID — NOT in allowed list
      username: 'bruno camp',
    }));
    expect(r.type).toBe('ignore');
  });

  test('"Bruno - X" from Vitor account → accepted (Vitor is in allowed list)', () => {
    const r = parseMessage(msg('Bruno - S: Berberine 0119'));
    expect(r.type).toBe('start');
    expect(r.operator).toBe('Bruno');
  });
});
