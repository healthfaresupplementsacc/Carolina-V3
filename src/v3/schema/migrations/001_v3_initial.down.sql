-- ============================================================
-- HEALTHFARE V3 — Migration 001: schema inicial (DOWN)
-- ============================================================
-- Sprint 1 / FASE 1 / PARTE 1.2  (Opção B — namespace dedicado)
-- Reverte integralmente 001_v3_initial.sql.
--
-- Com o schema dedicado `v3`, o DOWN é trivial: DROP SCHEMA
-- CASCADE remove de uma vez as 17 tabelas + índices + COMMENTs
-- + FKs + self-FKs. Não precisa de ordem reversa manual.
--
-- IF EXISTS: idempotente — requisito do teste DOWN → UP → DOWN.
-- NÃO toca nada em `public` (legado intacto).
-- Transação única.
--
-- AINDA NÃO EXECUTADA contra o DB — apenas o arquivo.
-- ============================================================

BEGIN;

DROP SCHEMA IF EXISTS v3 CASCADE;

COMMIT;

-- ============================================================
-- FIM — schema v3 removido. Legado em public intacto.
-- ============================================================
