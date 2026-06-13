-- ============================================================
-- HEALTHFARE V3 — Migration 026: schedule por operador por dia da semana
-- ============================================================
-- ADITIVO. Bloco final / Fase 3. Base pro checkout cascade (Fase 4) e
-- aderência (Fase 5). day_of_week: 0=Dom..6=Sáb (igual EXTRACT(DOW)).
-- expected_*_time NULL ou is_workday=false = dia de folga.
-- Idempotente. DOWN: 026_operator_schedules.down.sql
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS v3.operator_schedules (
  id                  BIGSERIAL PRIMARY KEY,
  person_id           INT NOT NULL REFERENCES v3.persons(id),
  day_of_week         INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  expected_start_time TIME,
  expected_end_time   TIME,
  is_workday          BOOLEAN NOT NULL DEFAULT true,
  notes               TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_admin_id BIGINT REFERENCES v3.admin_users(id),
  UNIQUE (person_id, day_of_week)
);
CREATE INDEX IF NOT EXISTS idx_schedules_person ON v3.operator_schedules(person_id);

COMMIT;
