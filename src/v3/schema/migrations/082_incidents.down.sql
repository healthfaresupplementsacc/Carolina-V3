-- 082 down — remove a tabela de incidentes (simétrico ao up).

BEGIN;

DROP INDEX IF EXISTS v3.idx_incidents_dossier_pending;
DROP INDEX IF EXISTS v3.idx_incidents_opened;
DROP INDEX IF EXISTS v3.idx_incidents_code_status;
DROP TABLE IF EXISTS v3.incidents;

COMMIT;
