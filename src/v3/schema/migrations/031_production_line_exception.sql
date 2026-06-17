-- ============================================================
-- HEALTHFARE V3 — Migration 031: production_line exception (sem contagem)
-- ============================================================
-- ADITIVO. Ao FINALIZAR uma task 'production_line' o operador SEMPRE informa
-- quantas bottles saíram. Se não souber, marca "exceção" e explica o motivo —
-- e o sistema posta um aviso no canal orders-and-inventory. Estas colunas
-- registram a exceção no próprio event (a contagem em si segue em
-- v3.production_counts quando existir; admin pode resolver depois).
-- Idempotente. DOWN: 031_production_line_exception.down.sql
-- ============================================================
BEGIN;

ALTER TABLE v3.events
  ADD COLUMN IF NOT EXISTS exception_no_count BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE v3.events
  ADD COLUMN IF NOT EXISTS exception_reason TEXT;

-- exceções pendentes são poucas → índice parcial (mesmo padrão de is_long_running)
CREATE INDEX IF NOT EXISTS idx_events_exception
  ON v3.events(exception_no_count) WHERE exception_no_count = true;

COMMIT;
