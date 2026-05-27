-- DOWN — soft (active=false).
BEGIN;
UPDATE v3.activity_types SET active = false WHERE slug = 'material_handling';
COMMIT;
