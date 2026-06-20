-- 044: EMS auto check-in. Mapeia operador do EMS por UUID (ems_user_id) e deixa o
-- worker criar/fechar tarefa automática quando um STAGE inicia no pipeline.
-- ems_user_id: UUID do operador no EMS (operator.user_id) — mapeamento robusto
--   (nome é frágil; estudo: 1 employee name:null). Backfill por nome no sync.
-- auto_event_id: o event que o auto-checkin criou pra essa atividade (pra fechar
--   quando o stage completa no EMS).
BEGIN;
ALTER TABLE v3.persons ADD COLUMN IF NOT EXISTS ems_user_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_persons_ems_user_id ON v3.persons(ems_user_id) WHERE ems_user_id IS NOT NULL;
ALTER TABLE v3.ems_activity_cache ADD COLUMN IF NOT EXISTS auto_event_id BIGINT;
COMMENT ON COLUMN v3.persons.ems_user_id IS 'UUID do operador no EMS (operator.user_id). Mapeamento robusto p/ detecção/auto check-in.';
COMMENT ON COLUMN v3.ems_activity_cache.auto_event_id IS 'Event criado pelo auto check-in do EMS (fechado quando o stage completa).';
COMMIT;
