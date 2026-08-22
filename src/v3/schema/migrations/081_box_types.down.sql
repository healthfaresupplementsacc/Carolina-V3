-- 081 down — remove tipos de caixa (simétrico ao up).

BEGIN;

DROP INDEX IF EXISTS v3.idx_stock_boxes_box_type;
ALTER TABLE v3.stock_boxes DROP COLUMN IF EXISTS box_type_id;
DROP TABLE IF EXISTS v3.box_types;

COMMIT;
