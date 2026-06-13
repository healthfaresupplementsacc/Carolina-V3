-- ============================================================
-- HEALTHFARE V3 — Migration 024: botão "Outro" por grupo
-- ============================================================
-- ADITIVO. Patch "outros por grupo".
-- Antes só existia 'special_task' (catch-all do grupo "Outros").
-- Bruno pediu um "Outro" em CADA grupo da Operator Page.
--
-- Grupos REAIS vêm do array GROUPS em scripts/build-fuse-data.js
-- (NÃO há coluna group_label no schema). Grupos com âncora:
--   linha 🏭, formulacao 🧪, limpeza 🧹 (Limpeza/Suporte),
--   embalagem 📦, envio 🚚, outros ⋯ (já tem special_task).
-- Não existe grupo "Suporte" separado → NÃO há support_other.
--
-- category respeita o CHECK (production_phase|support|meta|pnp_phase)
-- e flow respeita a FK v3.flows(slug) (pnp|production|support).
-- Escolha: todos os "outro" são support/support — igual ao
-- special_task, o único precedente de catch-all. São tarefas
-- livres (sem produto, sem quantidade, não-background); a UI as
-- agrupa por SLUG (array GROUPS), não por category — então
-- production_line_other aparece em "Linha" mesmo sendo support.
-- Idempotente (ON CONFLICT). DOWN: 024_outros_por_grupo.down.sql
-- ============================================================
BEGIN;

INSERT INTO v3.activity_types (slug, display_name, category, requires_product, emoji, active, flow, is_background)
VALUES
  ('production_line_other', 'Outro (Linha)',            'support', false, '✏️', true, 'support', false),
  ('formulation_other',     'Outro (Formulação)',       'support', false, '✏️', true, 'support', false),
  ('cleaning_other',        'Outro (Limpeza/Suporte)',  'support', false, '✏️', true, 'support', false),
  ('packaging_other',       'Outro (Embalagem)',        'support', false, '✏️', true, 'support', false),
  ('shipping_other',        'Outro (Envio)',            'support', false, '✏️', true, 'support', false)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
