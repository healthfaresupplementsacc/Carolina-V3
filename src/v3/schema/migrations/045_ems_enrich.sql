-- 045: enriquecimento EMS — estimated bottles + cápsulas/frasco no lote, e log de
-- limpeza das máquinas (sincroniza /line.last_cleaning). "Não deixar nada escapar".
BEGIN;
-- estimated bottles (target) + units_per_bottle (cápsulas/tablets por frasco) no lote
ALTER TABLE v3.product_batches ADD COLUMN IF NOT EXISTS target_bottles INT;
ALTER TABLE v3.product_batches ADD COLUMN IF NOT EXISTS units_per_bottle INT;
COMMENT ON COLUMN v3.product_batches.target_bottles IS 'EMS target_qty_bottles — frascos planejados (estimated bottles).';
COMMENT ON COLUMN v3.product_batches.units_per_bottle IS 'EMS formula.units_per_bottle — cápsulas/tablets por frasco (p/ taxa de revisão).';

-- log de limpeza de máquina (espelho do /line.last_cleaning; idempotente por log_number)
CREATE TABLE IF NOT EXISTS v3.ems_cleaning_log (
  id                 BIGSERIAL PRIMARY KEY,
  log_number         TEXT UNIQUE,
  machine            TEXT,
  machine_type       TEXT,
  cleaning_type      TEXT,
  cleaning_method    TEXT,
  cleaned_by_name    TEXT,
  tracker_person_id  INT REFERENCES v3.persons(id),
  cleaned_at         TIMESTAMPTZ,
  status             TEXT,
  inspection_result  TEXT,
  previous_formula   TEXT,
  raw_json           JSONB,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cleaning_machine ON v3.ems_cleaning_log(machine, cleaned_at DESC);
CREATE INDEX IF NOT EXISTS idx_cleaning_person ON v3.ems_cleaning_log(tracker_person_id, cleaned_at DESC);
COMMIT;
