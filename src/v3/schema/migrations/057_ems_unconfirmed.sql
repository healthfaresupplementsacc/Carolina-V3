-- 057 — EMS auto-tasks são SEMPRE suspeitas (Bruno 07-18).
-- Rastreia toda task auto-criada pelo EMS que precisa de confirmação humana:
-- "foi você ou fulano?" (adjacência) ou "fulano está trabalhando hoje?" (presença).
-- O gatilho: pessoa que só fez background de formulação e NÃO fez check-in manual.
-- Enquanto UNCONFIRMED, a pessoa NÃO conta como presente (handoff/idle/ausência).

CREATE TABLE IF NOT EXISTS v3.ems_unconfirmed (
  id             SERIAL PRIMARY KEY,
  event_id       BIGINT NOT NULL,              -- o v3.events auto-criado (ems_auto)
  subject_person_id INT NOT NULL,              -- a quem o EMS atribuiu (o "suspeito")
  ems_key        TEXT,
  batch_number   TEXT,
  product_name   TEXT,
  stage          TEXT,
  slug           TEXT,
  since          TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- quando a task nasceu
  -- estado: 'pending' (aguardando 1h30/gatilho) → 'questionable' (pode perguntar) →
  --         'confirmed' (era ele) / 'reassigned' (era outro) / 'dismissed'
  status         TEXT NOT NULL DEFAULT 'pending',
  asked_count    INT NOT NULL DEFAULT 0,       -- quantas vezes já perguntamos
  last_asked_at  TIMESTAMPTZ,
  resolved_by_person_id INT,                   -- quem respondeu
  resolved_answer TEXT,                        -- 'me' | 'subject' | 'not_working' | 'other'
  resolved_at    TIMESTAMPTZ,
  skipped_by     INT[] NOT NULL DEFAULT '{}',  -- pessoas que já disseram "não sei" hoje
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ems_unconfirmed_open
  ON v3.ems_unconfirmed (status) WHERE status IN ('pending','questionable');
CREATE INDEX IF NOT EXISTS idx_ems_unconfirmed_subject
  ON v3.ems_unconfirmed (subject_person_id, since DESC);
-- 1 registro por evento auto (idempotente com o worker)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ems_unconfirmed_event
  ON v3.ems_unconfirmed (event_id);
