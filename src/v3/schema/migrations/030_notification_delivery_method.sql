-- ============================================================
-- HEALTHFARE V3 — Migration 030: notifications.delivery_method
-- ============================================================
-- ADITIVO. Patch silent-mode. Permite o dedupe-watcher criar a
-- notification no inbox admin SEM a Carolina postar no #admin-orin
-- (enquanto operadores ainda não migraram pra /op/ e tudo do Slack
-- viraria spam). Valores: 'slack_and_inbox' (default), 'admin_inbox_only',
-- 'slack_only', 'none'.
-- (Obs: 029 já é label_tasks — esta é a 030.)
-- Idempotente. DOWN: 030_notification_delivery_method.down.sql
-- ============================================================
BEGIN;
ALTER TABLE v3.notifications
  ADD COLUMN IF NOT EXISTS delivery_method VARCHAR(30) NOT NULL DEFAULT 'slack_and_inbox';
COMMIT;
