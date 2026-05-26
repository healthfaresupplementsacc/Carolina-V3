-- DOWN da migration 011 — remove is_long_running e o índice parcial.
BEGIN;
DROP INDEX IF EXISTS v3.idx_events_long_running;
ALTER TABLE v3.events DROP COLUMN IF EXISTS is_long_running;
COMMIT;
