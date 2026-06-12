'use strict';
/**
 * HEALTHFARE V3 — Architect API: audit de TODA chamada (inclusive 401/403/429).
 *
 * Grava em v3.audit_log:
 *   action   = 'architect_api_access'
 *   metadata = { actor, endpoint, query_params, response_status, latency_ms, ip }
 *
 * NOTA actor_type: o CHECK audit_log_actor_type_check só permite
 * ('admin','llm_observer','llm_assistant','system','app_home').
 * 'operator_page' VIOLARIA o CHECK (mesma armadilha do antigo
 * 'admin_via_slack' que falhava silencioso). Mapeamos:
 *   scope architect      → actor_type 'admin'
 *   scope operator_page  → actor_type 'system'
 *   não autenticado      → actor_type 'system'
 * O ator REAL vai sempre em metadata.actor. Ampliar o CHECK fica pra
 * migration futura (TODO no INTEGRATION_PLAN).
 *
 * Fire-and-forget: falha de audit NUNCA derruba a resposta (loga no console).
 * Este middleware vem ANTES do auth na cadeia pra capturar 401 também.
 */

function makeArchitectAudit({ db, now = Date.now } = {}) {
  return function architectAudit(req, res, next) {
    const t0 = now();
    res.on('finish', () => {
      const scope = req.architectScope || 'unauthenticated';
      const actorType = scope === 'architect' ? 'admin' : 'system';
      const ip = req.ip
        || (req.headers && req.headers['x-forwarded-for'])
        || (req.socket && req.socket.remoteAddress) || null;
      const metadata = {
        actor: scope,
        endpoint: (req.baseUrl || '') + (req.path || req.url || ''),
        query_params: req.query || {},
        response_status: res.statusCode,
        latency_ms: now() - t0,
        ip,
      };
      db.query(
        `INSERT INTO v3.audit_log
           (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
         VALUES ($1, NULL, 'architect_api_access', 'api', NULL, NULL, NULL, $2::jsonb)`,
        [actorType, JSON.stringify(metadata)]
      ).catch((e) => console.error('[architect-audit] falhou:', e.message));
    });
    next();
  };
}

module.exports = { makeArchitectAudit };
