-- desfaz o 079. Simétrico: tudo o que o 079 criou, e nada além disso.
-- ATENÇÃO: derrubar isto joga fora a ÚNICA cópia local do catálogo da Veeqo
-- (títulos, UPC, fotos em bytea, snapshots). Só desça se for pra subir de novo.
BEGIN;

DROP TABLE IF EXISTS v3.product_images;
DROP TABLE IF EXISTS v3.veeqo_snapshots;

ALTER TABLE v3.products DROP COLUMN IF EXISTS brand;
ALTER TABLE v3.products DROP COLUMN IF EXISTS image_url;

DROP INDEX IF EXISTS v3.idx_product_skus_veeqo_product;
ALTER TABLE v3.product_skus DROP COLUMN IF EXISTS absorbed_at;
ALTER TABLE v3.product_skus DROP COLUMN IF EXISTS last_seen_at;
ALTER TABLE v3.product_skus DROP COLUMN IF EXISTS veeqo_product_id;
ALTER TABLE v3.product_skus DROP COLUMN IF EXISTS description;
ALTER TABLE v3.product_skus DROP COLUMN IF EXISTS thumb_url;
ALTER TABLE v3.product_skus DROP COLUMN IF EXISTS image_url;
ALTER TABLE v3.product_skus DROP COLUMN IF EXISTS veeqo_type;
ALTER TABLE v3.product_skus DROP COLUMN IF EXISTS brand;
ALTER TABLE v3.product_skus DROP COLUMN IF EXISTS product_title;
ALTER TABLE v3.product_skus DROP COLUMN IF EXISTS title;

COMMIT;
