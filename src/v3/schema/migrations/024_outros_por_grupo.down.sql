-- Reverte 024. Remove os 5 task types "outro". Seguro enquanto nenhum
-- event referencia esses activity_type_id (FK events.activity_type_id);
-- se já houver uso, o DELETE falha — comportamento correto (não some
-- com tipo em uso). Alternativa não-destrutiva: SET active=false.
DELETE FROM v3.activity_types
 WHERE slug IN ('production_line_other', 'formulation_other', 'cleaning_other', 'packaging_other', 'shipping_other');
