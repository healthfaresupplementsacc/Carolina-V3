-- 063 — Product Setup: nickname, bottle color, tier de tamanho de pacote (Bruno 08-03).
-- Fundação do RODAPÉ de shipping label + compilação de labels pra impressão no .246.
-- Tudo ADITIVO (zero-disrupção). NADA aqui imprime nada — só guarda os dados que
-- a página de Product Setup edita e que o rodapé/pick sheet vão ler.
--
-- Regras do Bruno (2026-08-03):
--   • NICKNAME = SKU sem 'HF-' (ex.: HF-BEET-2000-C3 → BEET-2000-C3), mantendo o
--     casepack. É pré-preenchido mas EDITÁVEL por produto na página.
--   • BOTTLE COLOR = Black / White / Other(texto). EMS não tem cor → set manual 1×.
--   • TAMANHO DO PACOTE = por COR + nº de garrafas: 1→A, 2–6→Y, 7–9→B, 10+→BX (caixa).
--     Guardado como faixas por cor pra dar pra ajustar sem mexer no código.
--   • SKUs de canais DIFERENTES (eBay/Amazon/Walmart/TikTok) podem apontar pro MESMO
--     produto → v3.product_skus já faz isso (product_id), mas o CHECK de channel
--     estava restrito a veeqo/tiktok/shopify. Alargado abaixo.

-- 1) Nickname + bottle color no produto -------------------------------------
ALTER TABLE v3.products ADD COLUMN IF NOT EXISTS nickname TEXT;
ALTER TABLE v3.products ADD COLUMN IF NOT EXISTS bottle_color TEXT;   -- 'black' | 'white' | qualquer texto (Other)

-- 2) Alargar os canais aceitos em product_skus (eBay/Amazon/Walmart entram) ---
-- O CHECK antigo (veeqo/tiktok/shopify) barraria SKU de marketplace. Trocamos por
-- um conjunto amplo; canal desconhecido ainda cai fora (protege de lixo).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_schema='v3' AND table_name='product_skus' AND column_name='channel'
  ) THEN
    -- derruba o CHECK antigo pelo nome padrão do Postgres, se existir
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='product_skus_channel_check') THEN
      ALTER TABLE v3.product_skus DROP CONSTRAINT product_skus_channel_check;
    END IF;
  END IF;
  -- (re)cria o CHECK amplo
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='product_skus_channel_check') THEN
    ALTER TABLE v3.product_skus ADD CONSTRAINT product_skus_channel_check
      CHECK (channel IN ('veeqo','tiktok','shopify','ebay','amazon','walmart','other'));
  END IF;
END $$;

-- 3) Faixas de tamanho de pacote por cor de garrafa -------------------------
-- Uma linha por (cor, faixa de garrafas) → o package_size. Default (cor NULL)
-- serve de fallback pra qualquer cor sem override. max_bottles NULL = "sem teto".
CREATE TABLE IF NOT EXISTS v3.bottle_size_tiers (
  id            SERIAL PRIMARY KEY,
  bottle_color  TEXT,                 -- NULL = default (vale pra qualquer cor)
  min_bottles   INT  NOT NULL CHECK (min_bottles >= 1),
  max_bottles   INT  CHECK (max_bottles IS NULL OR max_bottles >= min_bottles),
  package_size  TEXT NOT NULL,        -- 'A' | 'Y' | 'B' | 'BX' ...
  is_box        BOOLEAN NOT NULL DEFAULT FALSE,   -- BX = caixa (só escreve "BX")
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bottle_tiers_color ON v3.bottle_size_tiers (bottle_color);

-- Seed do default (regra do Bruno). Idempotente: só insere se a tabela está vazia.
INSERT INTO v3.bottle_size_tiers (bottle_color, min_bottles, max_bottles, package_size, is_box)
SELECT * FROM (VALUES
  (CAST(NULL AS TEXT), 1,  1,    'A',  FALSE),
  (CAST(NULL AS TEXT), 2,  6,    'Y',  FALSE),
  (CAST(NULL AS TEXT), 7,  9,    'B',  FALSE),
  (CAST(NULL AS TEXT), 10, CAST(NULL AS INT), 'BX', TRUE)
) AS seed(bottle_color, min_bottles, max_bottles, package_size, is_box)
WHERE NOT EXISTS (SELECT 1 FROM v3.bottle_size_tiers);
