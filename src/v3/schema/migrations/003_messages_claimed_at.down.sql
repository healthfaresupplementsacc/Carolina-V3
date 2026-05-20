-- ============================================================
-- HEALTHFARE V3 — Migration 003 DOWN: remove v3.messages.claimed_at
-- ============================================================
BEGIN;

ALTER TABLE v3.messages DROP COLUMN IF EXISTS claimed_at;

COMMIT;
