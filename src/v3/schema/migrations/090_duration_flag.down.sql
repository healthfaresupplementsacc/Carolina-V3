DROP INDEX IF EXISTS v3.idx_events_duration_flag_open;
ALTER TABLE v3.events DROP COLUMN IF EXISTS duration_flag_fixed_at;
ALTER TABLE v3.events DROP COLUMN IF EXISTS duration_flag_fixed_by;
ALTER TABLE v3.events DROP COLUMN IF EXISTS duration_flag_note;
ALTER TABLE v3.events DROP COLUMN IF EXISTS duration_flag_at;
ALTER TABLE v3.events DROP COLUMN IF EXISTS duration_flag_status;
ALTER TABLE v3.events DROP COLUMN IF EXISTS duration_flag;
