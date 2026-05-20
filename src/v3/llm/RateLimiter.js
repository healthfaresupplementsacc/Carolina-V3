'use strict';
/**
 * HEALTHFARE V3 — FIX C — token-bucket rate limiter.
 *
 * O backfill §2.13 levou 18 erros 429 (rate limit) porque o Observer
 * disparava chamadas à Messages API sem throttle, competindo com a
 * Carolina legada que divide a MESMA org Anthropic.
 *
 * Gate ANTES de cada chamada à API. Dois buckets independentes:
 *   - requests: ~50/min   (≈60-70% do limite da org — headroom p/ a legada)
 *   - tokens:   ~30k/min
 * Uma chamada espera ATÉ os DOIS buckets terem saldo.
 *
 * Buckets refilam continuamente (não em "janelas"): saldo cresce
 * linearmente com o tempo decorrido. `now`/`sleep` injetáveis p/
 * testes determinísticos.
 */

/** Bucket que refila linearmente até `capacity`. */
class TokenBucket {
  constructor(capacity, refillPerSec, now) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this._now = now || Date.now;
    this.tokens = capacity;       // começa cheio
    this.last = this._now();
  }

  _refill() {
    const now = this._now();
    const elapsedSec = (now - this.last) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.last = now;
    }
  }

  /** ms a esperar até haver `n` tokens (0 = já tem saldo). */
  msUntil(n) {
    this._refill();
    if (this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) / this.refillPerSec) * 1000);
  }

  consume(n) {
    this._refill();
    this.tokens -= n;
  }
}

class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} [opts.reqPerMin=50]
   * @param {number} [opts.tokPerMin=30000]
   * @param {function} [opts.now]    () => epoch ms (testes)
   * @param {function} [opts.sleep]  (ms) => Promise (testes)
   */
  constructor(opts = {}) {
    const reqPerMin = opts.reqPerMin || 50;
    const tokPerMin = opts.tokPerMin || 30000;
    this._now = opts.now || Date.now;
    this._sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.reqBucket = new TokenBucket(reqPerMin, reqPerMin / 60, this._now);
    this.tokBucket = new TokenBucket(tokPerMin, tokPerMin / 60, this._now);
    this._chain = Promise.resolve(); // mutex: serializa o gate
    this.totalWaitMs = 0;            // observabilidade
    this.totalAcquired = 0;
  }

  /**
   * Bloqueia até os dois buckets terem saldo p/ 1 request + estTokens.
   * O gate é serializado (mutex) — chamadas concorrentes esperam em
   * fila, então o saldo nunca é consumido em dobro.
   * @param {number} estTokens estimativa de tokens da chamada
   */
  async acquire(estTokens) {
    // estTokens nunca pode exceder a capacidade do bucket (senão
    // msUntil jamais zeraria) — limita ao teto.
    const want = Math.min(Math.max(1, Math.ceil(estTokens || 1)), this.tokBucket.capacity);
    const prev = this._chain;
    let release;
    this._chain = new Promise((r) => { release = r; });
    await prev;
    try {
      for (;;) {
        const wait = Math.max(this.reqBucket.msUntil(1), this.tokBucket.msUntil(want));
        if (wait <= 0) break;
        this.totalWaitMs += wait;
        await this._sleep(wait);
      }
      this.reqBucket.consume(1);
      this.tokBucket.consume(want);
      this.totalAcquired += 1;
    } finally {
      release();
    }
  }

  stats() {
    return { totalAcquired: this.totalAcquired, totalWaitMs: this.totalWaitMs };
  }
}

// Singleton compartilhado por todo o processo — todas as chamadas à
// Messages API do V3 passam pelo MESMO limiter.
let _shared = null;
function getSharedLimiter() {
  if (!_shared) {
    _shared = new RateLimiter({
      reqPerMin: process.env.V3_RATE_REQ_PER_MIN ? parseInt(process.env.V3_RATE_REQ_PER_MIN, 10) : 50,
      tokPerMin: process.env.V3_RATE_TOK_PER_MIN ? parseInt(process.env.V3_RATE_TOK_PER_MIN, 10) : 30000,
    });
  }
  return _shared;
}

module.exports = { RateLimiter, TokenBucket, getSharedLimiter };
