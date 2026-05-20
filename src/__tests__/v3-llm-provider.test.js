'use strict';
// HEALTHFARE V3 — PARTE 2.1 — testes comportamentais do Provider Abstraction.
const {
  LLMProvider, getProvider, normalizeResult, normalizeRaw, ACTION_TYPES, CONFIDENCE_LEVELS,
} = require('../v3/llm/LLMProvider');
const AnthropicProvider = require('../v3/llm/providers/AnthropicProvider');
const MockProvider = require('../v3/llm/providers/MockProvider');

describe('V3 §2.1 — LLMProvider interface + fábrica', () => {
  test('classe base: classify() lança (precisa de subclasse)', async () => {
    await expect(new LLMProvider().classify({}, {})).rejects.toThrow(/não implementado/);
  });

  test('getProvider resolve cada provider pelo nome', () => {
    expect(getProvider('anthropic').name).toBe('anthropic');
    expect(getProvider('mock').name).toBe('mock');
    expect(getProvider('openai').name).toBe('openai');
    expect(getProvider('deterministic').name).toBe('deterministic');
  });

  test('getProvider default é anthropic', () => {
    expect(getProvider().name).toBe('anthropic');
    expect(getProvider(null).name).toBe('anthropic');
  });

  test('getProvider com nome desconhecido lança', () => {
    expect(() => getProvider('gemini')).toThrow(/desconhecido/);
  });

  test('constantes expostas', () => {
    expect(ACTION_TYPES).toContain('open_event');
    expect(ACTION_TYPES).toContain('eod_count');
    expect(ACTION_TYPES).toContain('cowork_join');
    expect(CONFIDENCE_LEVELS).toEqual(['high', 'medium', 'low', 'unconfirmed']);
  });
});

describe('V3 §2.1 — normalizeResult', () => {
  test('preenche shape mínimo sem inventar dados', () => {
    const r = normalizeResult({}, 'x');
    expect(r.actions).toEqual([]);
    expect(r.confidence).toBe('unconfirmed');
    expect(r.provider_used).toBe('x');
    expect(r.tokens_in).toBe(0);
    expect(r.new_vocabulary_terms).toEqual([]);
  });

  test('confidence inválida vira unconfirmed', () => {
    expect(normalizeResult({ confidence: 'banana' }).confidence).toBe('unconfirmed');
    expect(normalizeResult({ confidence: 'high' }).confidence).toBe('high');
  });
});

describe('V3 §2.1 — MockProvider', () => {
  test('retorna a decisão configurada e registra as chamadas', async () => {
    const mp = new MockProvider({ result: { interpretation: 'oi', confidence: 'high' } });
    const out = await mp.classify({ text: 'msg' }, { a: 1 });
    expect(out.interpretation).toBe('oi');
    expect(out.confidence).toBe('high');
    expect(out.provider_used).toBe('mock');
    expect(mp.calls).toHaveLength(1);
    expect(mp.calls[0].message).toEqual({ text: 'msg' });
  });

  test('setError faz o classify lançar (testa retry do Observer)', async () => {
    const mp = new MockProvider();
    mp.setError(new Error('anthropic 529 overloaded'));
    await expect(mp.classify({ text: 'x' }, {})).rejects.toThrow(/overloaded/);
  });

  test('setResult troca a decisão', async () => {
    const mp = new MockProvider();
    mp.setResult({ confidence: 'low', admin_question: 'tá certo?' });
    const out = await mp.classify({ text: 'x' }, {});
    expect(out.confidence).toBe('low');
    expect(out.admin_question).toBe('tá certo?');
  });
});

describe('V3 §2.1 — AnthropicProvider', () => {
  function fakeClient(text, usage) {
    return {
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text }],
          usage: usage || { input_tokens: 100, output_tokens: 50 },
        }),
      },
    };
  }

  test('classify parseia JSON, calcula custo e devolve o shape completo', async () => {
    const json = JSON.stringify({
      interpretation: 'Simone foi pra linha',
      actions: [{ type: 'open_event', person_id: 5 }],
      categorization: 'activity_start',
      confidence_overall: 'high',
      react_emoji: 'white_check_mark',
      admin_question: null,
      new_vocabulary_terms: ['fita'],
    });
    const ap = new AnthropicProvider({ client: fakeClient(json) });
    const out = await ap.classify({ text: 'S - linha' }, {});
    expect(out.interpretation).toBe('Simone foi pra linha');
    expect(out.actions).toHaveLength(1);
    expect(out.confidence).toBe('high');
    expect(out.react_emoji).toBe('white_check_mark');
    expect(out.new_vocabulary_terms).toEqual(['fita']);
    expect(out.provider_used).toBe('anthropic');
    expect(out.model_used).toBe('claude-sonnet-4-6');
    expect(out.tokens_in).toBe(100);
    expect(out.tokens_out).toBe(50);
    // 100/1e6*3 + 50/1e6*15 = 0.0003 + 0.00075
    expect(out.cost_estimate_usd).toBeCloseTo(0.00105, 6);
    expect(typeof out.processing_ms).toBe('number');
  });

  test('resposta não-JSON → confidence unconfirmed, não inventa actions', async () => {
    const ap = new AnthropicProvider({ client: fakeClient('desculpa, não entendi') });
    const out = await ap.classify({ text: 'x' }, {});
    expect(out.confidence).toBe('unconfirmed');
    expect(out.actions).toEqual([]);
  });

  test('JSON embutido em texto extra é extraído', async () => {
    const ap = new AnthropicProvider({ client: fakeClient('Aqui: {"interpretation":"ok","confidence_overall":"medium"} fim') });
    const out = await ap.classify({ text: 'x' }, {});
    expect(out.interpretation).toBe('ok');
    expect(out.confidence).toBe('medium');
  });

  test('usa o prompt do prompt-builder quando vem no context', async () => {
    const client = fakeClient('{"interpretation":"x","confidence_overall":"high"}');
    const ap = new AnthropicProvider({ client });
    await ap.classify({ text: 'msg' }, { systemPrompt: 'SYS-RICO', userContent: 'USER-RICO' });
    expect(client.messages.create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-sonnet-4-6', system: 'SYS-RICO',
      messages: [{ role: 'user', content: 'USER-RICO' }],
    }));
  });

  test('sem client → erro claro', async () => {
    const ap = new AnthropicProvider({ client: null });
    ap._client = null;
    await expect(ap.classify({ text: 'x' }, {})).rejects.toThrow(/indispon/);
  });

  test('model é configurável via opts', () => {
    expect(new AnthropicProvider({ client: {}, model: 'claude-opus-4-7' }).model).toBe('claude-opus-4-7');
    expect(new AnthropicProvider({ client: {} }).model).toBe('claude-sonnet-4-6');
  });
});

describe('V3 §2.1 — stubs OpenAI / Deterministic', () => {
  test('OpenAIProvider.classify lança not_implemented', async () => {
    await expect(getProvider('openai').classify({}, {})).rejects.toThrow(/not_implemented/);
  });

  test('DeterministicProvider.classify lança not_implemented', async () => {
    await expect(getProvider('deterministic').classify({}, {})).rejects.toThrow(/not_implemented/);
  });
});

describe('V3 §2.1 — classifyRaw (refactor §2.3)', () => {
  function fakeClient(text, usage) {
    return {
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text }],
          usage: usage || { input_tokens: 100, output_tokens: 50 },
        }),
      },
    };
  }

  test('classe base: classifyRaw() lança', async () => {
    await expect(new LLMProvider().classifyRaw('s', 'u')).rejects.toThrow(/não implementado/);
  });

  test('normalizeRaw preenche o shape mínimo', () => {
    const r = normalizeRaw({}, 'x');
    expect(r.json_parsed).toBeNull();
    expect(r.provider_used).toBe('x');
    expect(r.tokens_in).toBe(0);
  });

  test('MockProvider.classifyRaw devolve o rawResult e registra rawCalls', async () => {
    const mp = new MockProvider();
    mp.setRawResult({ json_parsed: { person_id: 7 }, cost_estimate_usd: 0.001 });
    const out = await mp.classifyRaw('SYS', 'USER');
    expect(out.json_parsed).toEqual({ person_id: 7 });
    expect(out.cost_estimate_usd).toBe(0.001);
    expect(mp.rawCalls).toHaveLength(1);
    expect(mp.rawCalls[0].systemPrompt).toBe('SYS');
  });

  test('MockProvider.classifyRaw respeita setError', async () => {
    const mp = new MockProvider();
    mp.setError(new Error('boom'));
    await expect(mp.classifyRaw('s', 'u')).rejects.toThrow(/boom/);
  });

  test('AnthropicProvider.classifyRaw parseia JSON e devolve RawResult completo', async () => {
    const ap = new AnthropicProvider({ client: fakeClient('{"person_id":7,"confidence":"high"}') });
    const out = await ap.classifyRaw('SYS', 'USER');
    expect(out.json_parsed).toEqual({ person_id: 7, confidence: 'high' });
    expect(out.raw_text).toContain('person_id');
    expect(out.provider_used).toBe('anthropic');
    expect(out.model_used).toBe('claude-sonnet-4-6');
    expect(out.tokens_in).toBe(100);
    expect(out.cost_estimate_usd).toBeCloseTo(0.00105, 6);
  });

  test('AnthropicProvider.classifyRaw com resposta não-JSON → json_parsed null', async () => {
    const ap = new AnthropicProvider({ client: fakeClient('desculpa, não entendi') });
    const out = await ap.classifyRaw('s', 'u');
    expect(out.json_parsed).toBeNull();
    expect(out.raw_text).toBe('desculpa, não entendi');
  });

  test('AnthropicProvider.classifyRaw passa system+user pro client', async () => {
    const client = fakeClient('{"x":1}');
    await new AnthropicProvider({ client }).classifyRaw('SYS-P', 'USER-P');
    expect(client.messages.create).toHaveBeenCalledWith(expect.objectContaining({
      system: 'SYS-P', messages: [{ role: 'user', content: 'USER-P' }],
    }));
  });

  test('classify() continua funcionando (refatorado sobre classifyRaw)', async () => {
    const ap = new AnthropicProvider({ client: fakeClient('{"interpretation":"ok","confidence_overall":"high","actions":[]}') });
    const out = await ap.classify({ text: 'x' }, {});
    expect(out.interpretation).toBe('ok');
    expect(out.confidence).toBe('high');
  });

  test('stubs OpenAI/Deterministic: classifyRaw lança not_implemented', async () => {
    await expect(getProvider('openai').classifyRaw('s', 'u')).rejects.toThrow(/not_implemented/);
    await expect(getProvider('deterministic').classifyRaw('s', 'u')).rejects.toThrow(/not_implemented/);
  });
});
