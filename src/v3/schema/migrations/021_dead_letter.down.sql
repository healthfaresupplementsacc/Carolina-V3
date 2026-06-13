-- DOWN da 021 — remove colunas/índices de dead-letter.
BEGIN;
DROP INDEX IF EXISTS v3.idx_messages_processing;
DROP INDEX IF EXISTS v3.idx_messages_dead_lettered;
ALTER TABLE v3.messages DROP COLUMN IF EXISTS dead_lettered_at;
ALTER TABLE v3.messages DROP COLUMN IF EXISTS last_attempt_at;
ALTER TABLE v3.messages DROP COLUMN IF EXISTS last_error;
ALTER TABLE v3.messages DROP COLUMN IF EXISTS processing_attempts;
COMMIT;
