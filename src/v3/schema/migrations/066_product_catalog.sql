-- 066 — Catálogo consolidado de suplementos (Bruno 08-04).
-- Fonte: "HealthFare Supplement Catalog (Updated 08.04.2026)" — levantamento
-- feito sobre as ARTES DE RÓTULO em PRODUCT ASSETS: 98 SKUs/variantes com
-- validade impressa no rótulo, lote, porção, porções/frasco, potência,
-- Supplement Facts transcrito, e COAs de matéria-prima.
-- NOTAS DO LEVANTAMENTO (importam pro uso):
--  • Validade = a data impressa na ARTE ATUAL do rótulo (não é validade
--    física de lote em prateleira; confiança registrada por linha).
--  • Lote com confiança 'Média' veio de texto vetorial → confirmar visual.
--  • COA de matéria-prima NÃO substitui validade do produto acabado.
--  • Existe item HOLD - NÃO IMPRIMIR → o sistema deve exibir e barrar print.
-- Import idempotente por catalog_name (scripts/import-supplement-catalog.js).

CREATE TABLE IF NOT EXISTS v3.product_catalog (
  id            SERIAL PRIMARY KEY,
  catalog_name  TEXT NOT NULL UNIQUE,          -- "Suplemento / SKU" da planilha
  family        TEXT,                          -- ex.: 'Activated Charcoal'
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','multipack','hold')),
  content_desc  TEXT,                          -- '150 caps'
  serving_size  TEXT,                          -- '2 Capsules'
  servings_per_container INT,
  potency       TEXT,                          -- ativos principais
  expiry_date   DATE,                          -- validade impressa no rótulo atual
  batch_number  TEXT,
  expiry_confidence TEXT,
  batch_confidence  TEXT,
  active_ingredients TEXT,
  facts_transcript   TEXT,
  other_ingredients  TEXT,
  directions    TEXT,
  facts_source  TEXT,                          -- caminho relativo em PRODUCT ASSETS
  expiry_source TEXT,
  notes         TEXT,
  product_id    INT REFERENCES v3.products(id),-- match por nome (sugestão; admin pode corrigir)
  match_kind    TEXT,                          -- 'exact' | 'normalized' | 'manual' | NULL
  imported_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_product_catalog_product ON v3.product_catalog (product_id);
CREATE INDEX IF NOT EXISTS idx_product_catalog_expiry ON v3.product_catalog (expiry_date);

CREATE TABLE IF NOT EXISTS v3.raw_material_coas (
  id          SERIAL PRIMARY KEY,
  material    TEXT NOT NULL,
  lot         TEXT,
  mfg_date    DATE,
  expiry_date DATE,
  source      TEXT,
  notes       TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (material, lot)
);
