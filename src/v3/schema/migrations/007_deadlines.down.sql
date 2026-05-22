-- ============================================================
-- HEALTHFARE V3 — Migration 007 DOWN: remove deadlines
-- ============================================================
BEGIN;
DROP TABLE IF EXISTS v3.deadlines;
COMMIT;
