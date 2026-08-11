'use strict';
/**
 * HEALTHFARE V3 — auth da API de dados (na BORDA).
 *
 * Um único middleware protege todo o /api/v3/data/*. Agora valida o PIN contra
 * v3.app_logins (RBAC — Bruno 08-03): cada login = uma identidade + role + funções.
 * Fallback de EMERGÊNCIA: o ADMIN_PIN env (default 510510) continua valendo se o
 * banco estiver indisponível, pra nunca trancar o Bruno pra fora.
 *
 * resolveLogin(db, pin) → { id, name, role, functions[] } | null
 */

// cache curto (10s) pra não bater no banco a cada request do dashboard
const _cache = new Map(); // pin -> { at, login }

async function resolveLogin(db, pin) {
  const p = String(pin == null ? '' : pin).trim();
  if (!p) return null;
  const hit = _cache.get(p);
  if (hit && Date.now() - hit.at < 10000) return hit.login;
  let login = null;
  try {
    const r = await db.query(
      `SELECT l.id, l.name, r.key AS role, r.rank,
              COALESCE(array_agg(rf.function_key) FILTER (WHERE rf.function_key IS NOT NULL), '{}') AS functions
         FROM v3.app_logins l
         JOIN v3.app_roles r ON r.id = l.role_id
         LEFT JOIN v3.role_functions rf ON rf.role_id = r.id
        WHERE l.active AND l.pin = $1
        GROUP BY l.id, r.key, r.rank
        LIMIT 1`, [p]);
    if (r.rows[0]) {
      login = { id: r.rows[0].id, name: r.rows[0].name, role: r.rows[0].role, rank: r.rows[0].rank, functions: r.rows[0].functions || [] };
    }
  } catch (_) { login = null; }
  // fallback de emergência: ADMIN_PIN env (default 510510) → admin de emergência
  if (!login) {
    const emergency = String(process.env.ADMIN_PIN || '510510');
    if (p === emergency) login = { id: 0, name: 'Admin (emergência)', role: 'admin', rank: 100, functions: ['*'] };
  }
  _cache.set(p, { at: Date.now(), login });
  return login;
}

function hasFunction(login, fn) {
  if (!login) return false;
  if (login.functions && login.functions.includes('*')) return true;
  return !!login.functions && login.functions.includes(fn);
}

/**
 * Middleware Express: valida o PIN (query ?pin= ou header x-admin-pin) contra
 * app_logins. Anexa req.login = { name, role, functions }. 401 se inválido.
 * @param {object} opts  opts.db (pool pg). Sem db → cai no fallback env.
 */
function makeAuthMiddleware(opts = {}) {
  const db = opts.db || null;
  const envPin = String((opts && opts.pin) || process.env.ADMIN_PIN || '510510');
  return async function requireAuth(req, res, next) {
    const provided = (req.query && req.query.pin) || (req.headers && req.headers['x-admin-pin']);
    let login = null;
    if (db) { try { login = await resolveLogin(db, provided); } catch (_) { login = null; } }
    if (!login) {
      // sem db ou não achou → fallback env (compat + emergência)
      if (String(provided == null ? '' : provided) === envPin) {
        login = { id: 0, name: 'Admin', role: 'admin', rank: 100, functions: ['*'] };
      }
    }
    if (!login) return res.status(401).json({ error: { code: 'unauthorized', message: 'PIN inválido ou ausente.' } });
    req.login = login;
    return next();
  };
}

module.exports = { makeAuthMiddleware, resolveLogin, hasFunction };
