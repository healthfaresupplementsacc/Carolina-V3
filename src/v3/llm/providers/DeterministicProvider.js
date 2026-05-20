'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.1 — DeterministicProvider (STUB)
 *
 * Modo de emergência: regra determinística (regex do parser legado +
 * best-effort), custo zero, sem LLM. Fica INATIVO por padrão — nunca
 * é fallback automático (V3 §3.9). NÃO implementado no Sprint 1 —
 * classify() lança not_implemented.
 */
const { LLMProvider } = require('../LLMProvider');

class DeterministicProvider extends LLMProvider {
  get name() { return 'deterministic'; }

  async classify(message, context) { // eslint-disable-line no-unused-vars
    throw new Error('not_implemented: DeterministicProvider é stub no Sprint 1');
  }
}

module.exports = DeterministicProvider;
