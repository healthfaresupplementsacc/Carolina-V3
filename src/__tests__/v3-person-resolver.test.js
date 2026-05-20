'use strict';
// HEALTHFARE V3 — PARTE 2.3 — testes comportamentais do PersonResolver.
const { PersonResolver } = require('../v3/services/PersonResolver');
const MockProvider = require('../v3/llm/providers/MockProvider');

// ── fixtures ──
const PERSONS = [
  { id: 1, display_name: 'Bruno Camp', role: 'owner', slack_user_id: null },
  { id: 2, display_name: 'Thassio', role: 'owner', slack_user_id: null },
  { id: 3, display_name: 'Henrique', role: 'manager', slack_user_id: null },
  { id: 4, display_name: 'Vitor', role: 'operator', slack_user_id: 'U_VITOR' },
  { id: 5, display_name: 'Simone', role: 'operator', slack_user_id: 'U_SIMONE' },
  { id: 6, display_name: 'Ana', role: 'operator', slack_user_id: null },
  { id: 7, display_name: 'Bruno Sarmento', role: 'operator', slack_user_id: null },
  { id: 8, display_name: 'Solo', role: 'operator', slack_user_id: 'U_SOLO' }, // conta própria não-shared
];
const ACCOUNTS = [
  { slack_user_id: 'U_VITOR', primary_owner_id: 4, slack_dm_id: 'D_V', description: "Vitor's account" },
  { slack_user_id: 'U_SIMONE', primary_owner_id: 5, slack_dm_id: 'D_S', description: "Simone's account" },
  { slack_user_id: 'U_PL', primary_owner_id: null, slack_dm_id: 'D_PL', description: 'Production Line' },
];
const USERS = [];
for (const acc of ['U_VITOR', 'U_SIMONE', 'U_PL']) {
  USERS.push({ shared_account_id: acc, person_id: 6, display_name: 'Ana', role: 'operator', identifies_as: ['Ana'] });
  USERS.push({ shared_account_id: acc, person_id: 7, display_name: 'Bruno Sarmento', role: 'operator', identifies_as: ['Bruno', 'Sarmento'] });
  USERS.push({ shared_account_id: acc, person_id: 4, display_name: 'Vitor', role: 'operator', identifies_as: ['Vitor', 'V'] });
  USERS.push({ shared_account_id: acc, person_id: 5, display_name: 'Simone', role: 'operator', identifies_as: ['Simone', 'S'] });
}

function makeDb({ accounts = ACCOUNTS, users = USERS, persons = PERSONS, recent = [] } = {}) {
  const inserts = { prefix_log: [], proposals: [] };
  const db = {
    inserts,
    query: jest.fn((sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/INSERT INTO v3\.prefix_resolution_log/.test(s)) { inserts.prefix_log.push(params); return Promise.resolve({ rows: [] }); }
      if (/INSERT INTO v3\.proposals/.test(s)) { inserts.proposals.push(params); return Promise.resolve({ rows: [] }); }
      if (/FROM v3\.shared_account_users/.test(s)) return Promise.resolve({ rows: users });
      if (/FROM v3\.persons WHERE deleted_at/.test(s)) return Promise.resolve({ rows: persons });
      if (/FROM v3\.shared_accounts/.test(s)) return Promise.resolve({ rows: accounts });
      if (/FROM v3\.messages/.test(s)) return Promise.resolve({ rows: recent });
      return Promise.resolve({ rows: [] });
    }),
  };
  return db;
}

function makeResolver({ db, llmJson, llmError, now } = {}) {
  const provider = new MockProvider();
  if (llmError) provider.setError(llmError);
  else if (llmJson !== undefined) {
    provider.setResult({
      raw_response: typeof llmJson === 'string' ? llmJson : JSON.stringify(llmJson),
      cost_estimate_usd: 0.001,
    });
  }
  return { resolver: new PersonResolver({ db, provider, now }), provider, db };
}

const accountsQueryCount = (db) => db.query.mock.calls
  .filter((c) => /FROM v3\.shared_accounts/.test(String(c[0]).replace(/\s+/g, ' ')))
  .filter((c) => !/shared_account_users/.test(String(c[0]).replace(/\s+/g, ' '))).length;

describe('V3 §2.3 — lookup direto (conta própria, sem LLM)', () => {
  test('conta não-compartilhada resolve direto, zero LLM', async () => {
    const { resolver, provider } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_SOLO', 'limpei a mesa', '111.1', { message_id: 100 });
    expect(r.resolution_method).toBe('direct');
    expect(r.person_id).toBe(8);
    expect(r.confidence).toBe('high');
    expect(r.cost_estimate_usd).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  test('slack_user_id desconhecido → unknown_account / unconfirmed', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_NINGUEM', 'oi', '111.2', { message_id: 101 });
    expect(r.resolution_method).toBe('unknown_account');
    expect(r.confidence).toBe('unconfirmed');
    expect(r.person_id).toBeNull();
  });
});

describe('V3 §2.3 — conta compartilhada (LLM)', () => {
  test('nome identificado (qualquer posição) → llm_identified, high', async () => {
    const { resolver, provider } = makeResolver({
      db: makeDb(),
      llmJson: { person_id: 7, identification_evidence: 'Bruno -', confidence: 'high', reasoning: 'nome no começo' },
    });
    const r = await resolver.resolve('U_VITOR', 'Bruno - terminei a linha', '222.1', { message_id: 102 });
    expect(r.person_id).toBe(7);
    expect(r.resolution_method).toBe('llm_identified');
    expect(r.confidence).toBe('high');
    expect(r.detected_identification).toBe('Bruno -');
    expect(provider.calls).toHaveLength(1);
  });

  test('LLM medium (contexto) → llm_context, medium', async () => {
    const { resolver } = makeResolver({
      db: makeDb(), llmJson: { person_id: 6, confidence: 'medium', reasoning: 'postou há pouco' },
    });
    const r = await resolver.resolve('U_PL', 'mais 200 feitas', '333.1', { message_id: 103 });
    expect(r.person_id).toBe(6);
    expect(r.resolution_method).toBe('llm_context');
    expect(r.confidence).toBe('medium');
  });

  test('LLM sem palpite + primary_owner presente → fallback_owner, medium', async () => {
    const { resolver } = makeResolver({
      db: makeDb(), llmJson: { person_id: null, confidence: 'unconfirmed', reasoning: 'sem nome' },
    });
    const r = await resolver.resolve('U_VITOR', 'continuando', '444.1', { message_id: 104 });
    expect(r.resolution_method).toBe('fallback_owner');
    expect(r.person_id).toBe(4); // Vitor é primary_owner da conta U_VITOR
    expect(r.confidence).toBe('medium');
  });

  test('Production Line sem nome e sem contexto → unconfirmed + proposal', async () => {
    const { resolver, db } = makeResolver({
      db: makeDb(), llmJson: { person_id: null, confidence: 'unconfirmed', reasoning: 'nada' },
    });
    const r = await resolver.resolve('U_PL', 'feito', '555.1', { message_id: 105 });
    expect(r.resolution_method).toBe('unconfirmed');
    expect(r.confidence).toBe('unconfirmed');
    expect(db.inserts.proposals).toHaveLength(1);
  });

  test('LLM low (mensagem ambígua) → ambiguous, low + proposal', async () => {
    const { resolver, db } = makeResolver({
      db: makeDb(), llmJson: { person_id: 4, confidence: 'low', reasoning: 'dois nomes citados' },
    });
    const r = await resolver.resolve('U_PL', 'eu e a Ana fechamos', '666.1', { message_id: 106 });
    expect(r.resolution_method).toBe('ambiguous');
    expect(r.confidence).toBe('low');
    expect(r.person_id).toBe(4);
    expect(db.inserts.proposals).toHaveLength(1);
  });
});

describe('V3 §2.3 — GUARD admin', () => {
  test('LLM aponta owner/manager no canal de produção → descartado + proposal', async () => {
    const { resolver, db } = makeResolver({
      db: makeDb(), llmJson: { person_id: 1, confidence: 'high', reasoning: 'disse Bruno' },
    });
    const r = await resolver.resolve('U_VITOR', 'Bruno aqui, fechou tudo', '777.1', { message_id: 107 });
    expect(r.resolution_method).toBe('ambiguous_admin_in_production_channel');
    expect(r.confidence).toBe('low');
    expect(r.person_id).toBeNull();
    expect(db.inserts.proposals).toHaveLength(1);
  });

  test('mesma resolução é OK quando isAdminDM=true', async () => {
    const { resolver } = makeResolver({
      db: makeDb(), llmJson: { person_id: 1, confidence: 'high', reasoning: 'admin DM' },
    });
    const r = await resolver.resolve('U_VITOR', 'x', '777.2', { message_id: 108, isAdminDM: true });
    expect(r.resolution_method).not.toBe('ambiguous_admin_in_production_channel');
  });
});

describe('V3 §2.3 — defesa contra resposta inválida do LLM', () => {
  test('person_id inexistente → llm_invalid_person, unconfirmed', async () => {
    const { resolver, db } = makeResolver({
      db: makeDb(), llmJson: { person_id: 999, confidence: 'high', reasoning: 'alucinou' },
    });
    const r = await resolver.resolve('U_VITOR', 'x', '888.1', { message_id: 109 });
    expect(r.resolution_method).toBe('llm_invalid_person');
    expect(r.confidence).toBe('unconfirmed');
    expect(db.inserts.proposals).toHaveLength(1);
  });

  test('person fora dos candidatos da conta → llm_invalid_person', async () => {
    const { resolver } = makeResolver({
      db: makeDb(), llmJson: { person_id: 8, confidence: 'high', reasoning: 'Solo não usa essa conta' },
    });
    const r = await resolver.resolve('U_VITOR', 'x', '888.2', { message_id: 110 });
    expect(r.resolution_method).toBe('llm_invalid_person');
  });

  test('JSON inválido do LLM → unconfirmed (llm_invalid_json)', async () => {
    const { resolver } = makeResolver({ db: makeDb(), llmJson: 'isso não é json' });
    const r = await resolver.resolve('U_VITOR', 'x', '888.3', { message_id: 111 });
    expect(r.resolution_method).toBe('llm_invalid_json');
    expect(r.confidence).toBe('unconfirmed');
  });

  test('LLM lança (rate limit/erro) → unconfirmed + retryable', async () => {
    const { resolver } = makeResolver({ db: makeDb(), llmError: new Error('anthropic 529 overloaded') });
    const r = await resolver.resolve('U_VITOR', 'x', '888.4', { message_id: 112 });
    expect(r.resolution_method).toBe('llm_error');
    expect(r.confidence).toBe('unconfirmed');
    expect(r.retryable).toBe(true);
  });

  test('shared_account_users vazio (impossível) → erro claro', async () => {
    const db = makeDb({
      accounts: [{ slack_user_id: 'U_EMPTY', primary_owner_id: null, description: 'Vazia' }],
      users: [],
    });
    const { resolver } = makeResolver({ db, llmJson: { person_id: 4, confidence: 'high' } });
    await expect(resolver.resolve('U_EMPTY', 'x', '888.5', { message_id: 113 }))
      .rejects.toThrow(/integridade/);
  });
});

describe('V3 §2.3 — audit + cache', () => {
  test('toda resolução grava em prefix_resolution_log', async () => {
    const { resolver, db } = makeResolver({
      db: makeDb(), llmJson: { person_id: 7, confidence: 'high', identification_evidence: 'Bruno' },
    });
    await resolver.resolve('U_VITOR', 'Bruno fechou', '999.1', { message_id: 114 });
    expect(db.inserts.prefix_log).toHaveLength(1);
    expect(db.inserts.prefix_log[0][0]).toBe(114);          // message_id
    expect(db.inserts.prefix_log[0][3]).toBe(7);            // resolved_person_id
  });

  test('cache por slack_ts — mesma msg não re-resolve (zero LLM, zero re-log)', async () => {
    const { resolver, provider, db } = makeResolver({
      db: makeDb(), llmJson: { person_id: 7, confidence: 'high' },
    });
    await resolver.resolve('U_VITOR', 'Bruno', 'SAME_TS', { message_id: 115 });
    await resolver.resolve('U_VITOR', 'Bruno', 'SAME_TS', { message_id: 115 });
    expect(provider.calls).toHaveLength(1);
    expect(db.inserts.prefix_log).toHaveLength(1);
  });

  test('cache de diretório expira após o TTL (30s)', async () => {
    let t = 1000;
    const db = makeDb();
    const { resolver } = makeResolver({ db, llmJson: { person_id: 6, confidence: 'high' }, now: () => t });
    await resolver.resolve('U_VITOR', 'a', 't1', { message_id: 116 });
    const first = accountsQueryCount(db);
    await resolver.resolve('U_VITOR', 'b', 't2', { message_id: 117 }); // dentro do TTL
    expect(accountsQueryCount(db)).toBe(first); // não refetch
    t += 31000;
    await resolver.resolve('U_VITOR', 'c', 't3', { message_id: 118 }); // TTL expirou
    expect(accountsQueryCount(db)).toBe(first * 2); // refetch
  });
});
