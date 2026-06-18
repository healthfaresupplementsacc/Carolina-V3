-- 036: Passada 2 — fim-do-dia (daily_totals_log) + gap detection (activity_gaps).
BEGIN;
-- totais do dia confirmados por um operador (1 registro por dia)
CREATE TABLE IF NOT EXISTS v3.daily_totals_log (
  id            SERIAL PRIMARY KEY,
  day           DATE NOT NULL UNIQUE,
  person_id     INT REFERENCES v3.persons(id),
  totals_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  general_note  TEXT,
  completed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- gaps de atividade (>20min sem registro) justificados pelo operador
CREATE TABLE IF NOT EXISTS v3.activity_gaps (
  id                 SERIAL PRIMARY KEY,
  person_id          INT NOT NULL REFERENCES v3.persons(id),
  previous_event_id  INT,
  next_event_id      INT,
  gap_started_at     TIMESTAMPTZ NOT NULL,
  gap_ended_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gap_minutes        INT NOT NULL,
  justification_type TEXT,
  justification_note TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_gaps_person_day ON v3.activity_gaps(person_id, created_at);
COMMIT;
