-- 035: conta SANDBOX (Bruno testa fluxos /op sem poluir DB/Slack/métricas).
-- persons.is_sandbox = operador de teste; events.is_test = task criada por sandbox.
-- Dados de sandbox são invisíveis (Slack/Carolina/métricas/Equipe) e auto-limpos.
BEGIN;
ALTER TABLE v3.persons ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
-- índice enxuto p/ o worker de limpeza varrer só os de teste
CREATE INDEX IF NOT EXISTS idx_events_test_cleanup
  ON v3.events(started_at, ended_at) WHERE is_test = true;
COMMIT;
