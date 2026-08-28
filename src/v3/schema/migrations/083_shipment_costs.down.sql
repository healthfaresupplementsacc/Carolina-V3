-- 083 down — remove a tabela de custo de frete (simétrico ao up).

BEGIN;

DROP INDEX IF EXISTS v3.idx_shipment_costs_band_bought;
DROP INDEX IF EXISTS v3.idx_shipment_costs_outlier_day;
DROP INDEX IF EXISTS v3.idx_shipment_costs_day;
DROP TABLE IF EXISTS v3.shipment_costs;

COMMIT;
