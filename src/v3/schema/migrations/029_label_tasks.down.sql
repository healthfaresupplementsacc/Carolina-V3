-- Reverte 029. Remove os 2 task types de label (seguro enquanto nenhum
-- event os referencia; senão o DELETE falha — não some com tipo em uso).
DELETE FROM v3.activity_types WHERE slug IN ('label_change', 'label_repair');
