-- ============================================================
-- HEALTHFARE V3 — Migration 010: expediente extendido (8am–9pm NY)
-- ============================================================
-- 100% ADITIVO. Atualiza expedient_end_hour_ny 19→21 (auto-close de
-- segurança passa a fechar events às 21h NY em vez de 19h). Adiciona
-- expedient_start_hour_ny=8 pra registrar formalmente o início do
-- expediente (já era 8h por convenção; agora explícito).
--
-- Motivação: Henrique passou o dia 25/mai cobrando o time pra colocar
-- "F" porque events ficavam abertos cruzando a noite. O auto-close
-- estava em 19h (template antigo); o expediente real terminou em 21h.
-- Resultado: events fechavam às 19:00 quando o trabalho seguia até 21h.
--
-- DOWN: volta pra 19 (sem remover expedient_start_hour_ny — additive).
-- ============================================================

BEGIN;

INSERT INTO v3.settings (key, value) VALUES
  ('expedient_end_hour_ny', '21'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO v3.settings (key, value) VALUES
  ('expedient_start_hour_ny', '8'::jsonb)
  ON CONFLICT (key) DO NOTHING;

COMMIT;
