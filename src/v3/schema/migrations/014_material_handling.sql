-- ============================================================
-- HEALTHFARE V3 — Migration 014: activity_type material_handling
-- ============================================================
-- ADITIVO. Cria slug 'material_handling' (Recebimento/Expedição de material:
-- encher caminhão, descarregar caminhão, receber material, ajuda de entrega).
--
-- Categoria: support / support (infra logística — não é production phase, não
-- é P&P, não é dc_shipment).
-- Foreground (pessoa fisicamente envolvida).
--
-- Caso real: ev257 (Bruno Sarmento 4:25-4:28 PM 27/mai "ajudando encher
-- caminhão") foi criado com activity_type_id=NULL pela regra 24 (atividade não
-- reconhecida). Agora vira material_handling.
--
-- Próximas msgs ("descarregando caminhão", "ajuda de entrega") classificam
-- direto via regra 30 do prompt.
--
-- Idempotente — ON CONFLICT slug. DOWN: soft active=false.
-- ============================================================

BEGIN;

INSERT INTO v3.activity_types (slug, display_name, category, flow, is_background, phase_order, active)
VALUES ('material_handling', 'Recebimento/Expedição (Carga/Descarga)', 'support', 'support', false, 0, true)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
