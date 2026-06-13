BEGIN;
DROP TABLE IF EXISTS v3.voice_recordings;
DELETE FROM v3.activity_types WHERE slug='special_task';
ALTER TABLE v3.events DROP COLUMN IF EXISTS orders_printed;
COMMIT;
