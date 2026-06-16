-- DOWN — Migration 017: Carolina Config + Flex Learning
-- Ordem reversa (FKs primeiro, depois tabelas-pai).
BEGIN;

-- carolina_signals.cycle_id FK
ALTER TABLE IF EXISTS v3.carolina_signals
  DROP CONSTRAINT IF EXISTS carolina_signals_cycle_id_fkey;

DROP TABLE IF EXISTS v3.carolina_learning_cycles;
DROP TABLE IF EXISTS v3.carolina_signals;
DROP TABLE IF EXISTS v3.carolina_prompt_versions;
DROP TABLE IF EXISTS v3.carolina_channel_personality;
DROP TABLE IF EXISTS v3.carolina_config;
DROP TABLE IF EXISTS v3.carolina_personalities;

COMMIT;
