-- ============================================================
-- HEALTHFARE V3 — Migration 013: facility_maintenance + machine_downtime
-- ============================================================
-- ADITIVO. Cria 2 novos activity_types pra dividir o que hoje cai todo
-- em 'repair' (slug ambíguo):
--
--   facility_maintenance — manutenção da INSTALAÇÃO/FÁBRICA. Trocar
--     filtro do ar-condicionado, consertar luminária, encanamento.
--     NÃO pára a linha de produção. flow=support / category=support.
--     NÃO é downtime crítico.
--
--   machine_downtime — máquina parou. "Pausa para ajuste máquina X",
--     "máquina quebrou", "ajustando máquina durante linha". Quando isso
--     acontece, a LINHA PARA — quem está na linha aguarda. CRÍTICO.
--     flow=support / category=support, MAS marcado como downtime no
--     flow-views-repo.js DOWNTIME_SLUGS (regra de leitura).
--
-- Bloco 27/mai — Bruno autorizou criar os 2 tipos como parte das regras
-- 25 + 26 do prompt. Eventos legacy ficam em 'repair' (slug genérico);
-- novos eventos usam o slug certo.
--
-- Idempotente — ON CONFLICT (slug). DOWN: soft active=false.
-- ============================================================

BEGIN;

INSERT INTO v3.activity_types (slug, display_name, category, flow, is_background, phase_order, active)
VALUES
  ('facility_maintenance', 'Manutenção da Fábrica',  'support', 'support', false, 0, true),
  ('machine_downtime',     'Downtime da Máquina',    'support', 'support', false, 0, true)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
