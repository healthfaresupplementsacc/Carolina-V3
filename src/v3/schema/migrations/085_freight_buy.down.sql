-- down da 085 — remove a trilha de compra da Fase B. Simétrico e sem tocar em
-- nenhuma coluna da 083/084.

BEGIN;

DROP INDEX IF EXISTS v3.idx_shipment_costs_order;

ALTER TABLE v3.shipment_costs
  DROP COLUMN IF EXISTS tracking_number,
  DROP COLUMN IF EXISTS carrier_name,
  DROP COLUMN IF EXISTS bought_via,
  DROP COLUMN IF EXISTS rate_id,
  DROP COLUMN IF EXISTS label_file_id,
  DROP COLUMN IF EXISTS marked_shipped_at,
  DROP COLUMN IF EXISTS mark_shipped_error;

COMMIT;
