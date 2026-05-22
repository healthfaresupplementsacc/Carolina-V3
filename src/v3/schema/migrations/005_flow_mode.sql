-- ============================================================
-- HEALTHFARE V3 — Migration 005: v3.flows.mode
-- ============================================================
-- Bloco 1 — correção pós-dry-run. O `is_ordered` (booleano, da 004)
-- não distingue os 3 comportamentos reais dos fluxos. Trocado por
-- `mode` (1 coluna, 3 valores):
--
--   production → 'ordered'  esteira; mede fase a fase, por lote;
--                           pré-requisito soft (avisa se pular fase)
--   pnp        → 'block'     bloco único do dia; SOMA os sub-passos
--                           (tempo total · nº pacotes · tempo/pacote)
--   support    → 'loose'     atividades avulsas; cada ocorrência separada
--
-- `is_ordered` não tinha consumidor — drop limpo. Incremental.
-- Transação única. DOWN: 005_flow_mode.down.sql.
-- ============================================================

BEGIN;

ALTER TABLE v3.flows DROP COLUMN IF EXISTS is_ordered;
ALTER TABLE v3.flows ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'loose'
  CHECK (mode IN ('ordered', 'block', 'loose'));

UPDATE v3.flows SET mode = 'ordered' WHERE slug = 'production';
UPDATE v3.flows SET mode = 'block'   WHERE slug = 'pnp';
UPDATE v3.flows SET mode = 'loose'   WHERE slug = 'support';

COMMENT ON COLUMN v3.flows.mode IS
  'Como o fluxo é medido: ordered (esteira fase-a-fase) | block (soma '
  'num bloco do dia) | loose (ocorrências avulsas). O dashboard decide '
  'a agregação por aqui.';

COMMIT;
