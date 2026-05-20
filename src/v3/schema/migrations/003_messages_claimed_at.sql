-- ============================================================
-- HEALTHFARE V3 — Migration 003: v3.messages.claimed_at
-- ============================================================
-- FIX A (pós-backfill §2.13) — dupla-processamento.
-- O backfill expôs 18 rows com llm_processed_at E processing_error
-- ao mesmo tempo: ticks sobrepostos re-pegavam mensagens lentas
-- (>5s de LLM) antes do tick anterior terminar.
--
-- Solução: claim no DB. O worker faz UPDATE...RETURNING que marca
-- claimed_at=NOW(); só processa o que reivindicou. Claim expira em
-- 2min (claimed_at < NOW()-interval '2 min') p/ um crash não deixar
-- a mensagem presa pra sempre.
--
-- Coluna ADITIVA, nullable, sem default — zero impacto em rows
-- existentes (todas ficam claimed_at=NULL → elegíveis pro claim).
--
-- Incremental porque 001 já rodou em prod.
-- Transação única. DOWN: 003_messages_claimed_at.down.sql.
-- ============================================================

BEGIN;

ALTER TABLE v3.messages ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN v3.messages.claimed_at IS
  'FIX A: timestamp em que o Observer worker reivindicou a mensagem. '
  'NULL = não reivindicada. Claim expira em 2min (re-claim após crash).';

COMMIT;
