'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.1 — MockProvider
 *
 * Provider falso pros testes. Decisão configurável; registra as
 * chamadas; pode simular erro de API (testar retry do Observer).
 */
const { LLMProvider, normalizeResult } = require('../LLMProvider');

class MockProvider extends LLMProvider {
  /**
   * @param {object} opts
   * @param {object} [opts.result]  ClassificationResult parcial a retornar
   * @param {Error|string} [opts.error]  se setado, classify() lança
   */
  constructor(opts = {}) {
    super();
    this._result = opts.result || null;
    this._error = opts.error || null;
    this.calls = [];
  }

  get name() { return 'mock'; }

  async classify(message, context) {
    this.calls.push({ message, context });
    if (this._error) {
      throw (this._error instanceof Error ? this._error : new Error(String(this._error)));
    }
    return normalizeResult(Object.assign({ provider_used: 'mock', model_used: 'mock' }, this._result || {}), 'mock');
  }

  /** Configura a decisão que o próximo classify() retorna. */
  setResult(result) { this._result = result; this._error = null; }

  /** Faz o próximo classify() lançar. */
  setError(error) { this._error = error; }
}

module.exports = MockProvider;
