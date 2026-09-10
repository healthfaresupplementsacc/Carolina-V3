-- desfaz o 089
BEGIN;
ALTER TABLE v3.notifications DROP COLUMN IF EXISTS audience, DROP COLUMN IF EXISTS link;
DROP TABLE IF EXISTS v3.login_functions;
DELETE FROM v3.role_functions WHERE function_key LIKE 'stock_%';
DELETE FROM v3.app_functions WHERE key LIKE 'stock_%';
COMMIT;
