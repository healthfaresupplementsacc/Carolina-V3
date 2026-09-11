-- 091 — KIOSK: "Outros" com título, subtipo de limpeza, tiles novos, painel de reclassificação (Bruno 09-11).
-- "troque o 'algo especial' para 'Outros'"; "Recebimento de powder... under formulation e no outros";
-- "Peneira under formulation"; "um painel pra reclassificar os outros... fica lá até ser resolvido".
UPDATE v3.activity_types SET display_name = 'Outros' WHERE slug = 'special_task';
INSERT INTO v3.activity_types (slug, display_name, category, requires_product, emoji, active, flow, is_background)
VALUES ('powder_receiving', 'Recebimento de powder no sistema', 'support', false, '📥', true, 'support', false)
ON CONFLICT (slug) DO NOTHING;
INSERT INTO v3.activity_types (slug, display_name, category, requires_product, emoji, active, flow, is_background)
VALUES ('sieving', 'Peneira', 'production_phase', true, '🫗', true, 'production', false)
ON CONFLICT (slug) DO NOTHING;
-- painel "Outros pra reclassificar": fica aberto até alguém resolver
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS other_reviewed_at TIMESTAMPTZ;
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS other_reviewed_by TEXT;
