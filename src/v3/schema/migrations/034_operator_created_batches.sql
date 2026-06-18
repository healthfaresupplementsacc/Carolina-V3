-- 034: lotes auto-criados pelo operador (filosofia "nunca bloqueia o operador").
-- Quando o operador digita um lote que não existe no tracker, o /op AUTO-CRIA o
-- batch e segue o trabalho; o admin revisa depois. Colunas aditivas/nullable.
BEGIN;
ALTER TABLE v3.product_batches
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'pipeline',
  ADD COLUMN IF NOT EXISTS created_by_person_id INT REFERENCES v3.persons(id),
  ADD COLUMN IF NOT EXISTS created_via TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by_person_id INT REFERENCES v3.persons(id);
-- só os não-pipeline interessam ao painel de revisão; índice parcial enxuto
CREATE INDEX IF NOT EXISTS idx_product_batches_origin
  ON v3.product_batches(origin) WHERE origin <> 'pipeline';
COMMIT;
