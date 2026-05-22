-- ============================================================
-- HEALTHFARE V3 — Migration 006 DOWN: remove metas
-- ============================================================
BEGIN;

ALTER TABLE v3.production_counts DROP COLUMN IF EXISTS possible_duplicate_of;
ALTER TABLE v3.production_counts DROP COLUMN IF EXISTS unit;
DROP TABLE IF EXISTS v3.production_goals;

COMMIT;
