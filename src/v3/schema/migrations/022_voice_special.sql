-- ============================================================
-- HEALTHFARE V3 — Migration 022: voice recordings + orders_printed + special_task
-- ============================================================
-- ADITIVO. Fase 0 bloco-zerar.
--  1. events.orders_printed (qtd de ordens; só order_printing*)
--  2. activity_types: 'special_task' (catch-all grupo Outros)
--  3. voice_recordings: audio em BYTEA (sem volume de app persistente —
--     durável no Postgres; transcript sempre salvo).
-- Idempotente. DOWN: 022_voice_special.down.sql
-- ============================================================
BEGIN;

ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS orders_printed INT;

INSERT INTO v3.activity_types (slug, display_name, category, requires_product, emoji, active, flow, is_background)
VALUES ('special_task', 'Especial / Outros', 'support', false, '✨', true, 'support', false)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS v3.voice_recordings (
  id                     BIGSERIAL PRIMARY KEY,
  event_id               BIGINT REFERENCES v3.events(id) ON DELETE SET NULL,
  note_id                BIGINT REFERENCES v3.op_notes(id) ON DELETE SET NULL,
  person_id              INT NOT NULL REFERENCES v3.persons(id),
  audio_bytes            BYTEA NOT NULL,
  audio_mime             VARCHAR(50),
  audio_duration_seconds INT,
  audio_size_bytes       INT,
  transcript             TEXT,
  transcript_language    VARCHAR(10),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_voice_event ON v3.voice_recordings(event_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_voice_person ON v3.voice_recordings(person_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE v3.voice_recordings IS
  'Notas de voz da Operator Page. Audio em bytea (sem volume de app); transcript Web Speech. Fase 0 bloco-zerar (13/jun).';

COMMIT;
