-- 048: Operadores de máquina + handoff de background no almoço/pausa (regra Bruno 06-22).
-- Operadores de máquina (Bruno, Vitor) tocam encapsulação/tablete/mistura/formulação
-- (background, "na máquina"). Quando um vai pro almoço/pausa, as máquinas dele passam
-- pro próximo operador de máquina disponível; quando volta, voltam pra ele.
BEGIN;
ALTER TABLE v3.persons
  ADD COLUMN IF NOT EXISTS is_machine_operator boolean NOT NULL DEFAULT false;

-- Quando uma task de background é PASSADA pra outro operador (almoço/pausa),
-- guarda o DONO ORIGINAL aqui e o person_id vira o RESPONSÁVEL ATUAL. Ao voltar,
-- o dono recupera só as que eram dele (bg_handoff_from_person_id = ele). NULL = sem handoff.
ALTER TABLE v3.events
  ADD COLUMN IF NOT EXISTS bg_handoff_from_person_id int REFERENCES v3.persons(id);
CREATE INDEX IF NOT EXISTS idx_events_bg_handoff_from ON v3.events (bg_handoff_from_person_id) WHERE bg_handoff_from_person_id IS NOT NULL;

-- Bruno Sarmento e Vitor = operadores de máquina.
UPDATE v3.persons SET is_machine_operator = true
 WHERE display_name IN ('Bruno Sarmento', 'Vitor') AND role = 'operator' AND COALESCE(is_sandbox, false) = false;
COMMIT;
