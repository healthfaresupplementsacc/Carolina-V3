-- ============================================================
-- HEALTHFARE V3 — Migration 001: schema inicial (DOWN)
-- ============================================================
-- Sprint 1 / FASE 1 / PARTE 1.2
-- Reverte integralmente 001_v3_initial.sql.
--
-- Dropa as 17 tabelas V3 em ORDEM REVERSA de FK (filhos antes
-- de pais) — assim nenhum DROP esbarra numa FK ainda existente.
-- Índices, constraints, COMMENTs e self-FKs (persons.deleted_by,
-- production_counts.superseded_by) caem junto com a tabela.
--
-- IF EXISTS: torna o DOWN idempotente e seguro mesmo sobre um
-- schema parcial — requisito do teste DOWN → UP → DOWN.
--
-- NÃO toca nenhuma tabela legada.
-- Transação única — falha em qualquer DROP → ROLLBACK total.
--
-- AINDA NÃO EXECUTADA contra o DB — apenas o arquivo.
-- Execução prevista: psql "$DATABASE_URL" -f 001_v3_initial.down.sql
-- ============================================================

BEGIN;

-- Ordem reversa da criação (17 → 1):
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS person_language_profile;
DROP TABLE IF EXISTS vocabulary;
DROP TABLE IF EXISTS llm_corrections;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS proposals;
DROP TABLE IF EXISTS admin_chats;
DROP TABLE IF EXISTS prefix_resolution_log;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS production_counts;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS product_batches;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS activity_types;
DROP TABLE IF EXISTS shared_account_users;
DROP TABLE IF EXISTS shared_accounts;
DROP TABLE IF EXISTS persons;

COMMIT;

-- ============================================================
-- FIM — 17 tabelas removidas. Schema V3 zerado, legado intacto.
-- ============================================================
