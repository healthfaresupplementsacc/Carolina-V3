'use strict';
// HEALTHFARE V3 — FIX C — testes do token-bucket rate limiter.
const { RateLimiter, TokenBucket } = require('../v3/llm/RateLimiter');
const AnthropicProvider = require('../v3/llm/providers/AnthropicProvider');

/** Relógio falso: sleep() avança o tempo → buckets refilam de forma determinística. */
function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
    advance: (ms) => { t += ms; },
  };
}

describe('V3 FIX C — TokenBucket', () => {
  test('começa cheio e refila linearmente', () => {
    const clk = fakeClock();
    const b = new TokenBucket(60, 1, clk.now); // 60 cap, 1/seg
    b.consume(60);
    expect(b.msUntil(1)).toBe(1000); // 1 token a 1/seg = 1s
    clk.advance(5000);
    expect(b.msUntil(1)).toBe(0);    // 5s → 5 tokens disponíveis
  });

  test('refill respeita a capacidade (não passa do teto)', () => {
    const clk = fakeClock();
    const b = new TokenBucket(10, 1, clk.now);
    clk.advance(60000); // 60s → +60, mas teto é 10
    expect(b.msUntil(10)).toBe(0);
    b.consume(10);
    expect(b.msUntil(1)).toBe(1000);
  });
});

describe('V3 FIX C — RateLimiter', () => {
  test('dentro da capacidade → zero espera', async () => {
    const clk = fakeClock();
    const rl = new RateLimiter({ reqPerMin: 60, tokPerMin: 60000, now: clk.now, sleep: clk.sleep });
    for (let i = 0; i < 60; i++) await rl.acquire(100);
    expect(rl.totalWaitMs).toBe(0);
    expect(rl.totalAcquired).toBe(60);
  });

  test('estourar o limite de REQUESTS força espera', async () => {
    const clk = fakeClock();
    const rl = new RateLimiter({ reqPerMin: 60, tokPerMin: 1e9, now: clk.now, sleep: clk.sleep });
    for (let i = 0; i < 60; i++) await rl.acquire(1); // esgota o req-bucket
    await rl.acquire(1);                              // 61ª → espera ~1s
    expect(rl.totalWaitMs).toBeGreaterThanOrEqual(1000);
  });

  test('estourar o limite de TOKENS força espera', async () => {
    const clk = fakeClock();
    const rl = new RateLimiter({ reqPerMin: 1e9, tokPerMin: 6000, now: clk.now, sleep: clk.sleep });
    await rl.acquire(6000); // esgota o tok-bucket
    await rl.acquire(6000); // espera ~60s p/ refilar
    expect(rl.totalWaitMs).toBeGreaterThanOrEqual(60000);
  });

  test('estTokens maior que a capacidade é limitado ao teto (não trava)', async () => {
    const clk = fakeClock();
    const rl = new RateLimiter({ reqPerMin: 1e9, tokPerMin: 6000, now: clk.now, sleep: clk.sleep });
    await rl.acquire(999999); // capado em 6000 — resolve, não pendura
    expect(rl.totalAcquired).toBe(1);
  });

  test('acquire concorrente é serializado — saldo nunca consumido em dobro', async () => {
    const clk = fakeClock();
    const rl = new RateLimiter({ reqPerMin: 60, tokPerMin: 1e9, now: clk.now, sleep: clk.sleep });
    // 120 acquires em paralelo: 60 instantâneos, 60 esperando refill.
    await Promise.all(Array.from({ length: 120 }, () => rl.acquire(1)));
    expect(rl.totalAcquired).toBe(120);
    expect(rl.totalWaitMs).toBeGreaterThan(0); // a 2ª metade esperou
  });
});

describe('V3 FIX C — AnthropicProvider passa pelo limiter', () => {
  const fakeClient = (text) => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  });

  test('classifyRaw chama rateLimiter.acquire antes da API', async () => {
    const acquire = jest.fn().mockResolvedValue();
    const ap = new AnthropicProvider({
      client: fakeClient('{"ok":true}'),
      rateLimiter: { acquire },
    });
    await ap.classifyRaw('SYS', 'USER');
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls[0][0]).toBeGreaterThan(0); // estimativa de tokens
  });

  test('rateLimiter: null desliga o gate (sem espera nos testes)', async () => {
    const ap = new AnthropicProvider({ client: fakeClient('{"ok":true}'), rateLimiter: null });
    const r = await ap.classifyRaw('SYS', 'USER');
    expect(r.json_parsed).toEqual({ ok: true });
  });
});
