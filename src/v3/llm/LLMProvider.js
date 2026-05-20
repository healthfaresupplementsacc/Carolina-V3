'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.1 — Provider Abstraction (V3 doc §3.9)
 *
 * Interface única "entenda essa mensagem". O LLM é a implementação
 * atual, não load-bearing arquiteturalmente: trocar de provider é
 * setting (`llm_provider`), não deploy.
 *
 * classify(message, context) -> ClassificationResult
 *
 * ClassificationResult:
 *   interpretation       string   — resumo do que a mensagem significa
 *   actions              Action[] — close_event/open_event/cowork_join/
 *                          cowork_leave/break_start/break_end/eod_count/
 *                          partial_count/note/narrative
 *   categorization       string|null
 *   confidence           'high'|'medium'|'low'|'unconfirmed'
 *   react_emoji          string|null
 *   admin_question       string|null
 *   new_vocabulary_terms string[]
 *   provider_used        string
 *   model_used           string|null
 *   tokens_in            number
 *   tokens_out           number
 *   cost_estimate_usd    number
 *   processing_ms        number
 *   raw_response         object|string|null  — debug
 *
 * Princípio #24: providers que leem/escrevem DB usam SEMPRE nomes
 * schema-qualificados v3.*.
 */

const ACTION_TYPES = [
  'close_event', 'open_event', 'cowork_join', 'cowork_leave',
  'break_start', 'break_end', 'eod_count', 'partial_count',
  'note', 'narrative',
];
const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'unconfirmed'];

/** Classe base — toda implementação concreta estende e sobrescreve. */
class LLMProvider {
  /** @returns {string} nome curto do provider */
  get name() { return 'base'; }

  /**
   * Classificação do Observer (mensagem → eventos).
   * @param {{text:string, ts?:string, slack_user_id?:string}} message
   * @param {object} context  contexto montado (prompt, persons, …)
   * @returns {Promise<object>} ClassificationResult
   */
  async classify(message, context) { // eslint-disable-line no-unused-vars
    throw new Error('LLMProvider.classify() não implementado — use uma subclasse');
  }

  /**
   * Pergunta focada genérica (NÃO-classificação): manda system+user,
   * devolve o JSON parseado cru. Usado por PersonResolver, stale
   * check (Sprint 2), Admin Assistant — qualquer caso que não é o
   * ClassificationResult do Observer.
   * @returns {Promise<object>} RawResult: { json_parsed, raw_text,
   *   provider_used, model_used, tokens_in, tokens_out,
   *   cost_estimate_usd, processing_ms }
   */
  async classifyRaw(systemPrompt, userContent, opts) { // eslint-disable-line no-unused-vars
    throw new Error('LLMProvider.classifyRaw() não implementado — use uma subclasse');
  }
}

/**
 * Garante o shape mínimo do ClassificationResult, sem inventar dados.
 */
function normalizeResult(partial = {}, providerName = 'unknown') {
  return {
    interpretation: partial.interpretation || '',
    actions: Array.isArray(partial.actions) ? partial.actions : [],
    categorization: partial.categorization || null,
    confidence: CONFIDENCE_LEVELS.includes(partial.confidence) ? partial.confidence : 'unconfirmed',
    react_emoji: partial.react_emoji || null,
    admin_question: partial.admin_question || null,
    new_vocabulary_terms: Array.isArray(partial.new_vocabulary_terms) ? partial.new_vocabulary_terms : [],
    provider_used: partial.provider_used || providerName,
    model_used: partial.model_used || null,
    tokens_in: partial.tokens_in || 0,
    tokens_out: partial.tokens_out || 0,
    cost_estimate_usd: partial.cost_estimate_usd || 0,
    processing_ms: partial.processing_ms || 0,
    raw_response: partial.raw_response !== undefined ? partial.raw_response : null,
  };
}

/** Garante o shape mínimo de um RawResult (classifyRaw). */
function normalizeRaw(partial = {}, providerName = 'unknown') {
  return {
    json_parsed: partial.json_parsed !== undefined ? partial.json_parsed : null,
    raw_text: partial.raw_text !== undefined ? partial.raw_text : null,
    provider_used: partial.provider_used || providerName,
    model_used: partial.model_used || null,
    tokens_in: partial.tokens_in || 0,
    tokens_out: partial.tokens_out || 0,
    cost_estimate_usd: partial.cost_estimate_usd || 0,
    processing_ms: partial.processing_ms || 0,
  };
}

/**
 * Fábrica de providers. Default 'anthropic'. require() lazy evita
 * ciclo (os providers estendem esta mesma classe).
 * @param {string} name  'anthropic'|'mock'|'openai'|'deterministic'
 */
function getProvider(name, opts = {}) {
  switch (String(name || 'anthropic').toLowerCase()) {
    case 'anthropic':     return new (require('./providers/AnthropicProvider'))(opts);
    case 'mock':          return new (require('./providers/MockProvider'))(opts);
    case 'openai':        return new (require('./providers/OpenAIProvider'))(opts);
    case 'deterministic': return new (require('./providers/DeterministicProvider'))(opts);
    default: throw new Error('provider LLM desconhecido: ' + name);
  }
}

module.exports = {
  LLMProvider, getProvider, normalizeResult, normalizeRaw, ACTION_TYPES, CONFIDENCE_LEVELS,
};
