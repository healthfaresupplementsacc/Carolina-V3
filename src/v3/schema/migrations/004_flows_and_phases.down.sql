-- ============================================================
-- HEALTHFARE V3 — Migration 004 DOWN: remove fluxos e fases
-- ============================================================
BEGIN;

ALTER TABLE v3.events DROP COLUMN IF EXISTS flow_override;
ALTER TABLE v3.activity_types DROP COLUMN IF EXISTS phase_order;
ALTER TABLE v3.activity_types DROP COLUMN IF EXISTS flow;

ALTER TABLE v3.activity_types DROP CONSTRAINT activity_types_category_check;
ALTER TABLE v3.activity_types ADD CONSTRAINT activity_types_category_check
  CHECK (category IN ('production_phase', 'support', 'meta'));

DROP TABLE IF EXISTS v3.flows;

COMMIT;
