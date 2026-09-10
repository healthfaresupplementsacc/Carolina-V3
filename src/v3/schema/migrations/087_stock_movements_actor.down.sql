-- desfaz o 087
BEGIN;
DROP INDEX IF EXISTS v3.idx_stock_movements_actor;
ALTER TABLE v3.stock_movements DROP COLUMN IF EXISTS actor_login_id, DROP COLUMN IF EXISTS actor_name;
COMMIT;
