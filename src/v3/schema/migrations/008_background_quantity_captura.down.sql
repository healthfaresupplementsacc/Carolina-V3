-- HEALTHFARE V3 — DOWN da migration 008.
-- Reverte as colunas e settings adicionados. Eventos com quantity
-- preenchido perdem o dado (esperado num rollback).

BEGIN;

ALTER TABLE v3.events DROP COLUMN IF EXISTS quantity;
ALTER TABLE v3.events DROP COLUMN IF EXISTS quantity_unit;
ALTER TABLE v3.activity_types DROP COLUMN IF EXISTS is_background;
ALTER TABLE v3.activity_types DROP COLUMN IF EXISTS expected_seconds;

DELETE FROM v3.settings WHERE key IN (
  'meta_pauses_foreground',
  'break_assumed_seconds',
  'expedient_end_hour_ny',
  'captura_aprimorada_cutover_date'
);

COMMIT;
