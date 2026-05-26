-- DOWN da migration 010 — volta expedient_end_hour_ny pra 19.
-- expedient_start_hour_ny fica (aditivo, não atrapalha nada).
BEGIN;
UPDATE v3.settings SET value = '19'::jsonb, updated_at = NOW()
  WHERE key = 'expedient_end_hour_ny';
COMMIT;
