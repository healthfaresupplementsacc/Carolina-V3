-- ============================================================
-- HEALTHFARE V3 — Migration 029: tarefas de label no grupo Limpeza/Suporte
-- ============================================================
-- ADITIVO. Bruno pediu, na página do operador, área no grupo
-- "Limpeza / Suporte" pra:
--   - label_change  → "Troca de label"
--   - label_repair  → "Conserto de label"
-- Ambas exigem NOTA (validado no servidor: op.js NOTE_REQUIRED_SLUGS).
-- category='support'/flow='support' (igual cleaning), sem produto,
-- não-background. Idempotente. DOWN: 029_label_tasks.down.sql
-- ============================================================
BEGIN;

INSERT INTO v3.activity_types (slug, display_name, category, requires_product, emoji, active, flow, is_background)
VALUES
  ('label_change', 'Troca de label',    'support', false, '🏷️', true, 'support', false),
  ('label_repair', 'Conserto de label', 'support', false, '🔧', true, 'support', false)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
