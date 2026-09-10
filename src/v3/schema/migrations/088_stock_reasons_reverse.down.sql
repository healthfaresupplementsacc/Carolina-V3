-- desfaz o 088 (so roda se nao houver movimento take/transfer; o Postgres recusa se houver)
BEGIN;
ALTER TABLE v3.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE v3.stock_movements ADD CONSTRAINT stock_movements_kind_check
  CHECK (kind IN ('store_in','pick','restock','adjust','damaged','count','place','move','import'));
DROP INDEX IF EXISTS v3.idx_stock_movements_reverses;
DROP INDEX IF EXISTS v3.idx_stock_movements_reason;
ALTER TABLE v3.stock_movements
  DROP COLUMN IF EXISTS reason_code, DROP COLUMN IF EXISTS ref_type,
  DROP COLUMN IF EXISTS ref_id, DROP COLUMN IF EXISTS reverses_movement_id;
DROP TABLE IF EXISTS v3.stock_reasons;
COMMIT;
