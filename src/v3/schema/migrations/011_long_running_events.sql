-- ============================================================
-- HEALTHFARE V3 — Migration 011: is_long_running em v3.events
-- ============================================================
-- 100% ADITIVO. Adiciona flag pra eventos que rodam por MÚLTIPLOS DIAS
-- (formulações Potassium / Chromium / etc) — esses NÃO podem ser fechados
-- pelo safetyAutoClose no EOD (21h NY). Default false preserva comportamento
-- antigo pra todo evento existente.
--
-- Caso real: Potassium (Bruno) tem formulação rodando 25→26→27/mai e o
-- safetyAutoClose ia fechá-lo às 21:00. Bruno autorizou na resp do
-- "PARTE 7 — write 5" (26/mai): "deixa os eventos do Potassium como
-- estão, NÃO auto-fecha eles à noite".
--
-- Uso:
--   - Admin/Carolina marca evento manualmente como long-running quando
--     identificar (ex.: produto cadastrado como multi-dia)
--   - safetyAutoClose pula AND e.is_long_running = false
--   - EventService.markLongRunning(eventId, true|false, by_person_id)
--     muta + audita
--
-- DOWN: drop column.
-- ============================================================

BEGIN;

ALTER TABLE v3.events
  ADD COLUMN IF NOT EXISTS is_long_running BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN v3.events.is_long_running IS
  'true = evento multi-dia (formulação Potassium/Chromium etc). '
  'safetyAutoClose NÃO fecha eventos com is_long_running=true. '
  'Marca via EventService.markLongRunning, auditada. Default false '
  'preserva comportamento padrão pra eventos normais.';

CREATE INDEX IF NOT EXISTS idx_events_long_running
  ON v3.events (is_long_running) WHERE is_long_running = true;

COMMIT;
