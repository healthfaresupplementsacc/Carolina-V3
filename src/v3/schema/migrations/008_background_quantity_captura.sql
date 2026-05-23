-- ============================================================
-- HEALTHFARE V3 — Migration 008: captura aprimorada (background, quantidade)
-- ============================================================
-- Bloco "Captura Aprimorada Parte A". 100% ADITIVO. Em transação
-- única, com DOWN disponível. Defaults seguros — events e
-- activity_types existentes seguem como FOREGROUND (is_background=
-- false), sem mudança de interpretação. Cutover registrado nos
-- settings pra rastreabilidade.
--
-- Schema:
--   activity_types.is_background      — true para formulação, mix,
--       encapsulação (rodam na máquina; coexistem com foreground)
--   activity_types.expected_seconds   — duração esperada (~2-3h),
--       configurável; dispara alerta no dashboard quando excede
--   events.quantity / quantity_unit   — captura "142 ordens" no P&P,
--       reaproveita pra qualquer event que tenha quantidade
--
-- Settings (chave→valor jsonb):
--   meta_pauses_foreground            — true (default): almoço/break
--       fecha foreground; NÃO toca background nem outro meta
--   break_assumed_seconds             — 2700 (45min): quando break
--       fica aberto sem "voltei" explícito, assume essa duração
--   expedient_end_hour_ny             — 19 (7PM NY): auto-close de
--       segurança fecha events ainda abertos do dia anterior
--   captura_aprimorada_cutover_date   — registra o dia da entrada
--       em vigor das regras novas (events antes seguem regra antiga)
-- ============================================================

BEGIN;

ALTER TABLE v3.activity_types
  ADD COLUMN IF NOT EXISTS is_background BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE v3.activity_types
  ADD COLUMN IF NOT EXISTS expected_seconds INTEGER;

ALTER TABLE v3.events
  ADD COLUMN IF NOT EXISTS quantity INTEGER;
ALTER TABLE v3.events
  ADD COLUMN IF NOT EXISTS quantity_unit TEXT;

COMMENT ON COLUMN v3.activity_types.is_background IS
  'true = atividade roda em paralelo (máquina); não fecha foreground '
  'nem é fechada por nova foreground. Default false = foreground.';
COMMENT ON COLUMN v3.activity_types.expected_seconds IS
  'Duração esperada em segundos. Usado pelo dashboard pra alertar '
  'quando um event open passou do esperado.';
COMMENT ON COLUMN v3.events.quantity IS
  'Quantidade capturada na mensagem (ex.: 142 ordens no P&P).';
COMMENT ON COLUMN v3.events.quantity_unit IS
  'Unidade de quantity (order|bottle|box|...). Free-text validado no service.';

-- Seed background nas 3 atividades de máquina.
UPDATE v3.activity_types
  SET is_background = true
  WHERE slug IN ('formulation', 'mixing', 'encapsulation');

-- Settings de comportamento (defaults). ON CONFLICT pra rodar várias vezes.
INSERT INTO v3.settings (key, value) VALUES
  ('meta_pauses_foreground',         'true'::jsonb),
  ('break_assumed_seconds',          '2700'::jsonb),
  ('expedient_end_hour_ny',          '19'::jsonb),
  ('captura_aprimorada_cutover_date', to_jsonb(CURRENT_DATE::text))
ON CONFLICT (key) DO NOTHING;

COMMIT;
