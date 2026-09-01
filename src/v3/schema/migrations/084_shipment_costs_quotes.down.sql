-- 084 down — remove as colunas de cotação do copiloto (simétrico ao up).

BEGIN;

ALTER TABLE v3.shipment_costs
  DROP COLUMN IF EXISTS quoted_best_cost,
  DROP COLUMN IF EXISTS quoted_best_service,
  DROP COLUMN IF EXISTS quoted_valid_count,
  DROP COLUMN IF EXISTS quoted_at;

COMMIT;
