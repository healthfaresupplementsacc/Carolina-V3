-- 058 — Centro de Estoque, fundação (Bruno 08-01).
-- Estoque físico do armazém pro fluxo P&P (flow ②, direto-ao-cliente):
--   garrafas prontas em BINs nas prateleiras + excedente em CAIXAS numeradas
--   em paletes por área. Bins são reabastecidos das caixas até esvaziarem.
-- REGRA #1 do sistema: estoque SEMPRE sincronizado — por isso todo ajuste de
-- quantidade passa por v3.stock_movements (append-only, idempotente por
-- (source, source_ref)) escrito na MESMA transação que atualiza o qty do
-- bin/caixa (StockService é o ÚNICO caminho de escrita — nada de SQL solto).
-- NADA aqui toca fluxos existentes; tabelas novas, aditivas (garantia de
-- zero-disrupção: operadores não veem nada até o launch).

-- SKU↔produto persistido (substitui o matcher fuzzy do queryInventory como
-- fonte de verdade; a InventoryPage vira UI de confirmação).
CREATE TABLE IF NOT EXISTS v3.product_skus (
  id             SERIAL PRIMARY KEY,
  product_id     INT NOT NULL REFERENCES v3.products(id),
  sku            TEXT NOT NULL,
  channel        TEXT NOT NULL DEFAULT 'veeqo'
                   CHECK (channel IN ('veeqo','tiktok','shopify')),
  units_per_pack INT NOT NULL DEFAULT 1 CHECK (units_per_pack >= 1),  -- -C2/-C3 casepacks
  barcode        TEXT,                          -- UPC/FNSKU existente; ensinado no 1º scan
  confirmed_by_person_id INT REFERENCES v3.persons(id),
  confirmed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel, sku)
);
CREATE INDEX IF NOT EXISTS idx_product_skus_product ON v3.product_skus (product_id);
CREATE INDEX IF NOT EXISTS idx_product_skus_barcode ON v3.product_skus (barcode)
  WHERE barcode IS NOT NULL;

-- BIN = posição de prateleira com UM produto (é como o armazém opera hoje).
CREATE TABLE IF NOT EXISTS v3.stock_bins (
  id          SERIAL PRIMARY KEY,
  bin_code    TEXT NOT NULL UNIQUE,             -- ex.: 'A03'
  shelf_code  TEXT,                             -- ex.: 'S2'
  area        TEXT,                             -- área do armazém
  product_id  INT REFERENCES v3.products(id),   -- NULL = bin vazio/sem produto atribuído
  qty         INT NOT NULL DEFAULT 0 CHECK (qty >= 0),
  min_qty     INT NOT NULL DEFAULT 0,           -- gatilho de restock (por bin)
  cam         TEXT,                             -- calibração do mapa visual (fase câmeras)
  overlay_box JSONB,                            -- retângulo {x,y,w,h} fração da imagem
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_bins_product ON v3.stock_bins (product_id) WHERE active;

-- CAIXA numerada em palete (excedente que reabastece os bins).
CREATE TABLE IF NOT EXISTS v3.stock_boxes (
  id          SERIAL PRIMARY KEY,
  box_number  TEXT NOT NULL UNIQUE,             -- ex.: 'BOX-045'
  product_id  INT REFERENCES v3.products(id),
  qty         INT NOT NULL DEFAULT 0 CHECK (qty >= 0),
  area        TEXT,                             -- área do palete
  status      TEXT NOT NULL DEFAULT 'in_storage'
                CHECK (status IN ('in_storage','empty')),
  created_by_person_id INT REFERENCES v3.persons(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_boxes_product ON v3.stock_boxes (product_id)
  WHERE status = 'in_storage';

-- Livro-razão de movimentos: append-only, NUNCA update/delete de quantidade.
-- Todo movimento tem pessoa + origem; (source, source_ref) é a chave de
-- idempotência (ex.: 'veeqo_ship' + '<order_id>:<line_id>' — re-poll não
-- deduz duas vezes; mesmo padrão do ON CONFLICT do print-event).
CREATE TABLE IF NOT EXISTS v3.stock_movements (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL
                CHECK (kind IN ('store_in','pick','restock','adjust','damaged','count')),
  product_id  INT REFERENCES v3.products(id),
  qty         INT NOT NULL,                     -- com sinal (pick = negativo no bin)
  bin_id      INT REFERENCES v3.stock_bins(id),
  box_id      INT REFERENCES v3.stock_boxes(id),
  person_id   INT REFERENCES v3.persons(id),
  source      TEXT NOT NULL,                    -- 'op_kiosk' | 'veeqo_ship' | 'admin' | ...
  source_ref  TEXT,                             -- id externo pra idempotência
  snapshot_url TEXT,                            -- evidência de foto (fase câmeras)
  note        TEXT,
  is_test     BOOLEAN NOT NULL DEFAULT false,   -- sandbox nunca contamina estoque real
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- idempotência: só quando source_ref existe (movimentos manuais não têm)
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_movements_idem
  ON v3.stock_movements (source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_product
  ON v3.stock_movements (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_bin ON v3.stock_movements (bin_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_box ON v3.stock_movements (box_id);

-- Threshold por produto (velocity + editável pelo admin — Bruno: "both").
CREATE TABLE IF NOT EXISTS v3.stock_thresholds (
  product_id   INT PRIMARY KEY REFERENCES v3.products(id),
  min_days     NUMERIC,             -- alerta quando days_of_stock <= min_days (NULL = heurística)
  min_units    INT,                 -- alerta absoluto opcional
  set_by_person_id INT REFERENCES v3.persons(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
