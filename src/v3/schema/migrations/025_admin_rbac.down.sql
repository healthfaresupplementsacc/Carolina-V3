-- Reverte 025. Remove sessões e usuários admin (dado operacional/auth,
-- não histórico — audit_log dos logins permanece). Após o DOWN, /admin
-- volta a depender de ADMIN_PASSWORD (fallback de emergência).
DROP TABLE IF EXISTS v3.admin_sessions;
DROP TABLE IF EXISTS v3.admin_users;
