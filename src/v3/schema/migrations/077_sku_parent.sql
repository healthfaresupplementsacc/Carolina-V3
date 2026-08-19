-- 077 — SKU PARENTING: uma linha por produto FÍSICO (Bruno 08-19).
--
-- A regra do Bruno, repetida mais de uma vez (memória 'sku-parent-single-unit',
-- Obsidian §9.10): casepack (-C2/-C3/-C4, "x3 kit", "Beet Root 2000mg - C4") é
-- SKU diferente na Veeqo e nos marketplaces, mas FISICAMENTE não existe. Toda
-- garrafa fica solta no mesmo lugar da unidade avulsa; o operador junta o pacote
-- só na hora de embalar o pedido. Logo o estoque conta UNIDADES sob o SKU PAI:
-- uma linha por produto físico, o local pertence ao pai.
--
-- O modelo já estava certo: v3.product_skus.product_id É o pai e units_per_pack>1
-- marca o casepack. O que faltava era o DEPOIS do merge. Hoje o merge move os
-- SKUs e deixa o produto esvaziado como FANTASMA no hub (print do Bruno:
-- 'AKKERM-INULIN' duas vezes, 'Apple Cider Vinegar' só com um SKU "x4 kit",
-- 'Banaba Leaf 3000mg' sem SKU nenhum, 190+ linhas). O hub lista v3.products,
-- não SKUs: uma listagem da Veeqo que ganhou linha própria fica lá pra sempre.
--
-- Este migration adiciona o que fecha isso:
--
--   1) v3.products.merged_into_product_id — o produto foi ABSORVIDO por outro.
--      RETIRAR, NUNCA APAGAR: a linha continua existindo (movimentos, batches,
--      pedidos e auditoria antigos apontam pra ela e não podem virar órfãos), só
--      sai das leituras. Um lugar só pra filtrar em TODO caminho de leitura, e
--      reversível: limpar a coluna traz o produto de volta inteiro.
--
--   2) v3.products.merged_at / merged_by_person_id — quando e quem. Merge errado
--      é desastre de expedição (memória 'merge-safety-rules'); o rastro tem que
--      estar na própria linha, não só no audit_log.
--
--   3) v3.product_skus.is_base — qual SKU é a garrafa avulsa da família, EXPLÍCITO.
--      Hoje a base é deduzida por (channel='veeqo' AND units_per_pack=1), o que
--      falha exatamente no caso do print: 'Apple Cider Vinegar' só tem o "x4 kit",
--      então units_per_pack=1 não existe e o produto fica sem base_sku pra sempre.
--      Com a coluna, o humano marca a base quando a dedução não dá.
--
-- Aditivo: nenhuma linha existente muda de valor (as colunas nascem NULL/false),
-- nenhum fluxo atual quebra. Princípio #24: tudo schema-qualificado v3.*.

BEGIN;

-- 1/2) produto ABSORVIDO por outro ---------------------------------------------
-- Auto-referência: o pai é outro v3.products. ON DELETE SET NULL porque apagar
-- um pai (coisa que a gente não faz) nunca pode deixar filhos apontando pro nada.
ALTER TABLE v3.products
  ADD COLUMN IF NOT EXISTS merged_into_product_id INT
    REFERENCES v3.products(id) ON DELETE SET NULL;
ALTER TABLE v3.products ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
ALTER TABLE v3.products ADD COLUMN IF NOT EXISTS merged_by_person_id INT
  REFERENCES v3.persons(id);

-- Um produto não pode ser absorvido por ele mesmo (loop de 1 salto). Cadeias
-- maiores são barradas na aplicação (family-repo resolve a raiz antes de gravar).
ALTER TABLE v3.products DROP CONSTRAINT IF EXISTS products_merged_not_self;
ALTER TABLE v3.products ADD CONSTRAINT products_merged_not_self
  CHECK (merged_into_product_id IS NULL OR merged_into_product_id <> id);

-- Toda leitura do hub filtra "merged_into_product_id IS NULL". Índice parcial:
-- o que interessa é a lista dos VIVOS, que é quase a tabela inteira menos os
-- fantasmas. O índice pelo pai serve pro unmerge e pra mostrar "3 absorvidos".
CREATE INDEX IF NOT EXISTS idx_products_merged_into
  ON v3.products (merged_into_product_id) WHERE merged_into_product_id IS NOT NULL;

-- 3) SKU base explícito --------------------------------------------------------
-- units_per_pack=1 continua sendo a dedução padrão; is_base é o override humano
-- pra família que só tem kit (o caso 'Apple Cider Vinegar' do print).
ALTER TABLE v3.product_skus ADD COLUMN IF NOT EXISTS is_base BOOLEAN NOT NULL DEFAULT false;

-- No máximo UMA base por produto. Índice único parcial: sem isso duas bases
-- fazem o total do produto ser lido de dois SKUs diferentes conforme a ordenação
-- da query, que é o tipo de bug que só aparece em produção.
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_skus_one_base
  ON v3.product_skus (product_id) WHERE is_base;

COMMIT;
