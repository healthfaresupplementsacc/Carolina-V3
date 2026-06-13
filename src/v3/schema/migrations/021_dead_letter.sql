-- ============================================================
-- HEALTHFARE V3 — Migration 021: dead-letter de retry (TODO #1)
-- ============================================================
-- ADITIVO. Antes: msg que falhava no LLM ficava com llm_processed_at
-- NULL e era re-claimada a cada ~2min PARA SEMPRE (~$20/dia por msg
-- envenenada). Agora: contador de tentativas; >= 3 -> dead-letter
-- (sai da fila, audit + notification + aviso admin).
-- Idempotente. DOWN: 021_dead_letter.down.sql
-- ============================================================
BEGIN;

ALTER TABLE v3.messages ADD COLUMN IF NOT EXISTS processing_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE v3.messages ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE v3.messages ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE v3.messages ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_dead_lettered
  ON v3.messages(dead_lettered_at) WHERE dead_lettered_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_processing
  ON v3.messages(processing_attempts)
  WHERE llm_processed_at IS NULL AND dead_lettered_at IS NULL;

COMMIT;
