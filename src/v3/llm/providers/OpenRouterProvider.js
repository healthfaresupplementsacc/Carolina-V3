'use strict';
/**
 * HEALTHFARE V3 — OpenRouterProvider (degrau 4 da corrente grátis).
 *
 * Modelos `:free` do OpenRouter (50 req/dia sem crédito; 1000/dia com $10
 * comprados uma vez; 20 req/min; reset diário à meia-noite UTC). Só entra na
 * corrente quando OPENROUTER_API_KEY existir no env — zero risco sem a chave.
 *
 * Herda do GeminiProvider e troca SÓ a camada HTTP (_call): o parse de JSON,
 * classify/classifyRaw e shapes de retorno são idênticos.
 */
const GeminiProvider = require('./GeminiProvider');

const DEFAULT_OR_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';

class OpenRouterProvider extends GeminiProvider {
  constructor(opts = {}) {
    super(opts);
    this.model = opts.model || process.env.OPENROUTER_MODEL || DEFAULT_OR_MODEL;
    this.apiKey = opts.apiKey || process.env.OPENROUTER_API_KEY;
    this.baseUrl = opts.baseUrl || 'https://openrouter.ai/api/v1';
    this.tier = 'free';
  }

  get name() { return 'openrouter(' + this.model + ')'; }

  /** Chamada crua — OpenAI-compatible chat/completions. */
  async _call(system, userContent, maxTokens) {
    if (!this.apiKey) throw new Error('OpenRouterProvider: OPENROUTER_API_KEY ausente');
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp;
    try {
      resp = await this._fetch(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.apiKey,
          'HTTP-Referer': 'https://productionlineservice-production.up.railway.app',
          'X-Title': 'HealthFare Tracker',
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          max_tokens: maxTokens || this.maxTokens,
          messages: [
            { role: 'system', content: this._flattenSystem(system) },
            { role: 'user', content: String(userContent || '') },
          ],
        }),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    const ms = Date.now() - t0;
    if (!resp.ok) {
      let detail = '';
      try { const j = await resp.json(); detail = (j.error && j.error.message) || ''; } catch (_) {}
      const e = new Error(`OpenRouter HTTP ${resp.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
      e.status = resp.status;
      throw e;
    }
    const j = await resp.json();
    const choice = (j.choices && j.choices[0]) || {};
    const text = (choice.message && choice.message.content) || '';
    const usage = j.usage || {};
    return {
      text,
      tin: usage.prompt_tokens || 0,
      tout: usage.completion_tokens || 0,
      ms,
      finish: choice.finish_reason || null,
    };
  }

  _cost() { return 0; } // :free

  async classifyRaw(systemPrompt, userContent, opts = {}) {
    const r = await super.classifyRaw(systemPrompt, userContent, opts);
    r.provider_used = 'openrouter';
    return r;
  }

  async classify(message, context = {}) {
    const r = await super.classify(message, context);
    r.provider_used = 'openrouter';
    return r;
  }
}

module.exports = OpenRouterProvider;
