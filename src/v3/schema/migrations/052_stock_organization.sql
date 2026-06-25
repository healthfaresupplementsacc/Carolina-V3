-- 052: nova task "Organização de Stock (Inventário)" (regra Bruno 06-22).
-- Limpeza/Suporte (flow=support). Idempotente.
BEGIN;
INSERT INTO v3.activity_types (slug, display_name, category, requires_product, emoji, active, flow, is_background)
VALUES ('stock_organization', 'Organização de Stock (Inventário)', 'support', false, '📦', true, 'support', false)
ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name, category = EXCLUDED.category, flow = EXCLUDED.flow, active = true;
COMMIT;
