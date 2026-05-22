-- ============================================================
-- HEALTHFARE V3 — Migration 006: metas (esperado vs realizado)
-- ============================================================
-- Bloco 2. O ESPERADO (meta do Henrique de manhã) e o reforço do
-- REALIZADO (production_counts).
--
-- - v3.production_goals: a meta. 1 linha por (lote, produto).
-- - production_counts.unit: bottle | box | uncertain (handoff §7.6).
-- - production_counts.possible_duplicate_of: anti-duplicação — quando
--   o mesmo número reaparece pro mesmo produto/lote, a nova contagem
--   aponta pra existente; o cálculo do realizado soma só as não-marcadas.
--
-- Incremental. Transação única. DOWN: 006_goals.down.sql.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS v3.production_goals (
  id                   SERIAL PRIMARY KEY,
  product_id           INTEGER REFERENCES v3.products(id),
  batch_number         TEXT,
  expected_quantity    INTEGER NOT NULL CHECK (expected_quantity >= 0),
  unit                 TEXT NOT NULL DEFAULT 'bottle'
                         CHECK (unit IN ('bottle', 'box', 'uncertain')),
  destinations         JSONB,
  production_date      DATE NOT NULL,
  source               TEXT NOT NULL DEFAULT 'channel'
                         CHECK (source IN ('channel', 'dashboard')),
  source_message_ts    TEXT,
  created_by_person_id INTEGER REFERENCES v3.persons(id),
  confidence           TEXT NOT NULL DEFAULT 'high'
                         CHECK (confidence IN ('high', 'medium', 'low', 'unconfirmed')),
  notes                TEXT,
  superseded_by        INTEGER REFERENCES v3.production_goals(id),
  deleted_at           TIMESTAMPTZ,
  deleted_by           INTEGER REFERENCES v3.persons(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_goals_date ON v3.production_goals(production_date);
CREATE INDEX IF NOT EXISTS idx_goals_product_batch
  ON v3.production_goals(product_id, batch_number);

COMMENT ON TABLE v3.production_goals IS
  'V3 metas (esperado). INSERT/UPDATE via GoalService. 1 linha por (lote,produto).';

ALTER TABLE v3.production_counts ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'bottle'
  CHECK (unit IN ('bottle', 'box', 'uncertain'));
ALTER TABLE v3.production_counts ADD COLUMN IF NOT EXISTS possible_duplicate_of
  INTEGER REFERENCES v3.production_counts(id);

COMMENT ON COLUMN v3.production_counts.possible_duplicate_of IS
  'Anti-duplicação §7.6: aponta pra contagem viva com o MESMO valor no '
  'mesmo produto/lote. NULL = não suspeita. O realizado soma só NULL.';

COMMIT;
