'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.1 — OpenAIProvider (STUB)
 *
 * Fallback futuro (GPT-4o) p/ comparação de qualidade / resiliência
 * se Anthropic estiver indisponível. NÃO implementado no Sprint 1 —
 * classify() lança not_implemented. A interface existe pra fábrica
 * getProvider('openai') resolver sem quebrar.
 */
const { LLMProvider } = require('../LLMProvider');

class OpenAIProvider extends LLMProvider {
  get name() { return 'openai'; }

  async classify(message, context) { // eslint-disable-line no-unused-vars
    throw new Error('not_implemented: OpenAIProvider é stub no Sprint 1');
  }

  async classifyRaw(systemPrompt, userContent, opts) { // eslint-disable-line no-unused-vars
    throw new Error('not_implemented: OpenAIProvider é stub no Sprint 1');
  }
}

module.exports = OpenAIProvider;
