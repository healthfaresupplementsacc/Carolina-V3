-- 095 — ESPELHO DO HISTÓRICO DE ESTOQUE DA VEEQO (Bruno 09-16): "atualiza o sistema com as
-- entradas do último mês, adiciona as anotações e os motivos". Fonte: GET /stock_histories
-- (endpoint não documentado da Veeqo) — quem editou, quanto, nível depois, motivo e nota.
-- Uma linha por entrada da Veeqo (id = id da Veeqo). Quantidade NUNCA muda aqui: o que é
-- aplicável vira StockService.adjust e a linha aponta pro movimento (applied_movement_id).
CREATE TABLE IF NOT EXISTS v3.veeqo_stock_history (
  id                  BIGINT PRIMARY KEY,                 -- id da entrada na Veeqo
  created_at          TIMESTAMPTZ NOT NULL,               -- quando aconteceu na Veeqo
  sellable_id         BIGINT,
  sku                 TEXT,
  sellable_type       TEXT,                               -- ProductVariant | Kit
  product_id          INTEGER REFERENCES v3.products(id),
  warehouse_id        INTEGER,
  action              TEXT,                               -- edited_by_user | stock_pulled_from_remote_store | ...
  summary             TEXT,
  actor               TEXT,                               -- "Henrique Monteiro" (de "Edited by …")
  quantity            INTEGER NOT NULL DEFAULT 0,
  increased           BOOLEAN NOT NULL DEFAULT false,
  stock_level         INTEGER,                            -- nível na Veeqo DEPOIS da mudança
  reason              TEXT,                               -- motivo escolhido na Veeqo (Return, Item found, Other…)
  notes               TEXT,                               -- nota livre digitada na Veeqo
  apply_status        TEXT NOT NULL DEFAULT 'skipped',    -- pending | applied | duplicate | skipped | error
  skip_reason         TEXT,
  applied_movement_id INTEGER REFERENCES v3.stock_movements(id),
  applied_qty         INTEGER,
  applied_at          TIMESTAMPTZ,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_veeqo_stock_history_product ON v3.veeqo_stock_history (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_veeqo_stock_history_created ON v3.veeqo_stock_history (created_at DESC);
