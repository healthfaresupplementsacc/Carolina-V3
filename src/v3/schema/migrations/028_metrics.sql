-- ============================================================
-- HEALTHFARE V3 — Migration 028: suporte ao dashboard de métricas
-- ============================================================
-- ADITIVO. Bloco final / Fase 5.
--  1. v3.events_enriched (MATERIALIZED VIEW) — events + joins + duração,
--     dow, hora, data EDT pré-computados. Refresh CONCURRENTLY (precisa do
--     índice único em id). Refresh a cada 10min (cron no wire.js).
--  2. v3.task_targets — target de minutos por slug (seed da Fase 2, método
--     híbrido; owner/manager sobrescreve pela UI).
-- Idempotente. DOWN: 028_metrics.down.sql
-- ============================================================
BEGIN;

CREATE MATERIALIZED VIEW IF NOT EXISTS v3.events_enriched AS
  SELECT e.id, e.person_id, e.activity_type_id, e.product_batch_id,
         e.started_at, e.ended_at, e.is_long_running, e.orders_printed,
         e.cowork_with, e.closed_reason, e.source,
         p.display_name AS person_name, p.role AS person_role,
         at.slug, at.display_name AS task_name, at.category,
         pb.batch_number, pr.canonical_name AS product_name, pb.product_id,
         EXTRACT(EPOCH FROM (COALESCE(e.ended_at, NOW()) - e.started_at)) / 60.0 AS duration_min,
         EXTRACT(DOW  FROM e.started_at AT TIME ZONE 'America/New_York')::int AS day_of_week,
         EXTRACT(HOUR FROM e.started_at AT TIME ZONE 'America/New_York')::int AS hour_of_day,
         (e.started_at AT TIME ZONE 'America/New_York')::date AS date_edt
  FROM v3.events e
  JOIN v3.persons p ON p.id = e.person_id
  LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
  LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
  LEFT JOIN v3.products pr ON pr.id = pb.product_id
  WHERE e.deleted_at IS NULL;

-- índice único obrigatório p/ REFRESH ... CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_ee_id ON v3.events_enriched(id);
CREATE INDEX IF NOT EXISTS idx_ee_person_date ON v3.events_enriched(person_id, date_edt);
CREATE INDEX IF NOT EXISTS idx_ee_slug ON v3.events_enriched(slug);
CREATE INDEX IF NOT EXISTS idx_ee_started ON v3.events_enriched(started_at);

CREATE OR REPLACE FUNCTION v3.refresh_events_enriched() RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY v3.events_enriched;
EXCEPTION WHEN OTHERS THEN
  -- 1º refresh ou ausência de dados: faz refresh normal (não-concurrent)
  REFRESH MATERIALIZED VIEW v3.events_enriched;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS v3.task_targets (
  id                  BIGSERIAL PRIMARY KEY,
  slug                VARCHAR(50) NOT NULL UNIQUE,
  target_minutes      INT NOT NULL,
  method_applied      VARCHAR(20),
  applied_by_admin_id BIGINT REFERENCES v3.admin_users(id),
  applied_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes               TEXT
);

COMMIT;
