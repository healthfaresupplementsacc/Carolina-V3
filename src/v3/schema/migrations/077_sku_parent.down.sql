-- 077 DOWN — desfaz o SKU parenting (Bruno 08-19).
--
-- ATENÇÃO: derrubar merged_into_product_id faz TODO produto fantasma voltar a
-- aparecer no hub (as 190+ linhas com duplicata que o merge tinha limpado). Os
-- SKUs NÃO voltam sozinhos pros produtos de origem: quem move SKU é o
-- family-repo (unmerge), não este arquivo. Rode o unmerge dos merges que você
-- quer desfazer ANTES de rodar isso, senão fica produto vazio na tela de novo.
--
-- is_base sumir só volta a base pra dedução (channel='veeqo' e units_per_pack=1);
-- famílias que só tinham kit ficam sem base_sku, como era antes do 077.

BEGIN;

-- 3) SKU base explícito
DROP INDEX IF EXISTS v3.idx_product_skus_one_base;
ALTER TABLE v3.product_skus DROP COLUMN IF EXISTS is_base;

-- 1/2) produto absorvido
DROP INDEX IF EXISTS v3.idx_products_merged_into;
ALTER TABLE v3.products DROP CONSTRAINT IF EXISTS products_merged_not_self;
ALTER TABLE v3.products DROP COLUMN IF EXISTS merged_by_person_id;
ALTER TABLE v3.products DROP COLUMN IF EXISTS merged_at;
ALTER TABLE v3.products DROP COLUMN IF EXISTS merged_into_product_id;

COMMIT;
