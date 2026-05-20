'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.1 — MockProvider
 *
 * Provider falso pros testes. Decisão configurável; registra as
 * chamadas; pode simular erro de API (testar retry do Observer).
 * Implementa classify() E classifyRaw().
 */
const { LLMProvider, normalizeResult, normalizeRaw } = require('../LLMProvider');

class MockProvider extends LLMProvider {
  /**
   * @param {object} opts
   * @param {object} [opts.result]     ClassificationResult parcial (classify)
   * @param {object} [opts.rawResult]  RawResult parcial (classifyRaw)
   * @param {Error|string} [opts.error]  se setado, ambos lançam
   */
  constructor(opts = {}) {
    super();
    this._result = opts.result || null;
    this._rawResult = opts.rawResult || null;
    this._error = opts.error || null;
    this._delayMs = opts.delayMs || 0; // simula LLM lento (testa claim)
    this.calls = [];
    this.rawCalls = [];
  }

  get name() { return 'mock'; }

  async classify(message, context) {
    this.calls.push({ message, context });
    if (this._delayMs) await new Promise((r) => setTimeout(r, this._delayMs));
    this._throwIfError();
    return normalizeResult(Object.assign({ provider_used: 'mock', model_used: 'mock' }, this._result || {}), 'mock');
  }

  async classifyRaw(systemPrompt, userContent, opts) {
    this.rawCalls.push({ systemPrompt, userContent, opts });
    this._throwIfError();
    return normalizeRaw(Object.assign({ provider_used: 'mock', model_used: 'mock' }, this._rawResult || {}), 'mock');
  }

  _throwIfError() {
    if (this._error) {
      throw (this._error instanceof Error ? this._error : new Error(String(this._error)));
    }
  }

  /** Configura a decisão que o próximo classify() retorna. */
  setResult(result) { this._result = result; this._error = null; }

  /** Configura o RawResult que o próximo classifyRaw() retorna. */
  setRawResult(rawResult) { this._rawResult = rawResult; this._error = null; }

  /** Faz classify()/classifyRaw() lançarem. */
  setError(error) { this._error = error; }

  /** Atraso artificial no classify() — simula LLM lento (testa o claim). */
  setDelay(ms) { this._delayMs = ms; }
}

module.exports = MockProvider;
