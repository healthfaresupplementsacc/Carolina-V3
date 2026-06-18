-- Reverte 033. Remove as colunas de cowork multi-finish.
DROP INDEX IF EXISTS v3.idx_events_cowork;
ALTER TABLE v3.events DROP COLUMN IF EXISTS cowork_is_last_finisher;
ALTER TABLE v3.events DROP COLUMN IF EXISTS cowork_member_finished_at;
ALTER TABLE v3.events DROP COLUMN IF EXISTS cowork_group_id;
