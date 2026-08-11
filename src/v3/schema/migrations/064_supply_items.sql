-- 064 — SUPPLIES (envelopes/caixas) como inventário próprio (Bruno 08-03).
-- Área de estoque SEPARADA das garrafas/produtos: itens de EMBALAGEM que se
-- consomem a cada shipping label impressa. Regra do Bruno:
--   • Cada TAMANHO de pacote (A/Y/B/BX — de v3.bottle_size_tiers) usa 1 supply.
--   • Imprimiu 1 label → deduz 1 do supply daquele tamanho (não importa quantas
--     garrafas: o tamanho já embute a contagem — 3 garrafas pretas = tamanho Y = 1 envelope Y).
--   • min level por supply → alerta no admin-orin quando cai abaixo.
-- Mesma disciplina do estoque de garrafas (058): ledger append-only + idempotência
-- por (source, source_ref) pra a MESMA label nunca deduzir 2×. Aditivo, zero-disrupção.

-- 1) Itens de suprimento (o inventário) ------------------------------------
CREATE TABLE IF NOT EXISTS v3.supply_items (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,             -- 'Envelope A', 'Envelope Y', 'Caixa BX'...
  kind        TEXT NOT NULL DEFAULT 'envelope'
                CHECK (kind IN ('envelope','box','other')),
  qty         INT  NOT NULL DEFAULT 0,          -- quantidade em mãos
  min_qty     INT  NOT NULL DEFAULT 0,          -- limiar de alerta (0 = sem alerta)
  active      BOOLEAN NOT NULL DEFAULT true,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) Mapa TAMANHO DE PACOTE → supply (qual envelope/caixa cada tamanho usa) --
-- package_size casa com v3.bottle_size_tiers.package_size ('A','Y','B','BX'...).
-- qty_per = quantos supplies aquele tamanho consome por label (default 1).
CREATE TABLE IF NOT EXISTS v3.package_size_supply (
  package_size    TEXT PRIMARY KEY,
  supply_item_id  INT NOT NULL REFERENCES v3.supply_items(id) ON DELETE RESTRICT,
  qty_per         INT NOT NULL DEFAULT 1 CHECK (qty_per >= 1),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) Ledger append-only dos consumos/ajustes (idempotente) ------------------
CREATE TABLE IF NOT EXISTS v3.supply_movements (
  id             SERIAL PRIMARY KEY,
  kind           TEXT NOT NULL
                   CHECK (kind IN ('consume','restock','adjust','count')),
  supply_item_id INT NOT NULL REFERENCES v3.supply_items(id),
  qty            INT NOT NULL,                  -- com sinal (consume = negativo)
  package_size   TEXT,                          -- qual tamanho gerou o consumo (rastro)
  person_id      INT REFERENCES v3.persons(id),
  source         TEXT NOT NULL,                 -- 'label_print' | 'admin' | 'op_kiosk' | ...
  source_ref     TEXT,                          -- id da label/print pra idempotência
  note           TEXT,
  is_test        BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- a MESMA label (source+source_ref) nunca deduz 2×
CREATE UNIQUE INDEX IF NOT EXISTS idx_supply_movements_idem
  ON v3.supply_movements (source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_supply_movements_item
  ON v3.supply_movements (supply_item_id, created_at DESC);

-- 4) SEM seed. Os supplies (envelopes/caixas REAIS) são cadastrados UM A UM
-- pelo Bruno na aba Suprimentos, com os nomes/tipos reais dele. O mapa
-- TAMANHO→supply também é definido por ele (qual supply cada tamanho A/Y/B/BX usa).
-- (Placeholders 'Envelope A/Y/B' + 'Caixa BX' foram um erro — removidos 08-03.)
