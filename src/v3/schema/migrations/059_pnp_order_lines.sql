-- 059 — Espelho de pedidos P&P por linha (Bruno 08-01).
-- Cada linha de pedido de marketplace (Veeqo agora; TikTok/Shopify fase C)
-- vira uma row aqui, pro pick sheet ("15 garrafas do BIN A03 · SHELF S2"),
-- pro cockpit de impressão (fase B) e pra dedução idempotente de estoque.
-- REGRAS ESTRITAS do cockpit: linha só imprime em status='picklisted';
-- re-verificação na API de origem imediatamente antes de imprimir;
-- 'printed' é terminal (reimpressão = PIN de supervisor, logada);
-- cancelamento detectado pelo sync tira a linha visualmente.

CREATE TABLE IF NOT EXISTS v3.pnp_order_lines (
  id                SERIAL PRIMARY KEY,
  source            TEXT NOT NULL CHECK (source IN ('veeqo','tiktok','shopify')),
  external_order_id TEXT NOT NULL,
  external_line_id  TEXT NOT NULL,
  order_number      TEXT,                       -- número humano do pedido (se houver)
  channel           TEXT,                       -- Amazon / eBay / Walmart / ... (da Veeqo)
  sku               TEXT,
  product_id        INT REFERENCES v3.products(id),   -- resolvido via v3.product_skus
  qty               INT NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','picklisted','printed','shipped','cancelled','error')),
  order_date        DATE,                       -- dia NY do pedido
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  printed_at        TIMESTAMPTZ,
  shipped_at        TIMESTAMPTZ,
  deducted_at       TIMESTAMPTZ,               -- quando StockService.pick() rodou (Fase A: no shipped)
  error_note        TEXT,                      -- ex.: SKU sem mapeamento (fila de quarentena)
  raw               JSONB,                     -- payload da origem (auditoria/debug)
  UNIQUE (source, external_order_id, external_line_id)
);
CREATE INDEX IF NOT EXISTS idx_pnp_lines_day ON v3.pnp_order_lines (order_date, status);
CREATE INDEX IF NOT EXISTS idx_pnp_lines_status ON v3.pnp_order_lines (status)
  WHERE status IN ('pending','picklisted');
CREATE INDEX IF NOT EXISTS idx_pnp_lines_unmapped ON v3.pnp_order_lines (order_date)
  WHERE product_id IS NULL;
