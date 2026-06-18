-- ============================================================
-- HEALTHFARE V3 — Migration 033: cowork multi-finish (N events por grupo)
-- ============================================================
-- ADITIVO (Fase 1). Cowork deixa de ser 1 event com cowork_with[]: agora o
-- /start cria N events (1 por operador) com o MESMO cowork_group_id. Cada
-- operador vê o SEU event em "Minhas Tarefas" e finaliza sozinho; o ÚLTIMO a
-- finalizar (cowork_is_last_finisher) faz a contagem de bottles. cowork_with[]
-- segue preenchido (lista os colegas) p/ exibição. Eventos antigos (group_id
-- NULL) seguem com o comportamento de evento único — nada quebra.
-- Idempotente. DOWN: 033_cowork_multi_finish.down.sql
-- ============================================================
BEGIN;

ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS cowork_group_id UUID;
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS cowork_member_finished_at TIMESTAMPTZ;
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS cowork_is_last_finisher BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_events_cowork ON v3.events(cowork_group_id) WHERE cowork_group_id IS NOT NULL;

COMMIT;
