'use strict';
// HEALTHFARE V3 — Bloco 1/jun Fase 1 — testes do prompt caching.
// Cobre o modo array do systemPrompt (cache_control: ephemeral) +
// extração de cache metrics no AnthropicProvider + cost com cache pricing.

// Ativa cache pra estes testes (default em prod é ON)
process.env.V3_PROMPT_CACHE_ENABLED = '1';
const { PromptBuilder, SYSTEM_PROMPT } = require('../v3/llm/prompt-builder');
const AnthropicProvider = require('../v3/llm/providers/AnthropicProvider');

function makeFakeDb(seed = {}) {
  const d = {
    persons: [], activeEvents: [], products: [], activityTypes: [],
    batches: [], channelMsgs: [], personMsgs: [], corrections: [], vocab: [], profile: null,
  };
  Object.assign(d, seed);
  return {
    query: jest.fn((sql) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/FROM v3\.persons WHERE active = true/.test(s)) return Promise.resolve({ rows: d.persons });
      if (/FROM v3\.events e/.test(s) && /ended_at IS NULL/.test(s)) return Promise.resolve({ rows: d.activeEvents });
      if (/FROM v3\.products WHERE active = true/.test(s)) return Promise.resolve({ rows: d.products });
      if (/FROM v3\.activity_types WHERE active = true/.test(s)) return Promise.resolve({ rows: d.activityTypes });
      if (/FROM v3\.product_batches/.test(s)) return Promise.resolve({ rows: d.batches });
      if (/FROM v3\.messages m/.test(s) && /slack_channel_id/.test(s)) return Promise.resolve({ rows: d.channelMsgs });
      if (/FROM v3\.llm_corrections/.test(s)) return Promise.resolve({ rows: d.corrections });
      if (/FROM v3\.vocabulary/.test(s)) return Promise.resolve({ rows: d.vocab });
      if (/FROM v3\.messages.*person_id = \$1/.test(s)) return Promise.resolve({ rows: d.personMsgs });
      if (/FROM v3\.person_language_profile/.test(s)) return Promise.resolve({ rows: d.profile ? [d.profile] : [] });
      return Promise.resolve({ rows: [] });
    }),
  };
}

describe('PromptBuilder — modo CACHE (cache_control: ephemeral)', () => {
  test('buildContext retorna systemPrompt como ARRAY de 2 blocos quando cache ON', async () => {
    const db = makeFakeDb({
      persons: [{ id: 4, display_name: 'Vitor', role: 'operator' }],
      products: [{ id: 1, canonical_name: 'Potassium', aliases: [] }],
      activityTypes: [{ id: 5, slug: 'production_line', display_name: 'Linha', flow: 'production', is_background: false }],
    });
    const pb = new PromptBuilder({ db });
    const r = await pb.buildContext({ text: 'S: linha', ts: '1.1', slack_user_id: 'U_VITOR' },
      { author: { person_id: 4, resolution_method: 'direct', confidence: 'high' } });
    expect(Array.isArray(r.systemPrompt)).toBe(true);
    expect(r.systemPrompt).toHaveLength(2);
    expect(r.systemPrompt[0].type).toBe('text');
    expect(r.systemPrompt[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(r.systemPrompt[1].type).toBe('text');
    expect(r.systemPrompt[1].cache_control).toBeUndefined();
    expect(r._cacheEnabled).toBe(true);
  });

  test('bloco STATIC contém SYSTEM_PROMPT + catálogos (regras + products + activity_types)', async () => {
    const db = makeFakeDb({
      products: [{ id: 1, canonical_name: 'Potassium', aliases: [] }],
      activityTypes: [{ id: 5, slug: 'production_line', display_name: 'Linha', flow: 'production' }],
      persons: [{ id: 4, display_name: 'Vitor', role: 'operator' }],
    });
    const pb = new PromptBuilder({ db });
    const r = await pb.buildContext({ text: 'S: linha' }, { author: { person_id: 4 } });
    const staticText = r.systemPrompt[0].text;
    expect(staticText).toContain('PRINCÍPIO FUNDAMENTAL');     // SYSTEM_PROMPT
    expect(staticText).toContain('Potassium');                   // catálogo produtos
    expect(staticText).toContain('production_line');             // catálogo activity_types
    expect(staticText).toContain('CATÁLOGO DE PESSOAS');         // catálogo pessoas
    expect(staticText).toContain('Vitor');
  });

  test('bloco DYNAMIC contém autor + EQUIPE + batches + recent msgs (NÃO catálogos)', async () => {
    const db = makeFakeDb({
      persons: [{ id: 4, display_name: 'Vitor', role: 'operator' }],
      activeEvents: [{ person_id: 4, activity_type_id: 5, started_at: new Date(), category: null, is_background: false }],
      batches: [{ id: 10, batch_number: 'BR-001', started_at: new Date(), product_id: 1, product_name: 'Potassium' }],
      activityTypes: [{ id: 5, slug: 'production_line', display_name: 'Linha', flow: 'production' }],
    });
    const pb = new PromptBuilder({ db });
    const r = await pb.buildContext({ text: 'F: linha', ts: '1.2', slack_user_id: 'U_VITOR' },
      { author: { person_id: 4, resolution_method: 'direct', confidence: 'high' } });
    const dynamicText = r.systemPrompt[1].text;
    expect(dynamicText).toContain('AUTOR DA MENSAGEM');
    expect(dynamicText).toContain('EQUIPE');
    expect(dynamicText).toContain('BATCHES ATIVOS');
    expect(dynamicText).toContain('BR-001');
  });

  test('userContent contém apenas a mensagem atual', async () => {
    const db = makeFakeDb({ persons: [{ id: 4, display_name: 'Vitor', role: 'operator' }] });
    const pb = new PromptBuilder({ db });
    const r = await pb.buildContext({ text: 'S: linha de produção', ts: '1.3', slack_user_id: 'U_VITOR' },
      { author: { person_id: 4 } });
    expect(r.userContent).toContain('MENSAGEM A INTERPRETAR');
    expect(r.userContent).toContain('S: linha de produção');
    // userContent NÃO deve ter catálogos/regras/equipe
    expect(r.userContent).not.toContain('PRINCÍPIO FUNDAMENTAL');
    expect(r.userContent).not.toContain('AUTOR DA MENSAGEM');
  });
});

describe('AnthropicProvider — cache metrics', () => {
  function makeFakeClient(usage) {
    return {
      messages: {
        create: jest.fn(async () => ({
          content: [{ type: 'text', text: JSON.stringify({ confidence_overall: 'high', actions: [] }) }],
          usage,
        })),
      },
    };
  }

  test('classifyRaw com system array → extrai cache_creation/cache_read tokens', async () => {
    const client = makeFakeClient({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 5000,   // primeira chamada cria cache
      cache_read_input_tokens: 0,
    });
    const p = new AnthropicProvider({ client, rateLimiter: null });
    const systemBlocks = [
      { type: 'text', text: 'REGRAS LONGAS...', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'CONTEXTO DINÂMICO...' },
    ];
    const r = await p.classifyRaw(systemBlocks, 'msg user');
    expect(r.cache_enabled).toBe(true);
    expect(r.cache_creation_input_tokens).toBe(5000);
    expect(r.cache_read_input_tokens).toBe(0);
    expect(r.tokens_in).toBe(100);
    expect(r.tokens_out).toBe(50);
  });

  test('classifyRaw segunda chamada (cache hit) → cache_read >> cache_creation', async () => {
    const client = makeFakeClient({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 5000,       // cache hit!
    });
    const p = new AnthropicProvider({ client, rateLimiter: null });
    const r = await p.classifyRaw([{ type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } }], 'msg');
    expect(r.cache_read_input_tokens).toBe(5000);
    expect(r.cache_creation_input_tokens).toBe(0);
  });

  test('classifyRaw com system string (cache OFF legado) — cache_enabled=false, sem cache tokens', async () => {
    const client = makeFakeClient({ input_tokens: 5000, output_tokens: 50 });
    const p = new AnthropicProvider({ client, rateLimiter: null });
    const r = await p.classifyRaw('SYSTEM STRING NORMAL', 'msg');
    expect(r.cache_enabled).toBe(false);
    expect(r.cache_creation_input_tokens).toBe(0);
    expect(r.cache_read_input_tokens).toBe(0);
  });

  test('_cost: cache_read paga 0.1x = 90% off do normal input', () => {
    const p = new AnthropicProvider({ client: { messages: { create: jest.fn() } }, rateLimiter: null });
    // sonnet 4.6 pricing: input $3, cache_write $3.75, cache_read $0.30, output $15
    // 1M input tokens normal = $3.00
    expect(p._cost(1e6, 0, 0, 0)).toBeCloseTo(3.0, 4);
    // 1M cache_write tokens = $3.75 (1.25x)
    expect(p._cost(0, 0, 1e6, 0)).toBeCloseTo(3.75, 4);
    // 1M cache_read tokens = $0.30 (90% economia)
    expect(p._cost(0, 0, 0, 1e6)).toBeCloseTo(0.3, 4);
    // Combo realístico: 500 input + 5000 cache_read + 200 output
    const realistic = p._cost(500, 200, 0, 5000);
    expect(realistic).toBeGreaterThan(0);
    expect(realistic).toBeLessThan(0.01);
  });

  test('_estimateTokens lida com system array', () => {
    const p = new AnthropicProvider({ client: { messages: { create: jest.fn() } }, rateLimiter: null });
    const sysArr = [
      { type: 'text', text: 'a'.repeat(400) },
      { type: 'text', text: 'b'.repeat(400) },
    ];
    const est = p._estimateTokens(sysArr, 'c'.repeat(200), 100);
    // 800+200 chars / 4 + 100 = 350
    expect(est).toBe(350);
  });
});
