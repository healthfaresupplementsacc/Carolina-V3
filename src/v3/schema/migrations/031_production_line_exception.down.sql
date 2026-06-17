-- Reverte 031. Remove as colunas de exceção (sem contagem) dos events.
DROP INDEX IF EXISTS v3.idx_events_exception;
ALTER TABLE v3.events DROP COLUMN IF EXISTS exception_reason;
ALTER TABLE v3.events DROP COLUMN IF EXISTS exception_no_count;
