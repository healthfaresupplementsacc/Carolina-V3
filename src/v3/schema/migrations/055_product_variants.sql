-- 055 — Variantes de produto (C2/C6…) ligadas ao produto-pai. (Bruno 06-26)
-- C2 é um produto PRÓPRIO, mas com ligação fácil ao pai, pra sempre vermos que
-- também foi feito C2; buscar o pai mostra as variantes e o sistema oferece
-- calcular juntos. E NADA fica inativo.

ALTER TABLE v3.products ADD COLUMN IF NOT EXISTS parent_product_id INTEGER REFERENCES v3.products(id);
ALTER TABLE v3.products ADD COLUMN IF NOT EXISTS variant_label TEXT;
CREATE INDEX IF NOT EXISTS idx_products_parent ON v3.products(parent_product_id);

-- nada fica inativo
UPDATE v3.products SET active = true WHERE active = false;

-- liga "X - Cn" ao produto pai "X" (mesmo nome sem o sufixo)
UPDATE v3.products c
   SET parent_product_id = par.id,
       variant_label = substring(c.canonical_name from ' - (C[0-9]+)$')
  FROM v3.products par
 WHERE c.canonical_name ~ ' - C[0-9]+$'
   AND par.canonical_name = regexp_replace(c.canonical_name, ' - C[0-9]+$', '')
   AND par.id <> c.id
   AND c.parent_product_id IS NULL;
