-- ============================================================
-- HEALTHFARE V3 — Migration 005 DOWN: volta pra is_ordered
-- ============================================================
BEGIN;

ALTER TABLE v3.flows DROP COLUMN IF EXISTS mode;
ALTER TABLE v3.flows ADD COLUMN IF NOT EXISTS is_ordered BOOLEAN NOT NULL DEFAULT false;
UPDATE v3.flows SET is_ordered = true WHERE slug IN ('production', 'pnp');

COMMIT;
