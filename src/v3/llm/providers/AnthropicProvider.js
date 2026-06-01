'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.1 — AnthropicProvider
 *
 * Provider default de produção. Modelo Sonnet 4.6 (claude-sonnet-4-6),
 * editável via setting `llm_model`. NÃO usa Haiku (descartado).
 *
 * Dois métodos:
 *   classifyRaw(systemPrompt, userContent) → RawResult (JSON cru)
 *   classify(message, context)            → ClassificationResult
 * classify() é uma fina camada sobre classifyRaw() + mapeamento.
 */
const { LLMProvider } = require('../LLMProvider');
const { getSharedLimiter } = require('../RateLimiter');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { /* SDK ausente — métodos lançam erro claro */ }

// Sonnet 4.6 — preço USD por 1M tokens. Bloco 1/jun Fase 1: prompt
// caching adiciona cache_write (1.25x input) e cache_read (0.1x = 90% off).
const PRICING = {
  input: 3.0,           // normal input
  cache_write: 3.75,    // input com cache_control marcado (1.25x)
  cache_read: 0.30,     // input lido de cache anterior (0.1x = 90% off)
  output: 15.0,
};
const DEFAULT_MODEL = 'claude-sonnet-4-6';

class AnthropicProvider extends LLMProvider {
  constructor(opts = {}) {
    super();
    this.model = opts.model || DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens || 1500;
    // client injetável (testes passam um fake). timeout 60s: uma
    // classify deve levar <30s — sem isso o SDK espera 10min default
    // e uma chamada lenta trava o worker (descoberto no FIX F).
    this._client = opts.client
      || (Anthropic ? new Anthropic({
        apiKey: opts.apiKey || process.env.ANTHROPIC_API_KEY,
        timeout: opts.timeout || 60000,
      }) : null);
    // FIX C — rate limiter: gate antes de cada chamada à Messages API.
    // `null` explícito desliga (testes); undefined → singleton da org.
    this._rateLimiter = opts.rateLimiter !== undefined ? opts.rateLimiter : getSharedLimiter();
  }

  get name() { return 'anthropic'; }

  /** Estima tokens da chamada (input ≈ chars/4 + saída pedida).
   *  Aceita system como string OU array de blocks (cache mode). */
  _estimateTokens(system, userContent, maxTokens) {
    let sysChars = 0;
    if (Array.isArray(system)) {
      for (const b of system) sysChars += (b && b.text ? String(b.text).length : 0);
    } else {
      sysChars = String(system || '').length;
    }
    const inChars = sysChars + String(userContent || '').length;
    return Math.ceil(inChars / 4) + (maxTokens || this.maxTokens);
  }

  /** Chamada crua à Messages API. @returns {{text,tin,tout,ms,cache_creation,cache_read}} */
  async _call(system, userContent, maxTokens) {
    if (!this._client) {
      throw new Error('AnthropicProvider: @anthropic-ai/sdk indisponível ou sem client');
    }
    // FIX C — espera o rate limiter liberar (429-proofing).
    if (this._rateLimiter) {
      await this._rateLimiter.acquire(this._estimateTokens(system, userContent, maxTokens));
    }
    const t0 = Date.now();
    // Bloco 1/jun Fase 1 — SDK Anthropic aceita system como string OU array
    // de blocos. Quando array com cache_control, ativa prompt caching
    // automaticamente (beta na conta — SDK recente já trata).
    const resp = await this._client.messages.create({
      model: this.model,
      max_tokens: maxTokens || this.maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }],
    });
    const ms = Date.now() - t0;
    const text = ((resp && resp.content) || [])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('');
    const usage = (resp && resp.usage) || {};
    return {
      text,
      tin: usage.input_tokens || 0,
      tout: usage.output_tokens || 0,
      cache_creation: usage.cache_creation_input_tokens || 0,
      cache_read: usage.cache_read_input_tokens || 0,
      ms,
    };
  }

  /** Custo USD considerando cache write/read. */
  _cost(tin, tout, cacheCreation, cacheRead) {
    return +(
      (tin / 1e6) * PRICING.input
      + ((cacheCreation || 0) / 1e6) * PRICING.cache_write
      + ((cacheRead || 0) / 1e6) * PRICING.cache_read
      + (tout / 1e6) * PRICING.output
    ).toFixed(6);
  }

  /** Pergunta focada — devolve o JSON parseado cru (RawResult). */
  async classifyRaw(systemPrompt, userContent, opts = {}) {
    const r = await this._call(systemPrompt, userContent, opts.maxTokens);
    const isCacheMode = Array.isArray(systemPrompt);
    return {
      json_parsed: this._parseJsonOrNull(r.text),
      raw_text: r.text,
      provider_used: 'anthropic',
      model_used: this.model,
      tokens_in: r.tin,
      tokens_out: r.tout,
      cache_creation_input_tokens: r.cache_creation,
      cache_read_input_tokens: r.cache_read,
      cache_enabled: isCacheMode,
      cost_estimate_usd: this._cost(r.tin, r.tout, r.cache_creation, r.cache_read),
      processing_ms: r.ms,
    };
  }

  /** Classificação do Observer — ClassificationResult. */
  async classify(message, context = {}) {
    const { system, userContent } = this._assemblePrompt(message, context);
    const raw = await this.classifyRaw(system, userContent);
    const parsed = raw.json_parsed || {
      _parse_error: true, confidence_overall: 'unconfirmed', actions: [],
      interpretation: '(resposta do LLM não-JSON)',
    };
    return {
      interpretation: parsed.interpretation || '',
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      categorization: parsed.categorization || null,
      confidence: parsed.confidence_overall || parsed.confidence || 'unconfirmed',
      react_emoji: parsed.react_emoji || null,
      admin_question: parsed.admin_question || null,
      new_vocabulary_terms: Array.isArray(parsed.new_vocabulary_terms) ? parsed.new_vocabulary_terms : [],
      provider_used: 'anthropic',
      model_used: this.model,
      tokens_in: raw.tokens_in,
      tokens_out: raw.tokens_out,
      cache_creation_input_tokens: raw.cache_creation_input_tokens || 0,
      cache_read_input_tokens: raw.cache_read_input_tokens || 0,
      cache_enabled: raw.cache_enabled || false,
      cost_estimate_usd: raw.cost_estimate_usd,
      processing_ms: raw.processing_ms,
      raw_response: raw.raw_text,
    };
  }

  /** Extrai o 1º objeto JSON do texto. Garbage → null. */
  _parseJsonOrNull(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { /* tenta extrair bloco */ }
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) { /* sem JSON válido */ } }
    return null;
  }

  /**
   * Usa o prompt rico do prompt-builder (PARTE 2.7) se vier no context;
   * senão monta um fallback mínimo.
   */
  _assemblePrompt(message, context) {
    if (context && context.systemPrompt && context.userContent) {
      return { system: context.systemPrompt, userContent: context.userContent };
    }
    const system = 'Você é o observador de uma linha de produção de suplementos da HealthFare. '
      + 'Leia a mensagem do time e responda SOMENTE com um JSON: '
      + '{"interpretation":string,"actions":[],"categorization":string,'
      + '"confidence_overall":"high|medium|low|unconfirmed",'
      + '"react_emoji":string|null,"admin_question":string|null,'
      + '"new_vocabulary_terms":[]}. '
      + 'Nunca invente person_id/product_id. Em dúvida, confidence baixa + admin_question.';
    const userContent = 'Mensagem do time:\n' + ((message && message.text) || '');
    return { system, userContent };
  }
}

module.exports = AnthropicProvider;
