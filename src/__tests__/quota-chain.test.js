'use strict';
/* QuotaChainProvider — rotação de provedores grátis por cota (Bruno 07-03). */
const { QuotaChainProvider, nextGeminiResetMs } = require('../v3/llm/providers/QuotaChainProvider');

const mk = (name, fn) => ({ name, classify: fn, classifyRaw: fn });
const quotaErr = () => { const e = new Error('Gemini HTTP 429: You exceeded your current quota'); e.status = 429; return e; };

describe('QuotaChainProvider', () => {
  test('cota no 1º → roda no 2º NA MESMA chamada; 1º dorme até o reset', async () => {
    let aCalls = 0, bCalls = 0;
    const a = mk('a', async () => { aCalls++; throw quotaErr(); });
    const b = mk('b', async () => { bCalls++; return { ok: 'b' }; });
    const chain = new QuotaChainProvider({ links: [{ provider: a }, { provider: b }] });
    expect((await chain.classify({}, {})).ok).toBe('b');
    // 2ª chamada: a está DORMINDO (não é nem tentado)
    expect((await chain.classify({}, {})).ok).toBe('b');
    expect(aCalls).toBe(1);   // só a 1ª vez — sem martelar
    expect(bCalls).toBe(2);
    expect(chain.status()[0].cooling).toBe(true);
  });

  test('TODOS sem cota → llm_quota_exhausted_all (Observer segura a msg)', async () => {
    const a = mk('a', async () => { throw quotaErr(); });
    const b = mk('b', async () => { throw quotaErr(); });
    const chain = new QuotaChainProvider({ links: [{ provider: a }, { provider: b }] });
    await expect(chain.classify({}, {})).rejects.toThrow('llm_quota_exhausted_all');
    // e agora os dois dormem → chamada seguinte falha DIRETO sem tentar ninguém
    await expect(chain.classify({}, {})).rejects.toThrow('llm_quota_exhausted_all');
  });

  test('erro transitório NÃO dorme o provedor; propaga se todos falharem', async () => {
    let aCalls = 0;
    const a = mk('a', async () => { aCalls++; throw new Error('fetch failed (ECONNRESET)'); });
    const b = mk('b', async () => ({ ok: 'b' }));
    const chain = new QuotaChainProvider({ links: [{ provider: a }, { provider: b }] });
    expect((await chain.classify({}, {})).ok).toBe('b');
    expect((await chain.classify({}, {})).ok).toBe('b');
    expect(aCalls).toBe(2); // transitório → continua tentando o 1º (sem cooldown)
    expect(chain.status()[0].cooling).toBe(false);
  });

  test('provedor acorda depois do reset', async () => {
    let now = Date.now();
    const a = mk('a', (() => { let first = true; return async () => { if (first) { first = false; throw quotaErr(); } return { ok: 'a' }; }; })());
    const b = mk('b', async () => ({ ok: 'b' }));
    const chain = new QuotaChainProvider({ links: [{ provider: a, resetAt: (t) => t + 1000 }, { provider: b }], now: () => now });
    expect((await chain.classify({}, {})).ok).toBe('b');   // a caiu por cota, dorme 1s
    now += 2000;                                             // "passa" do reset
    expect((await chain.classify({}, {})).ok).toBe('a');   // a acordou e voltou a ser o 1º
  });

  test('nextGeminiResetMs → sempre no futuro, no máx. ~24h', () => {
    const t = Date.now();
    const r = nextGeminiResetMs(t);
    expect(r).toBeGreaterThan(t);
    expect(r - t).toBeLessThanOrEqual(24.2 * 3600 * 1000);
  });
});
