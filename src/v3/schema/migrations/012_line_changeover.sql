-- ============================================================
-- HEALTHFARE V3 — Migration 012: activity_type line_changeover
-- ============================================================
-- 100% ADITIVO. Cria o novo activity_type 'line_changeover' (Troca de Linha /
-- Setup) — setup da máquina entre produtos diferentes, distinto de:
--   - organization (vassoura/varrer)   — flow=support, category=support
--   - repair       (conserto)          — flow=support, category=support
--   - production_line (rodar produto)  — flow=production, phase
-- Setup é parte da PRODUÇÃO (transição planejada entre lotes), foreground,
-- não-background. Phase_order=0 (anterior a outras fases).
--
-- Regra 23 do prompt (E7-bloco 27/mai) instrui o LLM a usar esse slug pra
-- mensagens tipo "troca da linha de produção".
--
-- Idempotente — ON CONFLICT (slug) protege contra re-run.
-- DOWN: drop pelo slug (não force; soft delete via active=false).
-- ============================================================

BEGIN;

INSERT INTO v3.activity_types (slug, display_name, category, flow, is_background, phase_order, active)
VALUES ('line_changeover', 'Troca de Linha (Setup)', 'production_phase', 'production', false, 0, true)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
