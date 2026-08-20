-- desfaz o 078
BEGIN;
DROP INDEX IF EXISTS v3.idx_products_kind_active;
ALTER TABLE v3.products DROP CONSTRAINT IF EXISTS products_kind_check;
ALTER TABLE v3.products DROP COLUMN IF EXISTS kind;
COMMIT;
