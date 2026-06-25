-- 047: P&P não pede contagem no FIM.
-- Regra Bruno: no P&P a contagem do dia é dada UMA vez, no START da impressão
-- de ordens (a quantidade total de ordens a imprimir). Todo o trabalho seguinte
-- da cadeia (etiquetagem, empacotamento) se refere a essa mesma contagem — então
-- NÃO faz sentido perguntar de novo no fim de cada etapa.
--
-- O finish (op.js needOrders) já é gateado por requires_order_count; basta
-- desligar a flag nas etapas da cadeia. Mantém:
--   • order_printing*  → conta no START (não no fim, já era assim);
--   • marketplace_prep → tem contagem própria (FNSKU);
--   • clinic_shipment  → tarefa ISOLADA, NÃO é P&P, conta no START (kind='clinic').
-- Idempotente.
BEGIN;
UPDATE v3.activity_types SET requires_order_count = false
 WHERE slug IN ('labeling', 'packaging', 'packaging_other');
COMMIT;
