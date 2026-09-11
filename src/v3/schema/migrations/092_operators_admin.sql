-- 092 — OPERADORES NO PAINEL (Bruno 09-11): PIN legível pro admin, "logar como", o que cada um vê no kiosk.
-- "na página de admin eu deveria conseguir ver o pin de todos pq se eles esquecerem eu consigo falar";
-- "no sandbox eu deveria poder 'logar como'"; "editar o que eles podem ver no kiosk".
ALTER TABLE v3.persons ADD COLUMN IF NOT EXISTS pin_plain TEXT;                 -- só lido por quem gerencia usuários (auditado)
ALTER TABLE v3.persons ADD COLUMN IF NOT EXISTS kiosk_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;   -- { hidden_groups: ['envio', ...] }
ALTER TABLE v3.operator_sessions ADD COLUMN IF NOT EXISTS impersonated_by TEXT; -- sessão aberta pelo admin "logando como"
