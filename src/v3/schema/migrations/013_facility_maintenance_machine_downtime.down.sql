-- DOWN — soft (active=false; não drop pra preservar audit/events).
BEGIN;
UPDATE v3.activity_types SET active = false
WHERE slug IN ('facility_maintenance', 'machine_downtime');
COMMIT;
