'use strict';
const { resolveOperator, buildMatcher, matchPrefix } = require('../resolve-operator');

// Operators roster as it stands AFTER FASE 0.
const OPS = [
  { id: 1,   name: 'Ana',               aliases: '', role: 'operator', slack_user_id: null,          is_shared_account: false },
  { id: 2,   name: 'Bruno Sarmento',    aliases: '', role: 'operator', slack_user_id: null,          is_shared_account: false },
  { id: 3,   name: 'Vitor Leite',       aliases: '', role: 'operator', slack_user_id: 'U08JC85HMNE', is_shared_account: false },
  { id: 4,   name: 'Simone',            aliases: '', role: 'operator', slack_user_id: 'U07FG34TMPF', is_shared_account: false },
  { id: 333, name: 'Bruno Camp',        aliases: '', role: 'owner',    slack_user_id: 'U03URLL1D4L', is_shared_account: false },
  { id: 324, name: 'Henrique Monteiro', aliases: '', role: 'manager',  slack_user_id: 'U085SDY3F4Z', is_shared_account: false },
];

const PC = 'U0AU8N8FA00';     // shared floor PC — NO owner
const SIMONE_ACC = 'U07FG34TMPF';
const VITOR_ACC = 'U08JC85HMNE';

function deps(recents = []) {
  return {
    loadOperators: async () => OPS,
    recentMessages: async () => recents,
  };
}
const NOW = '2026-05-18T15:00:00.000Z';

describe('resolveOperator — Step 1: explicit prefix wins', () => {
  test('"ANA- F: limpeza" from the shared PC → Ana, body stripped', async () => {
    const r = await resolveOperator(
      { text: 'ANA- F: limpeza', accountUserId: PC, timestamp: NOW }, deps());
    expect(r.operatorId).toBe(1);
    expect(r.operatorName).toBe('Ana');
    expect(r.via).toBe('prefix');
    expect(r.remainingText).toBe('F: limpeza');
  });

  test('"ANA_ F: limpeza" — underscore separator also works', async () => {
    const r = await resolveOperator(
      { text: 'ANA_ F: limpeza', accountUserId: PC, timestamp: NOW }, deps());
    expect(r.operatorId).toBe(1);
    expect(r.via).toBe('prefix');
    expect(r.remainingText).toBe('F: limpeza');
  });

  test('"Ana_ F: linha do Rutin 0138" → Ana (the 12:15 discard bug)', async () => {
    const r = await resolveOperator(
      { text: 'Ana_ F: linha do Rutin 0138', accountUserId: PC, timestamp: NOW }, deps());
    expect(r.operatorName).toBe('Ana');
    expect(r.remainingText).toBe('F: linha do Rutin 0138');
  });

  test('"- ana voltei" — leading separator + space separator', async () => {
    const r = await resolveOperator(
      { text: '- ana voltei', accountUserId: PC, timestamp: NOW }, deps());
    expect(r.operatorId).toBe(1);
    expect(r.via).toBe('prefix');
    expect(r.remainingText).toBe('voltei');
  });

  test('"BRUNO: revisao" from Vitor account → Bruno Sarmento (prefix beats owner)', async () => {
    const r = await resolveOperator(
      { text: 'BRUNO: revisao', accountUserId: VITOR_ACC, timestamp: NOW }, deps());
    expect(r.operatorId).toBe(2);
    expect(r.operatorName).toBe('Bruno Sarmento');
    expect(r.via).toBe('prefix');
  });

  test('"S- empacotando" is NOT a name prefix (S is a tag, not an operator)', async () => {
    // From Simone's account → falls to account owner, not "operator S".
    const r = await resolveOperator(
      { text: 'S- empacotando', accountUserId: SIMONE_ACC, timestamp: NOW }, deps());
    expect(r.operatorName).toBe('Simone');
    expect(r.via).toBe('account_owner');
  });

  test('"Vitor Leite - X" matches the full name before "Vitor"', async () => {
    const r = await resolveOperator(
      { text: 'Vitor Leite - revisando Plant', accountUserId: PC, timestamp: NOW }, deps());
    expect(r.operatorId).toBe(3);
    expect(r.via).toBe('prefix');
  });
});

describe('resolveOperator — Step 3: account default owner', () => {
  test('"S- empacotando" da Simone → Simone (dono padrão)', async () => {
    const r = await resolveOperator(
      { text: 'S- empacotando', accountUserId: SIMONE_ACC, timestamp: NOW }, deps());
    expect(r.operatorId).toBe(4);
    expect(r.via).toBe('account_owner');
  });

  test('"retorno almoco" da Simone sem prefixo → Simone (dono padrão)', async () => {
    const r = await resolveOperator(
      { text: 'retorno almoco', accountUserId: SIMONE_ACC, timestamp: NOW }, deps());
    expect(r.operatorId).toBe(4);
    expect(r.via).toBe('account_owner');
  });

  test('"F: Formulacao Plant" da conta do Vitor → Vitor Leite (dono padrão)', async () => {
    const r = await resolveOperator(
      { text: 'F: Formulacao Plant', accountUserId: VITOR_ACC, timestamp: NOW }, deps());
    expect(r.operatorId).toBe(3);
    expect(r.via).toBe('account_owner');
  });
});

describe('resolveOperator — Step 4: ambiguous (never guess)', () => {
  test('"label das ordens" da Production Line sem prefixo → AMBÍGUA (null)', async () => {
    const r = await resolveOperator(
      { text: 'colocando as label das ordens nos envelopes', accountUserId: PC, timestamp: NOW },
      deps());
    expect(r.operatorId).toBeNull();
    expect(r.via).toBe('ambiguous');
    expect(r.ambiguous).toBe(true);
  });

  test('shared PC, no context, no prefix → never "next active operator"', async () => {
    const r = await resolveOperator(
      { text: 'maquina travou de novo', accountUserId: PC, timestamp: NOW }, deps());
    expect(r.operatorId).toBeNull();
  });
});

describe('resolveOperator — Step 2: recent context (≤2 min, same account)', () => {
  test('2 msgs 90s no PC: 1ª "ANA-", 2ª sem prefixo → 2ª herda Ana', async () => {
    const r = await resolveOperator(
      { text: 'maquina ok agora', accountUserId: PC, timestamp: NOW, sourceId: '2' },
      deps([{ text: 'ANA- comecei a linha do Rutin', ts: '1' }]));
    expect(r.operatorId).toBe(1);
    expect(r.via).toBe('context');
  });

  test('2 msgs 90s no PC: 1ª "ANA-", 2ª "BRUNO-" → 2ª é Bruno (prefixo próprio)', async () => {
    const r = await resolveOperator(
      { text: 'BRUNO- retomando revisao', accountUserId: PC, timestamp: NOW, sourceId: '2' },
      deps([{ text: 'ANA- comecei a linha do Rutin', ts: '1' }]));
    expect(r.operatorId).toBe(2);
    expect(r.operatorName).toBe('Bruno Sarmento');
    expect(r.via).toBe('prefix');
  });

  test('continuation inherits, but a NEW-task signal without prefix does NOT', async () => {
    const r = await resolveOperator(
      { text: 'S: iniciando Rutin 0140', accountUserId: PC, timestamp: NOW, sourceId: '2' },
      deps([{ text: 'ANA- limpando bancada', ts: '1' }]));
    expect(r.operatorId).toBeNull(); // new task of unclear owner → ambiguous
    expect(r.via).toBe('ambiguous');
  });

  test('two different operators in the 2-min window → ambiguous', async () => {
    const r = await resolveOperator(
      { text: 'voltei', accountUserId: PC, timestamp: NOW, sourceId: '3' },
      deps([
        { text: 'ANA- limpando', ts: '1' },
        { text: 'BRUNO- revisao', ts: '2' },
      ]));
    expect(r.operatorId).toBeNull();
    expect(r.via).toBe('ambiguous');
  });
});

describe('resolveOperator — matcher internals', () => {
  test('"bruno" first-name maps to the OPERATOR (Bruno Sarmento), not owner Bruno Camp', () => {
    const m = buildMatcher(OPS);
    expect(m.tokenToOp.get('bruno').id).toBe(2);
  });
  test('"henrique" (manager) still recognized when globally unique', () => {
    const m = buildMatcher(OPS);
    expect(m.tokenToOp.get('henrique').id).toBe(324);
  });
  test('longest token wins ("vitor leite" before "vitor")', () => {
    const m = buildMatcher(OPS);
    const hit = matchPrefix('Vitor Leite: x', m);
    expect(hit.op.id).toBe(3);
  });
});
