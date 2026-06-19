-- 037: operator_action_log — rede de segurança APPEND-ONLY (retenção mín. 5 dias).
-- "Se Ana registrar algo, fica logado em lugar separado por no mínimo 5 dias."
-- NUNCA recebe UPDATE/DELETE dentro de 5 dias; o cleanup só apaga > 5 dias.
-- Sobrevive a fechar/deletar/modificar o v3.events (guarda o input original).
BEGIN;
CREATE TABLE IF NOT EXISTS v3.operator_action_log (
  id                BIGSERIAL PRIMARY KEY,
  person_id         INT,
  person_name       TEXT,
  action_type       TEXT NOT NULL,   -- login, task_start, task_finish, cowork_join, gap_justify, end_of_day, admin_action, slack_message
  source            TEXT NOT NULL,   -- operator_page, slack, admin, system
  payload           JSONB,           -- input bruto, completo
  raw_text          TEXT,            -- texto cru (Slack)
  related_event_id  BIGINT,
  is_test           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_action_log_person ON v3.operator_action_log(person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_log_created ON v3.operator_action_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_log_type ON v3.operator_action_log(action_type, created_at DESC);
COMMIT;
