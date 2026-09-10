-- 085 — FASE B do copiloto de frete: COMPRA de etiqueta pelo sistema (S15.54,
-- estudo S15-VEEQO-LABEL-API-STUDY, construído DARK atrás de FREIGHT_BUY_ENABLED).
--
-- A Fase A só olhava; a Fase B compra: cota na hora, escolhe a mais barata
-- VÁLIDA que chega no due_date, compra na Rate Shopping API, marca enviado na
-- Veeqo (update_remote_order) e SÓ ENTÃO enfileira a impressão. A trilha
-- inteira dessa compra precisa morar na MESMA linha de v3.shipment_costs que o
-- freight-watch já usa — uma etiqueta, uma linha, comprada por nós ou pela UI
-- da Veeqo (o watch reencontra o shipment depois e faz upsert POR CIMA com
-- COALESCE, então nada aqui é sobrescrito).
--
--   tracking_number    — o tracking devolvido pela compra (a chave da
--                        idempotência: pedido com tracking JÁ COMPRADO nunca é
--                        recomprado)
--   carrier_name       — o carrier da tarifa comprada, como veio da API
--   bought_via         — 'system' quando NÓS compramos; NULL = comprada na UI
--                        da Veeqo (linhas do watch)
--   rate_id            — o rate_id da cotação efetivamente comprada
--   label_file_id      — o PDF da etiqueta em v3.print_files (o MESMO cofre do
--                        fluxo de composição S15.37: sobrevive a redeploy)
--   marked_shipped_at  — quando a Veeqo CONFIRMOU o enviado (invariante do
--                        Bruno: nunca imprimir antes disso)
--   mark_shipped_error — o último erro quando o mark-shipped falhou (3
--                        tentativas; com falha vira incidente e NÃO imprime)
--
-- Índice por order_id: a pergunta da idempotência ("esse pedido já tem
-- etiqueta comprada?") é por pedido, não por shipment.
--
-- SEM colunas de quantidade: frete segue observação de custo, nunca estoque.
-- Quem escreve quantidade continua sendo só o StockService.
-- Princípio #24: tudo schema-qualificado v3.*.

BEGIN;

ALTER TABLE v3.shipment_costs
  ADD COLUMN IF NOT EXISTS tracking_number    TEXT NULL,
  ADD COLUMN IF NOT EXISTS carrier_name       TEXT NULL,
  ADD COLUMN IF NOT EXISTS bought_via         TEXT NULL,
  ADD COLUMN IF NOT EXISTS rate_id            TEXT NULL,
  ADD COLUMN IF NOT EXISTS label_file_id      INT NULL REFERENCES v3.print_files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS marked_shipped_at  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS mark_shipped_error TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_shipment_costs_order
  ON v3.shipment_costs (order_id);

COMMENT ON COLUMN v3.shipment_costs.bought_via IS 'system = etiqueta comprada pelo nosso sistema (Fase B); NULL = comprada na UI da Veeqo.';
COMMENT ON COLUMN v3.shipment_costs.marked_shipped_at IS 'Quando a Veeqo confirmou o enviado. Invariante: imprimir SÓ depois disso.';

COMMIT;
