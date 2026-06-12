-- DOWN da 018 — reverte Operator Page. Perde sessões/notas/notifications
-- (dados de staging/UX, perda aceitável). Restaura o CHECK antigo do audit_log.
BEGIN;

DROP TABLE IF EXISTS v3.notifications;
DROP TABLE IF EXISTS v3.op_notes;
DROP TABLE IF EXISTS v3.operator_sessions;

ALTER TABLE v3.events DROP COLUMN IF EXISTS superseded_by_event_id;
ALTER TABLE v3.events DROP COLUMN IF EXISTS source;

ALTER TABLE v3.persons DROP COLUMN IF EXISTS count_exempt;
ALTER TABLE v3.persons DROP COLUMN IF EXISTS is_admin_operator;
ALTER TABLE v3.persons DROP COLUMN IF EXISTS last_page_login_at;
ALTER TABLE v3.persons DROP COLUMN IF EXISTS auto_logoff_seconds;
ALTER TABLE v3.persons DROP COLUMN IF EXISTS pin_salt;
ALTER TABLE v3.persons DROP COLUMN IF EXISTS pin_hash;

ALTER TABLE v3.audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_type_check;
ALTER TABLE v3.audit_log ADD CONSTRAINT audit_log_actor_type_check
  CHECK (actor_type = ANY (ARRAY[
    'admin'::text, 'llm_observer'::text, 'llm_assistant'::text,
    'system'::text, 'app_home'::text
  ]));

COMMIT;
