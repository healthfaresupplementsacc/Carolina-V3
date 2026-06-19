-- 039: FASE A — reorg do menu + contagem P&P.
-- requires_order_count = pede quantidade no FINISH.
-- counts_as_pp        = entra na métrica "P&P do dia" (clínica NÃO conta).
-- Novos slugs de formulação alinhados aos stages do EMS (weighing/blending/encapsulating).
BEGIN;
ALTER TABLE v3.activity_types
  ADD COLUMN IF NOT EXISTS requires_order_count BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS counts_as_pp BOOLEAN NOT NULL DEFAULT FALSE;

-- novos passos de Formulação (copiam category/flags do 'formulation' existente)
INSERT INTO v3.activity_types (slug, display_name, category, requires_product, active, is_background)
SELECT 'separating', 'Separando ingredientes', category, requires_product, true, is_background
  FROM v3.activity_types WHERE slug = 'formulation'
  AND NOT EXISTS (SELECT 1 FROM v3.activity_types WHERE slug = 'separating');
INSERT INTO v3.activity_types (slug, display_name, category, requires_product, active, is_background)
SELECT 'weighing', 'Pesagem (weighing)', category, requires_product, true, is_background
  FROM v3.activity_types WHERE slug = 'formulation'
  AND NOT EXISTS (SELECT 1 FROM v3.activity_types WHERE slug = 'weighing');

-- "Ordens" genérico inútil → desativa (sai do menu)
UPDATE v3.activity_types SET active = false WHERE slug = 'orders';

-- pede contagem no FINISH: P&P + trocar label + envio clínica
UPDATE v3.activity_types SET requires_order_count = true
 WHERE slug IN ('order_printing','order_printing_2','labeling','packaging','packaging_other','marketplace_prep','clinic_shipment');

-- conta como P&P na métrica do dia (NÃO clínica, NÃO envios grandes)
UPDATE v3.activity_types SET counts_as_pp = true
 WHERE slug IN ('order_printing','order_printing_2','labeling','packaging','packaging_other','marketplace_prep');
COMMIT;
