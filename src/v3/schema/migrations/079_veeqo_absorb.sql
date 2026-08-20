-- 079 — ABSORÇÃO DA VEEQO: o catálogo inteiro passa a morar aqui (Bruno 08-19).
--
-- A PERGUNTA DO BRUNO, textual:
--   "vc sabe quem sao todos os skus e seus titulos, as imagens do veeqo vc ja
--    associou ao nossos productos no sistema e ja adicionou as imagens dos
--    produtos no nosso sistema tb, tudo do veeqo vc absorveu, se a gente fechar
--    nossa conta do veeqo hj vc vai ter tdas as info que precisamos correto?"
--
-- A resposta HONESTA antes deste migration era NÃO, e foi medida:
--   · v3.product_skus guardava (sku, channel, units_per_pack, barcode, is_base).
--     Nenhuma coluna de TÍTULO. Os 483 SKUs viviam aqui como código puro; o nome
--     da listagem ("Healthfare NAC 1300mg | 120 Capsules | 4 Bottles") só existia
--     na Veeqo.
--   · barcode estava NULL nos 483. A Veeqo tem upc_code em 51 deles.
--   · IMAGEM não existia em lugar nenhum. (ems_activity_cache.product_image é do
--     EMS, outro sistema, outro produto — não serve.)
-- Fechar a conta da Veeqo hoje apagaria todo título de listagem, todo UPC e toda
-- foto de produto que a empresa tem. Este migration é o que muda essa resposta.
--
-- O QUE ENTRA, e por que cada coisa:
--
--   1) v3.product_skus ganha o DESCRITIVO do sellable. Título é por SKU, não por
--      produto: o mesmo NAC 1300mg tem "1 Bottle", "2 Bottles" e "4 Bottles" como
--      listagens diferentes, e é o título DA LISTAGEM que o marketplace mostra e
--      que o operador procura. Guardar só no produto perderia essa distinção.
--
--   2) v3.products ganha image_url + brand — a foto do produto FÍSICO, herdada do
--      SKU base quando o produto não tem a sua. O hub lista produtos, não SKUs;
--      sem isso a página teria que sair caçando um filho com foto a cada render.
--
--   3) v3.veeqo_snapshots — o SEGURO. Payload jsonb com a leitura CRUA e inteira
--      da última varredura bem-sucedida (sellables + products). As colunas acima
--      guardam o que a gente sabe interpretar HOJE; o snapshot guarda também o que
--      ainda não sabemos que vamos precisar (hs_tariff_number, origin_country,
--      channel_products, weight, tags). Se a conta fechar amanhã, esta tabela é o
--      que resta da Veeqo inteira. Mantém as últimas 8 e poda o resto: 8 rodadas
--      de 6h = 2 dias de histórico, o bastante pra perceber um erro e voltar, sem
--      virar depósito de jsonb gigante.
--
--   4) v3.product_images — os BYTES. URL não é posse: veeqo-images.s3... morre
--      junto com a conta. Foto guardada em bytea sobrevive. Teto de ~300KB por
--      imagem (thumb/main de e-commerce cabe folgado); acima disso a linha não é
--      gravada e o URL fica registrado assim mesmo.
--
-- ADITIVO: nenhuma linha existente muda de valor (colunas nascem NULL), nenhum
-- fluxo atual quebra. NADA aqui toca quantidade — StockService continua sendo a
-- porta única de escrita de estoque. Princípio #24: tudo schema-qualificado v3.*.

BEGIN;

-- 1) DESCRITIVO DO SELLABLE ---------------------------------------------------
-- Tudo o que a Veeqo sabe sobre o SKU e a gente não guardava.
ALTER TABLE v3.product_skus ADD COLUMN IF NOT EXISTS title            TEXT;
ALTER TABLE v3.product_skus ADD COLUMN IF NOT EXISTS product_title    TEXT;
ALTER TABLE v3.product_skus ADD COLUMN IF NOT EXISTS brand            TEXT;
-- 'kit' | 'variant' | NULL. Hoje isso só existe em cache de 10 min na memória
-- (veeqo-cache); persistido, sobrevive a restart E ao fim da conta.
ALTER TABLE v3.product_skus ADD COLUMN IF NOT EXISTS veeqo_type       TEXT;
ALTER TABLE v3.product_skus ADD COLUMN IF NOT EXISTS image_url        TEXT;
ALTER TABLE v3.product_skus ADD COLUMN IF NOT EXISTS thumb_url        TEXT;
ALTER TABLE v3.product_skus ADD COLUMN IF NOT EXISTS description      TEXT;
-- id do PRODUTO na Veeqo (o pai do sellable). É a chave que permite reagrupar os
-- SKUs do jeito que a Veeqo agrupava, mesmo depois que a conta não existir mais.
ALTER TABLE v3.product_skus ADD COLUMN IF NOT EXISTS veeqo_product_id BIGINT;
-- last_seen_at: a última vez que este SKU apareceu no catálogo. SKU que sumiu da
-- Veeqo para de ser atualizado mas NÃO é apagado (a garrafa continua na
-- prateleira e o histórico aponta pra ele) — a data é o que denuncia o sumiço.
ALTER TABLE v3.product_skus ADD COLUMN IF NOT EXISTS last_seen_at     TIMESTAMPTZ;
ALTER TABLE v3.product_skus ADD COLUMN IF NOT EXISTS absorbed_at      TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_product_skus_veeqo_product
  ON v3.product_skus (veeqo_product_id) WHERE veeqo_product_id IS NOT NULL;

-- 2) A FOTO DO PRODUTO FÍSICO -------------------------------------------------
ALTER TABLE v3.products ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE v3.products ADD COLUMN IF NOT EXISTS brand     TEXT;

-- 3) O SEGURO: leitura crua e inteira da Veeqo -------------------------------
CREATE TABLE IF NOT EXISTS v3.veeqo_snapshots (
  id        BIGSERIAL PRIMARY KEY,
  taken_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sellables INT,                       -- quantos sellables a varredura viu
  products  INT,                       -- quantos produtos
  payload   JSONB NOT NULL             -- {sellables:[...], products:[...]} cru
);
COMMENT ON TABLE v3.veeqo_snapshots IS
  'Cópia CRUA da última leitura da Veeqo (sellables + products). Seguro contra o '
  'fim da conta: guarda também os campos que ainda não sabemos usar. Mantidos os '
  '8 mais recentes; veeqo-absorb.js poda o resto.';

-- taken_at DESC: toda leitura é "o snapshot mais novo" e toda poda é "tudo fora
-- dos 8 mais novos". As duas percorrem o índice na mesma direção.
CREATE INDEX IF NOT EXISTS idx_veeqo_snapshots_taken
  ON v3.veeqo_snapshots (taken_at DESC);

-- 4) OS BYTES DA IMAGEM -------------------------------------------------------
-- Uma linha por imagem BAIXADA. product_id é quem manda (o hub mostra por
-- produto); sku fica registrado pra saber de qual listagem a foto veio.
-- ON DELETE CASCADE: imagem sem produto não serve pra nada.
CREATE TABLE IF NOT EXISTS v3.product_images (
  id         SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES v3.products(id) ON DELETE CASCADE,
  sku        TEXT,
  mime       TEXT NOT NULL DEFAULT 'image/jpeg',
  bytes      BYTEA NOT NULL,
  source_url TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE v3.product_images IS
  'Bytes da foto do produto, baixados da Veeqo uma vez. URL nao e posse: o link '
  'da S3 da Veeqo morre com a conta. Servido em GET /api/v3/warehouse/image/:id.';

-- UMA foto por produto. O absorb faz UPSERT nesta chave: re-baixar a mesma foto
-- substitui, nunca empilha. (Se um dia precisar de galeria, cai fora daqui.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_images_one_per_product
  ON v3.product_images (product_id);
-- source_url: o absorb pergunta "já tenho ESTE url?" antes de baixar de novo.
CREATE INDEX IF NOT EXISTS idx_product_images_source
  ON v3.product_images (source_url) WHERE source_url IS NOT NULL;

COMMIT;
