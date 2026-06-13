-- Reverte 028. Matview + função + task_targets (derivados/configuração).
DROP FUNCTION IF EXISTS v3.refresh_events_enriched();
DROP MATERIALIZED VIEW IF EXISTS v3.events_enriched;
DROP TABLE IF EXISTS v3.task_targets;
