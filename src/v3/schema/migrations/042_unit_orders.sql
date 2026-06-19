-- 042: FASE 5 — permite unit='orders' em production_counts (contagem de P&P).
BEGIN;
ALTER TABLE v3.production_counts DROP CONSTRAINT IF EXISTS production_counts_unit_check;
ALTER TABLE v3.production_counts ADD CONSTRAINT production_counts_unit_check
  CHECK (unit = ANY (ARRAY['bottle'::text, 'box'::text, 'uncertain'::text, 'orders'::text]));
COMMIT;
