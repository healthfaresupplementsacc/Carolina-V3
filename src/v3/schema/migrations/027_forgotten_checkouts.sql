-- ============================================================
-- HEALTHFARE V3 — Migration 027: forgotten checkouts (cascade)
-- ============================================================
-- ADITIVO. Bloco final / Fase 4. Quando um operador loga/desloga, o
-- sistema detecta colegas que passaram do horário esperado (schedule) e
-- seguem logados/ociosos. Se confirmado esquecimento, fecha as tasks no
-- last_activity, agenda DM da Carolina pro dia seguinte e avisa o admin.
-- Idempotente. DOWN: 027_forgotten_checkouts.down.sql
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS v3.forgotten_checkouts (
  id                        BIGSERIAL PRIMARY KEY,
  person_id                 INT NOT NULL REFERENCES v3.persons(id),
  discovered_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  discovered_by_person_id   INT REFERENCES v3.persons(id),
  discovered_via            VARCHAR(20) CHECK (discovered_via IN ('login', 'logout')),
  last_activity_at          TIMESTAMPTZ,
  last_task_description     TEXT,
  expected_end_time         TIME,
  auto_logout_at            TIMESTAMPTZ,
  notification_sent_at      TIMESTAMPTZ,
  carolina_dm_scheduled_for TIMESTAMPTZ,
  carolina_dm_sent_at       TIMESTAMPTZ,
  admin_alert_sent_at       TIMESTAMPTZ,
  resolved_at               TIMESTAMPTZ,
  resolution                VARCHAR(50)
);
CREATE INDEX IF NOT EXISTS idx_forgotten_person ON v3.forgotten_checkouts(person_id);
CREATE INDEX IF NOT EXISTS idx_forgotten_pending_dm
  ON v3.forgotten_checkouts(carolina_dm_scheduled_for) WHERE carolina_dm_sent_at IS NULL;

COMMIT;
