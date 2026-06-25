-- 049: "Ajuste de ordens" no Embalagem/Outro (regra Bruno 06-22).
-- O operador pode, num packaging_other, AJUSTAR a contagem de ordens do dia:
--   • 'additional' → soma N ordens ao total (correção pra cima).
--   • 'reset'      → ZERA as contagens do dia e grava só o novo total N
--                    (supersede as antigas via superseded_by; elas continuam
--                    visíveis riscadas no dashboard). Dispara warning no Slack.
-- adjustment_kind marca a origem; NULL = contagem normal (impressão/clínica).
BEGIN;
ALTER TABLE v3.production_counts
  ADD COLUMN IF NOT EXISTS adjustment_kind text
    CHECK (adjustment_kind IN ('additional', 'reset'));
COMMIT;
