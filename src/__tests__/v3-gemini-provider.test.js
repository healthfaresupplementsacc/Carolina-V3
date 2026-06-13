'use strict';
/* Tests do GeminiProvider (REST mockado) + FallbackProvider. */
const GeminiProvider = require('../v3/llm/providers/GeminiProvider');
const FallbackProvider = require('../v3/llm/providers/FallbackProvider');
const { getProductionProvider } = require('../v3/llm/LLMProvider');

function geminiResp(jsonOut, { tin = 1000, tout = 200 } = {}) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(jsonOut) }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: tin, candidatesTokenCount: tout },
    }),
  };
}

describe('GeminiProvider', () => {
  test('classifyRaw: monta request certo + parseia JSON + usage', async () => {
    const calls = [];
    const fakeFetch = jest.fn(async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return geminiResp({ command_type: 'query', ok: true }); });
    const p = new GeminiProvider({ apiKey: 'k', fetch: fakeFetch, model: 'gemini-2.5-flash' });
    const r = await p.classifyRaw('SYSTEM TXT', 'pergunta', { maxTokens: 512 });
    expect(calls[0].url).toContain('/models/gemini-2.5-flash:generateContent');
    expect(calls[0].body.systemInstruction.parts[0].text).toBe('SYSTEM TXT');
    expect(calls[0].body.contents[0].parts[0].text).toBe('pergunta');
    expect(calls[0].body.generationConfig.responseMimeType).toBe('application/json');
    expect(calls[0].body.generationConfig.maxOutputTokens).toBe(512);
    expect(r.json_parsed).toEqual({ command_type: 'query', ok: true });
    expect(r.provider_used).toBe('gemini');
    expect(r.tokens_in).toBe(1000);
    expect(r.tokens_out).toBe(200);
    expect(r.cost_estimate_usd).toBe(0); // free tier default
  });

  test('system como ARRAY de blocks (modo cache Anthropic) é achatado', async () => {
    const calls = [];
    const fakeFetch = jest.fn(async (url, opts) => { calls.push(JSON.parse(opts.body)); return geminiResp({}); });
    const p = new GeminiProvider({ apiKey: 'k', fetch: fakeFetch });
    await p.classifyRaw([{ type: 'text', text: 'REGRAS', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'CATALOGOS' }], 'msg');
    expect(calls[0].systemInstruction.parts[0].text).toBe('REGRAS\n\nCATALOGOS');
  });

  test('classify usa context.systemPrompt/userContent e mapeia ClassificationResult', async () => {
    const out = {
      interpretation: 'Vitor inicia linha', categorization: 'activity_start',
      confidence_overall: 'high',
      actions: [{ type: 'open_event', person_id: 4 }],
    };
    const p = new GeminiProvider({ apiKey: 'k', fetch: async () => geminiResp(out, { tin: 5000, tout: 300 }) });
    const r = await p.classify({ text: 'S: linha' }, { systemPrompt: [{ text: 'X' }], userContent: 'S: linha' });
    expect(r.actions).toHaveLength(1);
    expect(r.confidence).toBe('high');
    expect(r.provider_used).toBe('gemini');
    expect(r.model_used).toBe('gemini-2.5-flash');
  });

  test('tier paid calcula custo (free = 0)', async () => {
    const p = new GeminiProvider({ apiKey: 'k', tier: 'paid', fetch: async () => geminiResp({}, { tin: 1e6, tout: 1e6 }) });
    const r = await p.classifyRaw('s', 'u');
    expect(r.cost_estimate_usd).toBeCloseTo(0.30 + 2.50, 4);
  });

  test('HTTP 429 → lança erro com status (combustível do fallback)', async () => {
    const p = new GeminiProvider({
      apiKey: 'k',
      fetch: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota exceeded' } }) }),
    });
    await expect(p.classifyRaw('s', 'u')).rejects.toMatchObject({ status: 429 });
  });

  test('sem API key → erro claro', async () => {
    const p = new GeminiProvider({ apiKey: '', fetch: async () => geminiResp({}) });
    await expect(p.classifyRaw('s', 'u')).rejects.toThrow(/GEMINI_API_KEY/);
  });

  test('resposta não-JSON → json_parsed null (Observer trata como parse_error)', async () => {
    const p = new GeminiProvider({
      apiKey: 'k',
      fetch: async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'lalala' }] } }], usageMetadata: {} }) }),
    });
    const r = await p.classifyRaw('s', 'u');
    expect(r.json_parsed).toBeNull();
    expect(r.raw_text).toBe('lalala');
  });
});

describe('FallbackProvider', () => {
  const okProvider = (name, marker) => ({
    name,
    classify: jest.fn(async () => ({ provider_used: name, marker })),
    classifyRaw: jest.fn(async () => ({ provider_used: name, marker })),
  });
  const failProvider = (name) => ({
    name,
    classify: jest.fn(async () => { throw new Error(name + ' down'); }),
    classifyRaw: jest.fn(async () => { throw new Error(name + ' down'); }),
  });

  test('primário ok → usado; fallback nem é chamado', async () => {
    const g = okProvider('gemini'); const a = okProvider('anthropic');
    const f = new FallbackProvider({ primary: g, fallback: a });
    const r = await f.classifyRaw('s', 'u');
    expect(r.provider_used).toBe('gemini');
    expect(a.classifyRaw).not.toHaveBeenCalled();
  });

  test('primário falha → fallback responde NA MESMA chamada', async () => {
    const g = failProvider('gemini'); const a = okProvider('anthropic');
    const f = new FallbackProvider({ primary: g, fallback: a });
    const r = await f.classify({ text: 'x' }, {});
    expect(r.provider_used).toBe('anthropic');
    expect(g.classify).toHaveBeenCalledTimes(1);
  });

  test('3 falhas na janela → curto-circuito (primário nem é tentado)', async () => {
    let t = 1000;
    const g = failProvider('gemini'); const a = okProvider('anthropic');
    const f = new FallbackProvider({ primary: g, fallback: a, now: () => t });
    await f.classifyRaw('s', 'u'); await f.classifyRaw('s', 'u'); await f.classifyRaw('s', 'u');
    expect(g.classifyRaw).toHaveBeenCalledTimes(3);
    await f.classifyRaw('s', 'u'); // 4ª: curto-circuito
    expect(g.classifyRaw).toHaveBeenCalledTimes(3); // não tentou de novo
    expect(a.classifyRaw).toHaveBeenCalledTimes(4);
    // janela expira → tenta primário de novo
    t += 5 * 60 * 1000 + 1;
    await f.classifyRaw('s', 'u');
    expect(g.classifyRaw).toHaveBeenCalledTimes(4);
  });

  test('sucesso do primário ZERA o contador de falhas', async () => {
    const g = { name: 'gemini', classifyRaw: jest.fn() };
    g.classifyRaw
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce({ provider_used: 'gemini' })
      .mockRejectedValueOnce(new Error('x'));
    const a = okProvider('anthropic');
    const f = new FallbackProvider({ primary: g, fallback: a });
    await f.classifyRaw('s', 'u'); // falha 1 → fallback
    await f.classifyRaw('s', 'u'); // falha 2 → fallback
    await f.classifyRaw('s', 'u'); // sucesso → zera
    await f.classifyRaw('s', 'u'); // falha (contador=1, ainda tenta primário nas próximas)
    expect(g.classifyRaw).toHaveBeenCalledTimes(4);
  });
});

describe('getProductionProvider (flag LLM_PROVIDER)', () => {
  const OLD = process.env.LLM_PROVIDER;
  afterAll(() => { if (OLD === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = OLD; });

  test('default (sem env) → fallback(gemini->anthropic)', () => {
    delete process.env.LLM_PROVIDER;
    expect(getProductionProvider().name).toBe('fallback(gemini->anthropic)');
  });
  test('LLM_PROVIDER=anthropic → anthropic puro (rollback 1 env)', () => {
    process.env.LLM_PROVIDER = 'anthropic';
    expect(getProductionProvider().name).toBe('anthropic');
  });
  test('LLM_PROVIDER=gemini → fallback(gemini->anthropic)', () => {
    process.env.LLM_PROVIDER = 'gemini';
    expect(getProductionProvider().name).toBe('fallback(gemini->anthropic)');
  });
});
