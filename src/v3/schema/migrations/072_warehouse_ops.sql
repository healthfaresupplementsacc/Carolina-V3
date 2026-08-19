-- 072 — Warehouse ops, Fase 3 (Bruno 08-18, estudo S15).
-- "go and do it all, make sure the hub is awesome": importar da Veeqo, etiquetas
-- de local, scanner pelo celular pareado, contagem por PESO e o hub do operador.
--
-- O que faltava no modelo do 058/060/071 pra isso:
--
--   1) PESO. Contar garrafa a garrafa é o que ninguém faz até o fim. Com o peso
--      unitário do produto (unit_weight_g) e a TARA do recipiente (bin/caixa ou
--      um preset reusável), a balança vira contador: qty = (bruto − tara) / unitário.
--      unit_weight_samples guarda de quantas garrafas veio a calibração (10 garrafas
--      dão um número melhor do que 1) e unit_weight_updated_at diz se está velho.
--
--   2) TARA REUSÁVEL (v3.tare_presets). "Caixa de papelão grande = 780g" vale pra
--      todas as caixas iguais; não faz sentido pesar caixa vazia toda vez.
--
--   3) META da proposta (v3.stock_change_requests.meta). A contagem por peso é uma
--      PROPOSTA (regra: total-changing espera aprovação) e o admin precisa ver como
--      o número saiu: bruto, tara, unitário, resíduo. Sem isso ele aprova no escuro.
--
--   4) PAREAMENTO CELULAR↔COMPUTADOR (v3.scan_pairs). O operador aponta o celular
--      pro QR do kiosk, e cada leitura do celular cai na tela do computador. O
--      código de 6 letras É a credencial do celular (curto, renovável, sem login
--      no telefone). Expira em 15 min e o kiosk renova enquanto a tela está aberta.
--
--   5) ETIQUETA IMPRESSA (label_printed_at, batch_number, sealed) e CAPACIDADE do
--      bin (capacity) — a caixa fechada leva produto + qty + lote e vai selada.
--
--   6) kind 'import' em stock_movements: a entrada inicial vinda da Veeqo tem que
--      ser distinguível de uma entrada real da linha pra sempre.
--
-- Aditivo: nenhuma linha existente muda de valor; nenhum fluxo atual quebra.
-- Princípio #24: tudo schema-qualificado v3.*.

BEGIN;

-- 1) PESO UNITÁRIO DO PRODUTO ---------------------------------------------------
ALTER TABLE v3.products ADD COLUMN IF NOT EXISTS unit_weight_g NUMERIC(8,2);
ALTER TABLE v3.products ADD COLUMN IF NOT EXISTS unit_weight_samples INT DEFAULT 0;
ALTER TABLE v3.products ADD COLUMN IF NOT EXISTS unit_weight_updated_at TIMESTAMPTZ;

-- 2) TARA + CAPACIDADE DOS RECIPIENTES ------------------------------------------
-- capacity = quantas garrafas cabem na prateleira (o "gap" da reposição sai daqui).
ALTER TABLE v3.stock_bins ADD COLUMN IF NOT EXISTS tare_g NUMERIC(8,2);
ALTER TABLE v3.stock_bins ADD COLUMN IF NOT EXISTS capacity INT DEFAULT 48;

ALTER TABLE v3.stock_boxes ADD COLUMN IF NOT EXISTS tare_g NUMERIC(8,2);
ALTER TABLE v3.stock_boxes ADD COLUMN IF NOT EXISTS batch_number TEXT;
ALTER TABLE v3.stock_boxes ADD COLUMN IF NOT EXISTS sealed BOOLEAN DEFAULT false;
ALTER TABLE v3.stock_boxes ADD COLUMN IF NOT EXISTS label_printed_at TIMESTAMPTZ;

-- 3) TARAS REUSÁVEIS ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS v3.tare_presets (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('bin','box')),
  tare_g      NUMERIC(8,2) NOT NULL CHECK (tare_g >= 0),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4) DETALHE DA PESAGEM NA PROPOSTA ---------------------------------------------
-- {gross_g, tare_g, unit_weight_g, computed_qty, residual_g, confidence, box:{...}}
ALTER TABLE v3.stock_change_requests ADD COLUMN IF NOT EXISTS meta JSONB;

-- 5) PAREAMENTO CELULAR ↔ KIOSK --------------------------------------------------
-- code = credencial do celular (6 chars, sem caractere ambíguo). session_token liga
-- ao kiosk que abriu o pareamento; person_id é quem estava logado lá.
CREATE TABLE IF NOT EXISTS v3.scan_pairs (
  code           TEXT PRIMARY KEY,
  session_token  TEXT,
  person_id      INT REFERENCES v3.persons(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  last_seen_at   TIMESTAMPTZ,
  phone_ua       TEXT
);
CREATE INDEX IF NOT EXISTS idx_scan_pairs_expires ON v3.scan_pairs (expires_at);
CREATE INDEX IF NOT EXISTS idx_scan_pairs_session ON v3.scan_pairs (session_token);

-- 6) kind 'import' ---------------------------------------------------------------
-- entrada inicial espelhada da Veeqo (nunca se confunde com produção da linha).
ALTER TABLE v3.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE v3.stock_movements ADD CONSTRAINT stock_movements_kind_check
  CHECK (kind IN ('store_in','pick','restock','adjust','damaged','count','place','move','import'));

-- índices de apoio
CREATE INDEX IF NOT EXISTS idx_stock_boxes_label ON v3.stock_boxes (label_printed_at);
CREATE INDEX IF NOT EXISTS idx_products_unit_weight ON v3.products (unit_weight_g)
  WHERE unit_weight_g IS NOT NULL;

COMMIT;
