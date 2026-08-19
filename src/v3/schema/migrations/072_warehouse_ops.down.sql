-- 072 DOWN — desfaz a Fase 3 do warehouse (Bruno 08-18, estudo S15).
-- Volta os CHECKs ao estado do 071 e derruba SÓ o que o 072 criou.
-- ATENÇÃO: derrubar as colunas de peso apaga calibração; derrubar scan_pairs
-- desliga o pareamento do celular. Não roda isso com o hub em uso.

BEGIN;

-- 6) kind 'import' → volta ao CHECK do 071
ALTER TABLE v3.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE v3.stock_movements ADD CONSTRAINT stock_movements_kind_check
  CHECK (kind IN ('store_in','pick','restock','adjust','damaged','count','place','move'));

-- 5) pareamento
DROP INDEX IF EXISTS v3.idx_scan_pairs_session;
DROP INDEX IF EXISTS v3.idx_scan_pairs_expires;
DROP TABLE IF EXISTS v3.scan_pairs;

-- 4) meta da proposta
ALTER TABLE v3.stock_change_requests DROP COLUMN IF EXISTS meta;

-- 3) taras reusáveis
DROP TABLE IF EXISTS v3.tare_presets;

-- 2) tara + capacidade
DROP INDEX IF EXISTS v3.idx_stock_boxes_label;
ALTER TABLE v3.stock_boxes DROP COLUMN IF EXISTS label_printed_at;
ALTER TABLE v3.stock_boxes DROP COLUMN IF EXISTS sealed;
ALTER TABLE v3.stock_boxes DROP COLUMN IF EXISTS batch_number;
ALTER TABLE v3.stock_boxes DROP COLUMN IF EXISTS tare_g;
ALTER TABLE v3.stock_bins DROP COLUMN IF EXISTS capacity;
ALTER TABLE v3.stock_bins DROP COLUMN IF EXISTS tare_g;

-- 1) peso unitário
DROP INDEX IF EXISTS v3.idx_products_unit_weight;
ALTER TABLE v3.products DROP COLUMN IF EXISTS unit_weight_updated_at;
ALTER TABLE v3.products DROP COLUMN IF EXISTS unit_weight_samples;
ALTER TABLE v3.products DROP COLUMN IF EXISTS unit_weight_g;

COMMIT;
