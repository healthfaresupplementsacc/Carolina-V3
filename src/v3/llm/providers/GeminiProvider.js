'use strict';
/**
 * HEALTHFARE V3 — GeminiProvider (Google Gemini Flash).
 *
 * Mesma interface do AnthropicProvider (classify/classifyRaw). Implementado
 * via REST oficial (generativelanguage.googleapis.com) com fetch nativo —
 * o SDK @google/generative-ai não pôde ser instalado (npm da máquina
 * quebrado); a REST API é equivalente e zero-dependência.
 *
 * - Modelo: env GEMINI_MODEL (default 'gemini-2.5-flash').
 * - system: aceita string OU array de blocks (modo cache do Anthropic) —
 *   flatten pro systemInstruction. Gemini 2.5 tem implicit caching
 *   automático (sem marcação manual).
 * - responseMimeType: application/json → saída JSON estrita (o pipeline
 *   inteiro do Observer espera JSON).
 * - Rate gate interno: free tier ≈ 15 RPM → janela 60s / max 14 calls.
 * - Custo: env GEMINI_TIER=free (default, $0) | paid (Flash ~$0.30/M in,
 *   $2.50/M out — registrado em llm_metrics se pago).
 */
const { LLMProvider } = require('../LLMProvider');

const DEFAULT_MODEL = 'gemini-2.5-flash';
const PRICING_PAID = { input: 0.30, output: 2.50 }; // USD/M tokens (Flash)
const RPM_LIMIT = 14;          // margem sob o teto de 15 RPM do free tier
const RPM_WINDOW_MS = 60 * 1000;

class GeminiProvider extends LLMProvider {
  constructor(opts = {}) {
    super();
    this.model = opts.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
    this.apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
    this.maxTokens = opts.maxTokens || 2048;
    this.timeoutMs = opts.timeout || 60000;
    this.tier = opts.tier || process.env.GEMINI_TIER || 'free';
    this.baseUrl = opts.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    this._fetch = opts.fetch || ((...a) => fetch(...a)); // injetável (testes)
    this._now = opts.now || Date.now;
    this._callTimes = []; // rate gate in-process
  }

  get name() { return 'gemini'; }

  /** Junta system (string ou array de blocks Anthropic) num texto só. */
  _flattenSystem(system) {
    if (Array.isArray(system)) {
      return system.map((b) => (b && b.text) ? String(b.text) : '').filter(Boolean).join('\n\n');
    }
    return String(system || '');
  }

  /** Gate simples: respeita o RPM do free tier esperando a janela abrir. */
  async _rateGate() {
    for (;;) {
      const t = this._now();
      this._callTimes = this._callTimes.filter((x) => t - x < RPM_WINDOW_MS);
      if (this._callTimes.length < RPM_LIMIT) { this._callTimes.push(t); return; }
      const waitMs = RPM_WINDOW_MS - (t - this._callTimes[0]) + 50;
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 100)));
    }
  }

  _cost(tin, tout) {
    if (this.tier === 'free') return 0;
    return +(((tin / 1e6) * PRICING_PAID.input + (tout / 1e6) * PRICING_PAID.output).toFixed(6));
  }

  /** Chamada crua ao generateContent. */
  async _call(system, userContent, maxTokens) {
    if (!this.apiKey) throw new Error('GeminiProvider: GEMINI_API_KEY ausente');
    await this._rateGate();
    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;
    const body = {
      systemInstruction: { parts: [{ text: this._flattenSystem(system) }] },
      contents: [{ role: 'user', parts: [{ text: String(userContent || '') }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: maxTokens || this.maxTokens,
        responseMimeType: 'application/json',
      },
    };
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp;
    try {
      resp = await this._fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    const ms = Date.now() - t0;
    if (!resp.ok) {
      let detail = '';
      try { const j = await resp.json(); detail = (j.error && j.error.message) || ''; } catch (_) {}
      const e = new Error(`Gemini HTTP ${resp.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
      e.status = resp.status;
      throw e;
    }
    const j = await resp.json();
    const cand = (j.candidates && j.candidates[0]) || {};
    const text = ((cand.content && cand.content.parts) || [])
      .map((p) => p.text || '').join('');
    const usage = j.usageMetadata || {};
    return {
      text,
      tin: usage.promptTokenCount || 0,
      tout: usage.candidatesTokenCount || 0,
      ms,
      finish: cand.finishReason || null,
    };
  }

  _parseJsonOrNull(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { /* tenta extrair bloco */ }
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) { /* sem JSON */ } }
    return null;
  }

  /** Pergunta focada — RawResult (mesmo shape do AnthropicProvider). */
  async classifyRaw(systemPrompt, userContent, opts = {}) {
    const r = await this._call(systemPrompt, userContent, opts.maxTokens);
    return {
      json_parsed: this._parseJsonOrNull(r.text),
      raw_text: r.text,
      provider_used: 'gemini',
      model_used: this.model,
      tokens_in: r.tin,
      tokens_out: r.tout,
      cache_creation_input_tokens: 0,   // implicit caching do Gemini não é exposto igual
      cache_read_input_tokens: 0,
      cache_enabled: false,
      cost_estimate_usd: this._cost(r.tin, r.tout),
      processing_ms: r.ms,
    };
  }

  /** Classificação do Observer — ClassificationResult. */
  async classify(message, context = {}) {
    const system = (context && context.systemPrompt)
      || ('Você é o observador de uma linha de produção de suplementos. Responda SOMENTE JSON: '
        + '{"interpretation":string,"actions":[],"categorization":string,'
        + '"confidence_overall":"high|medium|low|unconfirmed","react_emoji":null,'
        + '"admin_question":null,"new_vocabulary_terms":[]}');
    const userContent = (context && context.userContent)
      || ('Mensagem do time:\n' + ((message && message.text) || ''));
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
      uncertain: parsed.uncertain === true,
      uncertainty_reason: parsed.uncertainty_reason || null,
      provider_used: 'gemini',
      model_used: this.model,
      tokens_in: raw.tokens_in,
      tokens_out: raw.tokens_out,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_enabled: false,
      cost_estimate_usd: raw.cost_estimate_usd,
      processing_ms: raw.processing_ms,
      raw_response: raw.raw_text,
    };
  }
}

module.exports = GeminiProvider;
