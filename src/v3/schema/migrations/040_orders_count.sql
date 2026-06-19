-- 040: FASE 5 — contagem de ORDENS (P&P) em production_counts.
-- kind distingue bottles (linha) de orders (P&P/embalagem). marketplace opcional.
BEGIN;
ALTER TABLE v3.production_counts
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'bottles',
  ADD COLUMN IF NOT EXISTS marketplace TEXT;
CREATE INDEX IF NOT EXISTS idx_pc_kind ON v3.production_counts(kind, production_date);
COMMIT;
