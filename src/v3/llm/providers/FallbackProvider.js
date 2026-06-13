'use strict';
/**
 * HEALTHFARE V3 — FallbackProvider: primário com fallback automático.
 *
 * Política (pivot 12/jun — Gemini primary, Anthropic fallback):
 *   - Tenta o PRIMÁRIO. Erro → registra falha e tenta o FALLBACK na
 *     MESMA chamada (a msg não espera).
 *   - 3+ falhas do primário na janela de 5min → curto-circuito: vai
 *     DIRETO pro fallback (sem nem tentar o primário) até a janela
 *     esvaziar.
 *   - Sucesso do primário zera o contador.
 *   - provider_used no resultado reflete quem REALMENTE respondeu
 *     (telemetria llm_metrics mostra a verdade).
 */
const { LLMProvider } = require('../LLMProvider');

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

class FallbackProvider extends LLMProvider {
  /** @param {{primary, fallback, threshold?, windowMs?, now?}} opts */
  constructor(opts = {}) {
    super();
    if (!opts.primary || !opts.fallback) throw new Error('FallbackProvider: primary e fallback obrigatórios');
    this.primary = opts.primary;
    this.fallback = opts.fallback;
    this.threshold = opts.threshold || DEFAULT_THRESHOLD;
    this.windowMs = opts.windowMs || DEFAULT_WINDOW_MS;
    this._now = opts.now || Date.now;
    this._failures = []; // timestamps de falhas do primário
  }

  get name() { return `fallback(${this.primary.name}->${this.fallback.name})`; }

  _recentFailures() {
    const t = this._now();
    this._failures = this._failures.filter((x) => t - x < this.windowMs);
    return this._failures.length;
  }

  _recordFailure(err) {
    this._failures.push(this._now());
    console.error(`[FallbackProvider] primário ${this.primary.name} falhou (${this._recentFailures()}/${this.threshold} na janela): ${err && err.message}`);
  }

  async _run(method, args) {
    if (this._recentFailures() >= this.threshold) {
      console.error(`[FallbackProvider] curto-circuito → ${this.fallback.name} (primário ${this.primary.name} com ${this._recentFailures()} falhas/5min)`);
      return this.fallback[method](...args);
    }
    try {
      const r = await this.primary[method](...args);
      this._failures = []; // sucesso limpa a janela
      return r;
    } catch (err) {
      this._recordFailure(err);
      return this.fallback[method](...args);
    }
  }

  async classify(message, context) { return this._run('classify', [message, context]); }
  async classifyRaw(systemPrompt, userContent, opts) { return this._run('classifyRaw', [systemPrompt, userContent, opts]); }
}

module.exports = FallbackProvider;
