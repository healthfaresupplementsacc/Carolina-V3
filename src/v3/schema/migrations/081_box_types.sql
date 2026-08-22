-- 081 — Tipos de caixa (Bruno 08-22, S15.43 — carga do estoque começa HOJE).
--
-- A caixa é registrada pelo TAMANHO ("20x20x20"), não uma a uma: pesa-se ~10
-- vazias e o sistema guarda a MÉDIA como tara do tipo, mais o espalhamento real
-- entre elas (tare_min_g / tare_max_g). O espalhamento vira a incerteza da
-- contagem por peso (qty_min..qty_max) e last_calibrated_at alimenta o aviso
-- "Precisamos re-pesar as caixas 20x20x20" — aviso que NUNCA bloqueia (RULE #0).
--
-- SEM colunas de quantidade: tipo de caixa é metadado físico. Quem escreve qty
-- continua sendo só o StockService (porta única).
-- Princípio #24: tudo schema-qualificado v3.*.

BEGIN;

CREATE TABLE IF NOT EXISTS v3.box_types (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  length_cm           NUMERIC NULL,
  width_cm            NUMERIC NULL,
  height_cm           NUMERIC NULL,
  tare_g              NUMERIC NULL,
  tare_samples        INT NOT NULL DEFAULT 0,
  tare_min_g          NUMERIC NULL,
  tare_max_g          NUMERIC NULL,
  last_calibrated_at  TIMESTAMPTZ NULL,
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Caixa física aponta pro tipo dela (opcional: caixa antiga fica sem tipo).
ALTER TABLE v3.stock_boxes ADD COLUMN IF NOT EXISTS box_type_id INT REFERENCES v3.box_types(id);

CREATE INDEX IF NOT EXISTS idx_stock_boxes_box_type ON v3.stock_boxes (box_type_id)
  WHERE box_type_id IS NOT NULL;

COMMIT;
