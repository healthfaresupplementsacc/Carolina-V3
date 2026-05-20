'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.1 — AnthropicProvider
 *
 * Provider default de produção. Modelo Sonnet 4.6 (claude-sonnet-4-6),
 * editável via setting `llm_model`. NÃO usa Haiku (descartado).
 *
 * classify(message, context) monta o prompt, chama a Messages API,
 * extrai o JSON estruturado e devolve um ClassificationResult.
 *
 * O prompt rico (contexto dinâmico) é montado pelo prompt-builder
 * (PARTE 2.7) e chega via context.systemPrompt / context.userContent.
 * Se ausente, este provider monta um prompt mínimo de fallback —
 * funcional e testável de forma independente.
 */
const { LLMProvider } = require('../LLMProvider');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { /* SDK ausente — classify lança erro claro */ }

// Sonnet 4.6 — preço USD por 1M tokens.
const PRICING = { input: 3.0, output: 15.0 };
const DEFAULT_MODEL = 'claude-sonnet-4-6';

class AnthropicProvider extends LLMProvider {
  constructor(opts = {}) {
    super();
    this.model = opts.model || DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens || 1500;
    // client injetável (testes passam um fake)
    this._client = opts.client
      || (Anthropic ? new Anthropic({ apiKey: opts.apiKey || process.env.ANTHROPIC_API_KEY }) : null);
  }

  get name() { return 'anthropic'; }

  async classify(message, context = {}) {
    if (!this._client) {
      throw new Error('AnthropicProvider: @anthropic-ai/sdk indisponível ou sem client');
    }
    const t0 = Date.now();
    const { system, userContent } = this._assemblePrompt(message, context);

    const resp = await this._client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }],
    });

    const ms = Date.now() - t0;
    const text = ((resp && resp.content) || [])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('');
    const parsed = this._parseJson(text);
    const tin = (resp && resp.usage && resp.usage.input_tokens) || 0;
    const tout = (resp && resp.usage && resp.usage.output_tokens) || 0;

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
      tokens_in: tin,
      tokens_out: tout,
      cost_estimate_usd: +((tin / 1e6) * PRICING.input + (tout / 1e6) * PRICING.output).toFixed(6),
      processing_ms: ms,
      raw_response: text,
    };
  }

  /** Extrai o primeiro objeto JSON do texto. Garbage → unconfirmed. */
  _parseJson(text) {
    if (text) {
      try { return JSON.parse(text); } catch (_) { /* tenta extrair bloco */ }
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch (_) { /* cai no fallback */ } }
    }
    return {
      _parse_error: true,
      interpretation: '(resposta do LLM não-JSON)',
      actions: [],
      confidence_overall: 'unconfirmed',
    };
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
