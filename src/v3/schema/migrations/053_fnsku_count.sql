-- 053: FNSKU vira tarefa CONTÁVEL (regra Bruno 06-23).
-- Conta labels colados: production_counts kind='fnsku', unit='label'.
-- 'kind' não tem CHECK (livre). 'unit' tem CHECK → adiciona 'label'. Idempotente.
BEGIN;
ALTER TABLE v3.production_counts DROP CONSTRAINT IF EXISTS production_counts_unit_check;
ALTER TABLE v3.production_counts ADD CONSTRAINT production_counts_unit_check
  CHECK (unit = ANY (ARRAY['bottle'::text, 'box'::text, 'uncertain'::text, 'orders'::text, 'label'::text]));
-- FNSKU usa lote (pra casar contagem por batch). requires_product fica false (a
-- página usa a LISTA de lotes, não o seletor padrão), mas garante flow=production.
UPDATE v3.activity_types SET flow = 'production', active = true WHERE slug = 'fnsku_labeling';
COMMIT;
