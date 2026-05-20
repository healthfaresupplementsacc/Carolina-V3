-- ============================================================
-- HEALTHFARE V3 — Migration 002: audit_log.actor_type + 'app_home'
-- ============================================================
-- Sprint 1 — hotfix FLAG 1.
-- O §2.4 (EventService) e o §6.x preveem 'app_home' como origem
-- de mutação distinta (operador agindo pelo App Home, ≠ admin no
-- dashboard). O CHECK original (001) só aceitava 4 valores.
--
-- Incremental porque 001 já rodou em prod. Constraint real:
-- audit_log_actor_type_check (descoberto via pg_constraint).
--
-- Transação única. DOWN: 002_actor_type_app_home.down.sql.
-- ============================================================

BEGIN;

ALTER TABLE v3.audit_log DROP CONSTRAINT audit_log_actor_type_check;
ALTER TABLE v3.audit_log ADD CONSTRAINT audit_log_actor_type_check
  CHECK (actor_type IN ('admin', 'llm_observer', 'llm_assistant', 'system', 'app_home'));

COMMIT;
