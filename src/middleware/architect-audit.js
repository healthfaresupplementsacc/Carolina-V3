'use strict';
/**
 * HEALTHFARE V3 — Architect API: audit de TODA chamada (inclusive 401/403/429).
 *
 * Grava em v3.audit_log:
 *   action   = 'architect_api_access'
 *   metadata = { actor, endpoint, query_params, response_status, latency_ms, ip }
 *
 * NOTA actor_type: a migration 018 ampliou o CHECK
 * audit_log_actor_type_check (+operator_page, +admin_via_slack,
 * +dedupe_worker). Mapeamos:
 *   scope architect      → actor_type 'admin'
 *   scope operator_page  → actor_type 'operator_page'
 *   não autenticado      → actor_type 'system'
 * O ator REAL vai sempre em metadata.actor.
 *
 * Fire-and-forget: falha de audit NUNCA derruba a resposta (loga no console).
 * Este middleware vem ANTES do auth na cadeia pra capturar 401 também.
 */

function makeArchitectAudit({ db, now = Date.now } = {}) {
  return function architectAudit(req, res, next) {
    const t0 = now();
    res.on('finish', () => {
      const scope = req.architectScope || 'unauthenticated';
      const actorType = scope === 'architect' ? 'admin'
        : scope === 'operator_page' ? 'operator_page' : 'system';
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
