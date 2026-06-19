-- 043: FASE PAUSA — pausa CONGELA todos os processos ativos do operador.
-- paused_at: quando o relógio do event parou (NULL = rodando).
-- total_paused_seconds: soma acumulada do tempo pausado (descontado do trabalho).
-- is_unfinished: pausa não retomada que virou o dia → some das tarefas ativas,
--   mas fica aberta (ended_at NULL) pra outra pessoa finalizar/continuar; admin resolve.
BEGIN;
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS total_paused_seconds INT NOT NULL DEFAULT 0;
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS is_unfinished BOOLEAN NOT NULL DEFAULT FALSE;
-- index pra achar rápido o trabalho congelado de um operador (resume + cleanup)
CREATE INDEX IF NOT EXISTS idx_events_paused ON v3.events(person_id, paused_at) WHERE paused_at IS NOT NULL AND ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_unfinished ON v3.events(is_unfinished) WHERE is_unfinished = TRUE AND ended_at IS NULL;
COMMENT ON COLUMN v3.events.paused_at IS 'FASE PAUSA: relógio parou neste instante (NULL = rodando). Pausa do operador congela todos os events ativos dele.';
COMMENT ON COLUMN v3.events.total_paused_seconds IS 'FASE PAUSA: total acumulado pausado. duração_trabalho = (ended_at-started_at) - total_paused_seconds.';
COMMENT ON COLUMN v3.events.is_unfinished IS 'FASE PAUSA: pausa não retomada que virou o dia. Some das tarefas ativas; fica aberta p/ outro finalizar/continuar.';
COMMIT;
