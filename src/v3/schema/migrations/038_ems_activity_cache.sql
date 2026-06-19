-- 038: FASE 2 — espelho local da atividade do EMS (fonte do "1 sistema só").
-- O worker ems-activity-sync puxa /line + /pipeline e faz UPSERT aqui; o dashboard
-- lê DAQUI (não do EMS direto). Guarda TODOS os campos, registro permanente.
BEGIN;
CREATE TABLE IF NOT EXISTS v3.ems_activity_cache (
  id                 BIGSERIAL PRIMARY KEY,
  ems_key            TEXT NOT NULL UNIQUE,   -- estável: equipment_id:batch_id OU batch_id:stage
  process_type       TEXT,                   -- formulation, encapsulation, production_line, ...
  stage              TEXT,
  machine            TEXT,
  machine_type       TEXT,
  supplement_name    TEXT,
  batch_number       TEXT,
  formula_code       TEXT,
  employee_ems_name  TEXT,
  tracker_person_id  INT REFERENCES v3.persons(id),
  target_bottles     INT,
  actual_bottles     INT,
  product_image      TEXT,
  started_at         TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  duration_seconds   INT,
  raw_json           JSONB,
  sync_status        TEXT NOT NULL DEFAULT 'active',  -- active | completed | stale
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ems_cache_status ON v3.ems_activity_cache(sync_status, last_synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_ems_cache_person ON v3.ems_activity_cache(tracker_person_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ems_cache_started ON v3.ems_activity_cache(started_at DESC);
COMMIT;
