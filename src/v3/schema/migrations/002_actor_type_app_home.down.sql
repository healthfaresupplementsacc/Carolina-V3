-- ============================================================
-- HEALTHFARE V3 — Migration 002 DOWN — reverte 'app_home'
-- ============================================================
-- Volta o CHECK de v3.audit_log.actor_type aos 4 valores originais.
-- ATENÇÃO: só roda limpo se não houver rows com actor_type
-- ='app_home' (o CHECK falharia na validação). Transação única.
-- ============================================================

BEGIN;

ALTER TABLE v3.audit_log DROP CONSTRAINT audit_log_actor_type_check;
ALTER TABLE v3.audit_log ADD CONSTRAINT audit_log_actor_type_check
  CHECK (actor_type IN ('admin', 'llm_observer', 'llm_assistant', 'system'));

COMMIT;
