'use strict';
/**
 * HEALTHFARE V3 — Bloco 0 — auth da API de dados (na BORDA).
 *
 * Um único middleware protege todo o /api/v3/data/*. Hoje valida o
 * PIN admin (query ?pin= ou header x-admin-pin), igual ao resto do
 * V3. Estruturado pra trocar por token/JWT depois SEM tocar o
 * cérebro nem os repos — só este arquivo muda (Bloco 6 / auth real).
 */

/**
 * @param {object} opts  opts.pin (default ADMIN_PIN env, fallback 510510)
 * @returns {function} middleware Express (req,res,next)
 */
function makeAuthMiddleware(opts = {}) {
  const expected = String((opts && opts.pin) || process.env.ADMIN_PIN || '510510');
  return function requireAuth(req, res, next) {
    const provided = (req.query && req.query.pin)
      || (req.headers && req.headers['x-admin-pin']);
    if (String(provided == null ? '' : provided) === expected) return next();
    return res.status(401).json({
      error: { code: 'unauthorized', message: 'PIN inválido ou ausente.' },
    });
  };
}

module.exports = { makeAuthMiddleware };
