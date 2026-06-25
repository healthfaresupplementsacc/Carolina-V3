-- 054: "Envio de Caixas" NÃO é P&P (regra Bruno 06-23).
-- Fechar Caixas (box_closing) e os envios estavam com flow='pnp' → apareciam como
-- P&P na timeline e entravam no cowork de P&P. Alinha o grupo ao flow='production'
-- (igual fnsku_labeling/dc_shipment, que já eram). counts_as_pp já era false.
-- clinic_shipment fica de fora (flow='support', métrica própria). Idempotente.
BEGIN;
UPDATE v3.activity_types
SET flow = 'production',
    category = CASE WHEN category = 'pnp_phase' THEN 'production_phase' ELSE category END
WHERE slug IN ('box_closing', 'shipping_walmart', 'shipping_amazon', 'shipping_other');
COMMIT;
