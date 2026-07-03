'use strict';
/**
 * HEALTHFARE V3 — QuotaChainProvider (Bruno 07-03: "opções 1,2,3,4,5 e vai
 * trocando conforme a conta chega no limite").
 *
 * Corrente de provedores GRÁTIS com rotação automática por cota:
 *   - Tenta na ordem. Erro de COTA (429/quota/RESOURCE_EXHAUSTED) → aquele
 *     provedor DORME até o horário de reset dele (Gemini: 3:00 AM ET =
 *     meia-noite Pacífico; OpenRouter: meia-noite UTC) e a chamada segue
 *     pro próximo. Nada de martelar 429 o dia todo.
 *   - Erro transitório (timeout/5xx) → tenta o próximo NESTA chamada
 *     (sem dormir o provedor).
 *   - TODOS sem cota → lança 'llm_quota_exhausted_all': o Observer segura a
 *     mensagem (NÃO conta tentativa, NÃO dead-letter) e ela processa sozinha
 *     depois do reset.
 */
const { LLMProvider } = require('../LLMProvider');

const QUOTA_RE = /\b429\b|quota|RESOURCE_EXHAUSTED|rate.?limit/i;

/** Próximo 3:00 AM em America/New_York (reset do free tier do Gemini = meia-noite Pacífico). */
function nextGeminiResetMs(nowMs) {
  const nyNow = new Date(new Date(nowMs).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const target = new Date(nyNow);
  target.setHours(3, 5, 0, 0); // 3:05 — margem sobre o reset
  if (nyNow >= target) target.setDate(target.getDate() + 1);
  return nowMs + (target.getTime() - nyNow.getTime());
}

/** Próxima meia-noite UTC (reset diário do OpenRouter). */
function nextUtcMidnightMs(nowMs) {
  const d = new Date(nowMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5, 0);
  return next;
}

class QuotaChainProvider extends LLMProvider {
  /** @param {{links: Array<{provider, resetAt?: (nowMs)=>number}>, now?}} opts */
  constructor(opts = {}) {
    super();
    if (!opts.links || !opts.links.length) throw new Error('QuotaChainProvider: links obrigatórios');
    this.links = opts.links.map((l) => ({ provider: l.provider, resetAt: l.resetAt || nextGeminiResetMs, cooldownUntil: 0 }));
    this._now = opts.now || Date.now;
  }

  get name() { return 'chain(' + this.links.map((l) => l.provider.name || l.provider.model || '?').join('→') + ')'; }

  /** estado da corrente (telemetria/health) */
  status() {
    const t = this._now();
    return this.links.map((l) => ({
      provider: l.provider.name || l.provider.model || '?',
      cooling: l.cooldownUntil > t,
      wakes_at: l.cooldownUntil > t ? new Date(l.cooldownUntil).toISOString() : null,
    }));
  }

  async _run(method, args) {
    const t = this._now();
    let lastErr = null;
    let sawNonQuota = false;
    let tried = 0;
    for (const link of this.links) {
      if (link.cooldownUntil > t) continue; // dormindo até o reset da cota
      tried++;
      try {
        return await link.provider[method](...args);
      } catch (err) {
        lastErr = err;
        const label = link.provider.name || link.provider.model || '?';
        if (QUOTA_RE.test(String(err && err.message || err))) {
          link.cooldownUntil = link.resetAt(this._now());
          console.error(`[chain] ${label} SEM COTA → dorme até ${new Date(link.cooldownUntil).toISOString()} · próximo da corrente`);
        } else {
          sawNonQuota = true;
          console.error(`[chain] ${label} erro transitório (${String(err && err.message).slice(0, 120)}) → próximo da corrente`);
        }
      }
    }
    if (!sawNonQuota) {
      // ou tudo dormindo (tried=0), ou tudo que tentou caiu por cota
      const e = new Error('llm_quota_exhausted_all');
      e.cause = lastErr || null;
      throw e;
    }
    throw lastErr;
  }

  async classify(message, context) { return this._run('classify', [message, context]); }
  async classifyRaw(systemPrompt, userContent, opts) { return this._run('classifyRaw', [systemPrompt, userContent, opts]); }
}

module.exports = { QuotaChainProvider, nextGeminiResetMs, nextUtcMidnightMs };
