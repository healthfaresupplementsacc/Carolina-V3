ALTER TABLE v3.events DROP COLUMN IF EXISTS other_reviewed_by;
ALTER TABLE v3.events DROP COLUMN IF EXISTS other_reviewed_at;
UPDATE v3.activity_types SET active = false WHERE slug IN ('powder_receiving', 'sieving');
UPDATE v3.activity_types SET display_name = 'Especial / Outros' WHERE slug = 'special_task';
