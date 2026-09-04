-- down 086 — remove o plano de produção (quadro é derivado, nada mais a desfazer)
BEGIN;
DROP TABLE IF EXISTS v3.planning_notes;
DROP TABLE IF EXISTS v3.production_plan_items;
COMMIT;
