-- 041: FASE 5 — production_counts.product_id NULLABLE.
-- Contagem de ORDENS (P&P/embalagem) não tem produto associado → product_id null.
-- Loosening seguro (linhas existentes têm valor; só orders novos podem ser null).
BEGIN;
ALTER TABLE v3.production_counts ALTER COLUMN product_id DROP NOT NULL;
COMMIT;
