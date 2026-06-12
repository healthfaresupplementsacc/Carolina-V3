'use strict';
/**
 * HEALTHFARE V3 — Architect API: autenticação por Bearer token + escopo.
 *
 * 2 tokens (env vars):
 *   ARCHITECT_API_TOKEN  → scope 'architect'  (bypass total, sem rate-limit)
 *   OPERATOR_PAGE_TOKEN  → scope 'operator_page' (rate-limit 60/min/IP,
 *                          só endpoints [OP], com filtros de campo)
 *
 * Header: Authorization: Bearer <token>
 * Token ausente/inválido → 401. Scope insuficiente → 403 (requireScope).
 * Tokens não configurados no env NUNCA autenticam (string vazia não vale).
 */

/** Extrai o bearer token do header Authorization. null se ausente/malformado. */
function extractBearer(req) {
  const h = (req.headers && req.headers.authorization) || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/**
 * Middleware de autenticação. Seta req.architectScope =
 * 'architect' | 'operator_page' e segue, ou responde 401.
 */
function makeArchitectAuth({ architectToken, operatorToken } = {}) {
  return function architectAuth(req, res, next) {
    const token = extractBearer(req);
    if (!token) {
      return res.status(401).json({ error: 'missing_token', detail: 'Authorization: Bearer <token> obrigatório' });
    }
    if (architectToken && token === architectToken) {
      req.architectScope = 'architect';
      return next();
    }
    if (operatorToken && token === operatorToken) {
      req.architectScope = 'operator_page';
      return next();
    }
    return res.status(401).json({ error: 'invalid_token' });
  };
}

/** Middleware: rota só pros scopes listados; senão 403. */
function requireScope(...scopes) {
  return function scopeCheck(req, res, next) {
    if (scopes.includes(req.architectScope)) return next();
    return res.status(403).json({ error: 'forbidden_for_scope', scope: req.architectScope || null });
  };
}

/**
 * Rate-limit em memória por IP — APLICA SÓ ao scope 'operator_page'
 * (architect bypassa). Janela fixa de 60s, default 60 req.
 * In-process (1 instância no Railway — suficiente; não persiste restart).
 */
function makeRateLimiter({ limit = 60, windowMs = 60 * 1000, now = Date.now } = {}) {
  const hits = new Map(); // ip -> { count, windowStart }
  return function rateLimiter(req, res, next) {
    if (req.architectScope !== 'operator_page') return next();
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const t = now();
    let entry = hits.get(ip);
    if (!entry || t - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: t };
      hits.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      res.set('Retry-After', String(Math.ceil((entry.windowStart + windowMs - t) / 1000)));
      return res.status(429).json({ error: 'rate_limited', limit, window_s: windowMs / 1000 });
    }
    // limpeza lazy: mantém o Map pequeno
    if (hits.size > 1000) {
      for (const [k, v] of hits) { if (t - v.windowStart >= windowMs) hits.delete(k); }
    }
    return next();
  };
}

module.exports = { makeArchitectAuth, requireScope, makeRateLimiter, extractBearer };
