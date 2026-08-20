-- 078 — TODO SKU da Veeqo tem que existir aqui (Bruno 08-19).
--
-- "todos os SKUs do Veeqo tem que ser registrado no nosso sistema, pq se a gente
--  manage o inventory temos que saber q produto eh, e toda a identificacao dele...
--  ja pensou vende um la no ebay e a gente mostra como se nao tivesse em stock
--  sendo q o sku do walmart tem mais de 1000 aqui no warehouse"
--
-- O problema que isso resolve: SKU que nao esta em v3.product_skus nao resolve
-- pra produto nenhum. O pedido cai na fila sem saber o que separar, e um SKU
-- irmao (mesma garrafa, outro marketplace) pode ter 1000 unidades no armazem.
-- Deixar de fora NAO e mais barato que registrar: e uma venda perdida.
--
-- A saida NAO e filtrar SKU: e registrar TUDO e classificar. `kind` diz o que a
-- coisa e; so 'bottle' conta como estoque fisico da linha. Servico, plano da
-- clinica, medicacao e insumo ficam registrados (o pedido resolve, a picklist
-- sabe o nome) mas nao poluem o estoque de garrafas.

BEGIN;

ALTER TABLE v3.products ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'bottle';

ALTER TABLE v3.products DROP CONSTRAINT IF EXISTS products_kind_check;
ALTER TABLE v3.products ADD CONSTRAINT products_kind_check
  CHECK (kind IN ('bottle','service','plan','medication','supply','other'));

COMMENT ON COLUMN v3.products.kind IS
  'bottle = garrafa da linha (conta no estoque). service/plan = clinica e assinatura. medication = manipulado. supply = insumo (envelope, bandeja). other = nao classificado. Só bottle entra no hub de estoque; o resto fica registrado pra identificar o pedido.';

-- Consulta do hub: só garrafa, só nao-aposentado.
CREATE INDEX IF NOT EXISTS idx_products_kind_active
  ON v3.products (kind) WHERE merged_into_product_id IS NULL;

COMMIT;
