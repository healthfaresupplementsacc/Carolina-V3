-- ============================================================
-- HEALTHFARE V3 — Migration 015: v3.pending_commands
-- ============================================================
-- ADITIVO. Cria tabela pra comandos destrutivos do admin via Slack
-- que precisam de confirmação 2-cliques (reaction ✅).
--
-- Caso motivador: bloco 30/mai noite — admin menciona @Carolina com
-- comando ("apaga ev280"). Sistema parseia, posta reply pedindo ✅
-- pra confirmar, salva intenção pendente aqui com TTL 10min.
-- Admin reage ✅ → handler busca aqui por carolina_msg_ts → executa.
-- Se timeout, status='expired'.
--
-- Idempotente (CREATE TABLE IF NOT EXISTS, IF NOT EXISTS em índices).
-- DOWN: DROP TABLE.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS v3.pending_commands (
  id                 SERIAL       PRIMARY KEY,
  carolina_msg_ts    TEXT         NOT NULL UNIQUE,     -- ts da reply da Carolina pedindo confirmação
  admin_msg_ts       TEXT         NOT NULL,            -- ts da msg original do admin
  admin_person_id    INTEGER      NOT NULL,            -- 1/2/3 (Bruno Camp/Thassio/Henrique)
  admin_slack_user_id TEXT,                            -- slack_user_id do admin (audit)
  command_type      TEXT          NOT NULL,            -- 'delete_event'|'reassign'|'edit_field'|...
  command_payload    JSONB        NOT NULL,            -- JSON estruturado pro executor
  status             TEXT         NOT NULL DEFAULT 'pending',  -- pending|confirmed|expired|cancelled|executed
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ  NOT NULL,            -- created_at + 10min
  confirmed_at       TIMESTAMPTZ,
  executed_at        TIMESTAMPTZ,
  result             JSONB                              -- { event_id, audit_log_id, ... } após execução
);

-- expira-rápido: cron varre pending com expires_at < NOW()
CREATE INDEX IF NOT EXISTS idx_pending_commands_status_expires
  ON v3.pending_commands (status, expires_at)
  WHERE status = 'pending';

-- lookup por reply ts (quando reaction chega)
CREATE INDEX IF NOT EXISTS idx_pending_commands_carolina_ts
  ON v3.pending_commands (carolina_msg_ts)
  WHERE status = 'pending';

COMMENT ON TABLE v3.pending_commands IS
  'Comandos destrutivos do admin via @Carolina mention aguardando confirmação ✅. '
  'TTL 10min; cron expira automático. Bloco 30/mai noite.';

COMMIT;
