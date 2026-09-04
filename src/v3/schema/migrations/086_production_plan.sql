-- 086 — Planejamento da produção (Bruno 09-04).
-- O quadro (funil dos lotes) é DERIVADO ao vivo (ems_activity_cache + events +
-- production_counts + stock_boxes) e não persiste nada. O que persiste é:
--   1. production_plan_items — os itens que o admin ARRASTA pro plano de um
--      dia (Amanhã + próximos dias): lote OU item livre (custom_title), com
--      posição pra ordenação por drag. Também guarda o flag manual_boxed:
--      enquanto a carga física não começa, stock_boxes está vazio e o humano
--      pode marcar "encaixotado" na mão (linha com plan_date NULL = flag do
--      quadro, não pertence a nenhum dia).
--   2. planning_notes — UMA caixa de anotações livres por data do plano.
-- Sem coluna de quantidade: nada aqui escreve estoque (StockService intocado).
BEGIN;

CREATE TABLE IF NOT EXISTS v3.production_plan_items (
  id            SERIAL PRIMARY KEY,
  plan_date     DATE,                    -- NULL = linha-flag do quadro (manual_boxed)
  position      INT NOT NULL DEFAULT 0,
  batch_number  TEXT,                    -- lote do EMS (cartão arrastado do quadro)
  product_id    INT REFERENCES v3.products(id),
  custom_title  TEXT,                    -- item livre ("+ Adicionar")
  note          TEXT,
  manual_boxed  BOOLEAN NOT NULL DEFAULT false,
  done          BOOLEAN NOT NULL DEFAULT false,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plan_items_date
  ON v3.production_plan_items(plan_date, position);
-- 1 flag de quadro por lote (as linhas de plano de um DIA podem repetir o lote)
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_items_board_flag
  ON v3.production_plan_items(batch_number) WHERE plan_date IS NULL;

CREATE TABLE IF NOT EXISTS v3.planning_notes (
  plan_date   DATE PRIMARY KEY,
  body        TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
