ALTER TABLE v3.operator_sessions DROP COLUMN IF EXISTS impersonated_by;
ALTER TABLE v3.persons DROP COLUMN IF EXISTS kiosk_prefs;
ALTER TABLE v3.persons DROP COLUMN IF EXISTS pin_plain;
