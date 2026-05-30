'use strict';
// HEALTHFARE V3 — PARTE 2.3 — testes comportamentais do PersonResolver.
const { PersonResolver } = require('../v3/services/PersonResolver');
const MockProvider = require('../v3/llm/providers/MockProvider');

// ── fixtures ──
const PERSONS = [
  { id: 1, display_name: 'Bruno Camp', role: 'owner', slack_user_id: 'U_BRUNO_CAMP' },
  { id: 2, display_name: 'Thassio', role: 'owner', slack_user_id: 'U_THASSIO' },
  { id: 3, display_name: 'Henrique', role: 'manager', slack_user_id: 'U_HENRIQUE' },
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
    // string llmJson = resposta NÃO-JSON do LLM (json_parsed null)
    provider.setRawResult(typeof llmJson === 'string'
      ? { json_parsed: null, raw_text: llmJson, cost_estimate_usd: 0.001 }
      : { json_parsed: llmJson, cost_estimate_usd: 0.001 });
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
    expect(provider.rawCalls).toHaveLength(0);
  });

  test('slack_user_id desconhecido → unknown_account / unconfirmed', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_NINGUEM', 'oi', '111.2', { message_id: 101 });
    expect(r.resolution_method).toBe('unknown_account');
    expect(r.confidence).toBe('unconfirmed');
    expect(r.person_id).toBeNull();
  });
});

describe('V3 §2.3 — conta compartilhada (LLM só pra contas SEM primary_owner)', () => {
  // Bloco 29/mai-noite: contas COM primary_owner agora resolvem direto
  // sem LLM. LLM só roda em contas tipo Production Line (sem owner).
  test('Production Line (sem owner, msg sem nome reconhecido) → LLM identifica', async () => {
    // msg sem nome conhecido no início/fim — força caminho LLM.
    const { resolver, provider } = makeResolver({
      db: makeDb(),
      llmJson: { person_id: 6, identification_evidence: 'inferido', confidence: 'high', reasoning: 'só LLM tem contexto' },
    });
    const r = await resolver.resolve('U_PL', 'feita 200 garrafas', '222.1', { message_id: 102 });
    expect(r.person_id).toBe(6);
    expect(r.resolution_method).toBe('llm_identified');
    expect(r.confidence).toBe('high');
    expect(provider.rawCalls).toHaveLength(1);
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

describe('V3 §2.3 — admin no canal de produção (bloco 29/mai-noite hard-skip)', () => {
  // ANTES: admin postava de conta compartilhada com texto "Bruno Camp aqui"
  // e o LLM detectava como admin_intervention. AGORA: detecção é por
  // slack_user_id (admin com conta própria) OU assinatura "-Bruno Camp".
  test('admin postando da própria conta sem assinatura → admin_directive', async () => {
    const { resolver, provider, db } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_BRUNO_CAMP', 'parem a linha agora', 'adm.1', { message_id: 107 });
    expect(r.resolution_method).toBe('admin_directive');
    expect(r.person_id).toBe(1);                  // Bruno Camp
    expect(r.is_admin_context).toBe(true);
    expect(r.confidence).toBe('high');
    expect(provider.rawCalls).toHaveLength(0);    // zero LLM
    expect(db.inserts.proposals).toHaveLength(0);
  });

  test('Thassio da conta própria → admin_directive (mesmo caso ev302 28/mai)', async () => {
    const { resolver, provider } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_THASSIO', 'to em reuniao', 'adm.2', { message_id: 108 });
    expect(r.resolution_method).toBe('admin_directive');
    expect(r.is_admin_context).toBe(true);
    expect(r.person_id).toBe(2);
    expect(provider.rawCalls).toHaveLength(0);
  });

  test('Henrique da conta própria → admin_directive (manager)', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_HENRIQUE', '@Vitor faz X', 'adm.3', { message_id: 109 });
    expect(r.resolution_method).toBe('admin_directive');
    expect(r.is_admin_context).toBe(true);
    expect(r.person_id).toBe(3);
  });

  test('admin_directive grava em prefix_resolution_log', async () => {
    const { resolver, db } = makeResolver({ db: makeDb() });
    await resolver.resolve('U_THASSIO', 'supervisão', 'adm.4', { message_id: 110 });
    expect(db.inserts.prefix_log).toHaveLength(1);
    expect(db.inserts.prefix_log[0][3]).toBe(2);                  // Thassio
    expect(db.inserts.prefix_log[0][4]).toBe('admin_directive');
  });

  test('assinatura ambígua "-Bruno" via conta compartilhada → prefere operador Sarmento, NÃO admin Camp', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'parem a linha -Bruno', 'adm.5', { message_id: 111 });
    // "Bruno" pode ser Bruno Camp (owner) ou Bruno Sarmento (operator).
    // Preferência por operador — msgs operacionais com "Bruno" referem
    // ao operador, nunca ao owner. Documentado na regra do _parseSignature.
    expect(r.person_id).toBe(7);                  // Bruno Sarmento
    expect(r.resolution_method).toBe('signature_match');
    expect(r.is_admin_context).toBe(false);
  });
});

describe('V3 §2.3 — defesa contra resposta inválida do LLM (em U_PL sem owner)', () => {
  test('person_id inexistente → llm_invalid_person, unconfirmed', async () => {
    const { resolver, db } = makeResolver({
      db: makeDb(), llmJson: { person_id: 999, confidence: 'high', reasoning: 'alucinou' },
    });
    const r = await resolver.resolve('U_PL', 'x', '888.1', { message_id: 109 });
    expect(r.resolution_method).toBe('llm_invalid_person');
    expect(r.confidence).toBe('unconfirmed');
    expect(db.inserts.proposals).toHaveLength(1);
  });

  test('person fora dos candidatos da conta → llm_invalid_person', async () => {
    const { resolver } = makeResolver({
      db: makeDb(), llmJson: { person_id: 8, confidence: 'high', reasoning: 'Solo não usa essa conta' },
    });
    const r = await resolver.resolve('U_PL', 'x', '888.2', { message_id: 110 });
    expect(r.resolution_method).toBe('llm_invalid_person');
  });

  test('JSON inválido do LLM → unconfirmed (llm_invalid_json)', async () => {
    const { resolver } = makeResolver({ db: makeDb(), llmJson: 'isso não é json' });
    const r = await resolver.resolve('U_PL', 'x', '888.3', { message_id: 111 });
    expect(r.resolution_method).toBe('llm_invalid_json');
    expect(r.confidence).toBe('unconfirmed');
  });

  test('LLM lança (rate limit/erro) → unconfirmed + retryable', async () => {
    const { resolver } = makeResolver({ db: makeDb(), llmError: new Error('anthropic 529 overloaded') });
    const r = await resolver.resolve('U_PL', 'x', '888.4', { message_id: 112 });
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

describe('V3 — parser de assinatura (bloco 29/mai-noite #1b) — zero LLM', () => {
  // Caso real do backfill §2.13 — mensagem da conta do Vitor assinada -Bruno.
  test('"S-Linha de producao ( PLANT 0136)-Bruno" da conta do Vitor → Bruno Sarmento (parser)', async () => {
    const { resolver, provider } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'S-Linha de producao ( PLANT 0136)-Bruno', 'fe.1', { message_id: 201 });
    expect(r.person_id).toBe(7);            // Bruno Sarmento (operador)
    expect(r.person_id).not.toBe(4);        // NÃO Vitor (dono)
    expect(r.resolution_method).toBe('signature_match');
    expect(r.confidence).toBe('high');
    expect(r.detected_identification).toMatch(/-Bruno/);
    expect(provider.rawCalls).toHaveLength(0);   // zero LLM — parser deterministic
  });

  test('"Bruno-voltei do almoco" (prefixo Bruno-) da conta do Vitor → Bruno Sarmento', async () => {
    // Caso real 29/mai 3:19 PM.
    const { resolver, provider } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'Bruno-voltei do almoco', 'fe.3', { message_id: 203 });
    expect(r.person_id).toBe(7);
    expect(r.resolution_method).toBe('signature_match');
    expect(provider.rawCalls).toHaveLength(0);
  });

  test('"feito (Bruno)" no fim → Bruno Sarmento', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'F: linha terminada (Bruno)', 'fe.4', { message_id: 204 });
    expect(r.person_id).toBe(7);
    expect(r.resolution_method).toBe('signature_match');
  });

  test('"feito por Bruno" no fim → Bruno Sarmento', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'Linha completada por Bruno', 'fe.5', { message_id: 205 });
    expect(r.person_id).toBe(7);
    expect(r.resolution_method).toBe('signature_match');
  });

  test('assinatura "Bruno" no texto operacional prefere OPERADOR (Sarmento) sobre owner Camp', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_PL', 'Bruno-voltei do almoco', 'fe.6', { message_id: 206 });
    expect(r.person_id).toBe(7);          // Bruno Sarmento (operador, id 7)
    expect(r.person_id).not.toBe(1);      // NUNCA Bruno Camp (owner, id 1)
    expect(r.resolution_method).toBe('signature_match');
  });

  test('"S:" / "F:" sozinhos não são assinatura (ruído filtrado)', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'S: Iniciando linha', 'fe.7', { message_id: 207 });
    // S: não bate parser (curto demais, ruído). Cai em owner_default → Vitor.
    expect(r.person_id).toBe(4);
    expect(r.resolution_method).toBe('owner_default');
  });

  test('nome no texto que NÃO é assinatura ("ajudando Bruno") → owner + mention_uncertain', async () => {
    // PHASE 2 (bloco 29/mai-noite): texto menciona outro nome SEM padrão
    // de assinatura → mantém owner mas marca uncertain pra admin conferir.
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'estou ajudando Bruno na linha', 'fe.8', { message_id: 208 });
    expect(r.person_id).toBe(4);            // Vitor (owner)
    expect(r.resolution_method).toBe('mention_uncertain');
    expect(r.confidence).toBe('low');
  });
});

describe('V3 — parser PHASE 2 (bloco 29/mai-noite — underscore/espaço/lowercase)', () => {
  // POSITIVOS — casos reais da varredura 27-29/mai. Todos devem virar
  // signature_match pra Bruno Sarmento (id=7).

  test('suffix_space: "S-Lithium- 0166 ( rodando ) Bruno" → Bruno Sarmento', async () => {
    const { resolver, provider } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'S-Lithium- 0166 ( rodando ) Bruno', 'p2.1', { message_id: 400 });
    expect(r.person_id).toBe(7);
    expect(r.resolution_method).toBe('signature_match');
    expect(provider.rawCalls).toHaveLength(0);
  });

  test('suffix_underscore: "S-Rutin na maquina de capsula_Bruno" → Bruno Sarmento', async () => {
    const { resolver, provider } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'S-Rutin na maquina de capsula_Bruno', 'p2.2', { message_id: 401 });
    expect(r.person_id).toBe(7);
    expect(r.resolution_method).toBe('signature_match');
    expect(provider.rawCalls).toHaveLength(0);
  });

  test('suffix_underscore com espaço: "_ Bruno" no fim → Bruno Sarmento', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'S-Apple Cider-0132 ( para capsulas ) _ Bruno', 'p2.3', { message_id: 402 });
    expect(r.person_id).toBe(7);
    expect(r.resolution_method).toBe('signature_match');
  });

  test('suffix_space case-insensitive: "bruno" minúsculo no fim → Bruno Sarmento', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'S-Rutin-0174 (para capsulas ) bruno', 'p2.4', { message_id: 403 });
    expect(r.person_id).toBe(7);
    expect(r.resolution_method).toBe('signature_match');
  });

  test('prefix_space: "Bruno indo agora almocar" → Bruno Sarmento', async () => {
    const { resolver, provider } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'Bruno indo agora almocar', 'p2.5', { message_id: 404 });
    expect(r.person_id).toBe(7);
    expect(r.resolution_method).toBe('signature_match');
    expect(provider.rawCalls).toHaveLength(0);
  });

  test('prefix_space com ! no fim: "Bruno almocar agora !" → Bruno Sarmento', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'Bruno almocar agora !', 'p2.6', { message_id: 405 });
    expect(r.person_id).toBe(7);
    expect(r.resolution_method).toBe('signature_match');
  });

  // NEGATIVOS — ambiguidade / menção / sem nome / nome desconhecido

  test('"ajudando Bruno na linha" via Vitor — owner Vitor, MAS mention_uncertain', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'estou ajudando Bruno na linha', 'p2.7', { message_id: 406 });
    expect(r.person_id).toBe(4);                       // Vitor (owner)
    expect(r.resolution_method).toBe('mention_uncertain');
    expect(r.confidence).toBe('low');
  });

  test('"S: linha Bruno e Vitor" — ambíguo, owner fallback + uncertain', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'S: linha Bruno e Vitor', 'p2.8', { message_id: 407 });
    expect(r.person_id).toBe(4);                       // Vitor (owner fallback)
    expect(r.resolution_method).toBe('ambiguous_signature');
    expect(r.confidence).toBe('low');
  });

  test('"Bruno e Vitor estao na linha" — ambíguo (prefix_space match mas múltiplos nomes)', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'Bruno e Vitor estao na linha', 'p2.9', { message_id: 408 });
    expect(r.resolution_method).toBe('ambiguous_signature');
    expect(r.confidence).toBe('low');
  });

  test('"F" (1 letra) → não captura, owner_default', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'F', 'p2.10', { message_id: 409 });
    expect(r.person_id).toBe(4);
    expect(r.resolution_method).toBe('owner_default');
    expect(r.confidence).toBe('high');
  });

  test('"S: linha de producao" sem nome → owner_default high', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'S: linha de producao', 'p2.11', { message_id: 410 });
    expect(r.person_id).toBe(4);
    expect(r.resolution_method).toBe('owner_default');
    expect(r.confidence).toBe('high');
  });

  test('"S-Linha_Pedro" — nome desconhecido, owner fallback + uncertain', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'S-Linha_Pedro', 'p2.12', { message_id: 411 });
    expect(r.person_id).toBe(4);                       // Vitor (owner fallback)
    expect(r.resolution_method).toBe('unknown_signature_name');
    expect(r.confidence).toBe('low');
  });

  test('"S-" sozinho não captura como prefix (S é 1 letra)', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'S- algo qualquer', 'p2.13', { message_id: 412 });
    // "algo" 4 letras, "qualquer" 8 letras — algo no início após "S- "?
    // Pattern prefix_dash `^Nome\s*-` mata em "S-" mas "S" é 1 letra (<2) — não bate.
    // Pattern prefix_space `^Nome\s` — pega "S" mas requer 3+ letras — não bate.
    // Pattern suffix_space — "qualquer" no fim, mas qualquer não está no catálogo.
    expect(r.person_id).toBe(4);
    expect(r.resolution_method).toBe('owner_default');
  });
});

describe('V3 — owner_default sem contaminação (bloco 29/mai-noite #1c)', () => {
  // ANTES (causa do bug duplo-almoço 29/mai 3:22 PM): msgs do Vitor sem
  // assinatura iam pro LLM, que herdava contexto da msg anterior assinada
  // por Bruno → atribuía pro Bruno. AGORA: owner-default, sem LLM.
  test('msg do Vitor sem assinatura → Vitor (não herda Bruno do contexto)', async () => {
    const recent = [
      { raw_text: 'Bruno-voltei do almoco', created_at: new Date(Date.now() - 3 * 60 * 1000), person_id: 7, person_name: 'Bruno Sarmento' },
    ];
    const { resolver, provider } = makeResolver({ db: makeDb({ recent }) });
    const r = await resolver.resolve('U_VITOR', 'F: Finalizando ajuda na linha para almocar', '3.22.1', { message_id: 250 });
    expect(r.person_id).toBe(4);              // Vitor (owner), não Bruno
    expect(r.resolution_method).toBe('owner_default');
    expect(provider.rawCalls).toHaveLength(0);
  });

  test('msg seguinte sem assinatura → ainda Vitor (sem bleed do contexto)', async () => {
    const recent = [
      { raw_text: 'Bruno-voltei do almoco', created_at: new Date(Date.now() - 4 * 60 * 1000), person_id: 7, person_name: 'Bruno Sarmento' },
      { raw_text: 'F: Finalizando ajuda', created_at: new Date(Date.now() - 1 * 60 * 1000), person_id: 4, person_name: 'Vitor' },
    ];
    const { resolver } = makeResolver({ db: makeDb({ recent }) });
    const r = await resolver.resolve('U_VITOR', 'S: Inicio Almoco', '3.22.2', { message_id: 251 });
    expect(r.person_id).toBe(4);
    expect(r.resolution_method).toBe('owner_default');
  });

  test('"S: Iniciando revisao" da conta do Vitor → Vitor (NÃO Simone)', async () => {
    const { resolver, provider } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'S: Iniciando revisao VitaB2 (0151)', 'sf.1', { message_id: 301 });
    expect(r.person_id).toBe(4);       // Vitor (dono)
    expect(r.person_id).not.toBe(5);   // NÃO Simone
    expect(r.resolution_method).toBe('owner_default');
    expect(provider.rawCalls).toHaveLength(0);
  });

  test('"F: Limpeza Maquinario" da conta do Vitor → Vitor', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'F: Limpeza Maquinario Formulacao', 'sf.2', { message_id: 302 });
    expect(r.person_id).toBe(4);
    expect(r.resolution_method).toBe('owner_default');
  });

  test('nome explícito ainda vence: "S-Potassium rodando-Bruno" → Bruno Sarmento (parser)', async () => {
    const { resolver } = makeResolver({ db: makeDb() });
    const r = await resolver.resolve('U_VITOR', 'S-Potassium rodando-Bruno', 'sf.3', { message_id: 303 });
    expect(r.person_id).toBe(7);
    expect(r.resolution_method).toBe('signature_match');
  });
});

describe('V3 §2.3 — audit + cache', () => {
  test('toda resolução grava em prefix_resolution_log (parser path)', async () => {
    const { resolver, db } = makeResolver({ db: makeDb() });
    await resolver.resolve('U_VITOR', '-Bruno', '999.1', { message_id: 114 });
    expect(db.inserts.prefix_log).toHaveLength(1);
    expect(db.inserts.prefix_log[0][0]).toBe(114);          // message_id
    expect(db.inserts.prefix_log[0][3]).toBe(7);            // resolved_person_id Bruno Sarmento
    expect(db.inserts.prefix_log[0][4]).toBe('signature_match');
  });

  test('toda resolução grava em prefix_resolution_log (owner_default path)', async () => {
    const { resolver, db } = makeResolver({ db: makeDb() });
    await resolver.resolve('U_VITOR', 'continuando', '999.2', { message_id: 115 });
    expect(db.inserts.prefix_log).toHaveLength(1);
    expect(db.inserts.prefix_log[0][3]).toBe(4);            // Vitor
    expect(db.inserts.prefix_log[0][4]).toBe('owner_default');
  });

  test('cache por slack_ts — mesma msg não re-resolve (zero LLM, zero re-log)', async () => {
    // Use U_PL pra forçar caminho LLM e exercitar o cache.
    const { resolver, provider, db } = makeResolver({
      db: makeDb(), llmJson: { person_id: 7, confidence: 'high' },
    });
    await resolver.resolve('U_PL', 'msg ambígua', 'SAME_TS', { message_id: 115 });
    await resolver.resolve('U_PL', 'msg ambígua', 'SAME_TS', { message_id: 115 });
    expect(provider.rawCalls).toHaveLength(1);
    expect(db.inserts.prefix_log).toHaveLength(1);
  });

  test('falha transitória (llm_error) NÃO é cacheada — re-resolve na próxima', async () => {
    const { resolver, provider } = makeResolver({
      db: makeDb(), llmError: new Error('credit balance is too low'),
    });
    const r1 = await resolver.resolve('U_PL', 'msg ambígua', 'TS_ERR', { message_id: 130 });
    const r2 = await resolver.resolve('U_PL', 'msg ambígua', 'TS_ERR', { message_id: 130 });
    expect(r1.resolution_method).toBe('llm_error');
    expect(r2.resolution_method).toBe('llm_error');
    expect(provider.rawCalls).toHaveLength(2);
  });

  test('resolução bem-sucedida APÓS um llm_error transitório é cacheada', async () => {
    const { resolver, provider } = makeResolver({
      db: makeDb(), llmError: new Error('429 rate limit'),
    });
    const r1 = await resolver.resolve('U_PL', 'msg ambígua', 'TS_RECOVER', { message_id: 131 });
    expect(r1.resolution_method).toBe('llm_error');
    provider.setRawResult({ json_parsed: { person_id: 7, confidence: 'high' }, cost_estimate_usd: 0.001 });
    const r2 = await resolver.resolve('U_PL', 'msg ambígua', 'TS_RECOVER', { message_id: 131 });
    const r3 = await resolver.resolve('U_PL', 'msg ambígua', 'TS_RECOVER', { message_id: 131 });
    expect(r2.person_id).toBe(7);
    expect(r3.person_id).toBe(7);
    expect(provider.rawCalls).toHaveLength(2);
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
