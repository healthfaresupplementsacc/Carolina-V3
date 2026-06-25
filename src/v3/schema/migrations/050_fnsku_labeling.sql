-- 050: nova função "Colocando FNSKU / Código de Barras" (regra Bruno 06-22).
-- Quando a pessoa cola o FNSKU/código de barras no produto ANTES de enviar pro
-- Amazon/Walmart. NÃO é P&P / processo da manhã — é um processo separado, fica no
-- grupo "Envio De Caixas". flow=production (igual dc_shipment/marketplace_prep, a
-- família FBA/marketplace) → NÃO entra no cowork/contagem do P&P. Idempotente.
BEGIN;
INSERT INTO v3.activity_types (slug, display_name, category, requires_product, emoji, active, flow, is_background)
VALUES ('fnsku_labeling', 'Colocando FNSKU / Código de Barras', 'production_phase', false, '🏷️', true, 'production', false)
ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name, category = EXCLUDED.category,
  requires_product = EXCLUDED.requires_product, flow = EXCLUDED.flow, active = true;
COMMIT;
