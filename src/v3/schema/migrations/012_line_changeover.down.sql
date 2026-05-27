-- DOWN — soft-desativa o tipo (NÃO drop, pode haver events ligados).
BEGIN;
UPDATE v3.activity_types SET active = false WHERE slug = 'line_changeover';
COMMIT;
