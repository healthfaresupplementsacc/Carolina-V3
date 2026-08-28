-- 083 — Custo de frete por envio (Bruno 08-28: "o custo eh uma coisa muito seria...
-- tem como eu saber oq o custo ta acima e oq nao ta antes de imprimir? tem como a
-- gente saber quanto gastamos de label por dia vs quantidade de ordens?").
--
-- CONTEXTO: a Veeqo compra etiqueta com data de entrega ANTES do prazo que o
-- cliente pediu (due_date), e o carrier cobra caro por essa pressa que ninguém
-- pediu. Exemplo real de hoje: USPS Ground Advantage <1lb a $7.86 com due_date
-- 7 dias à frente (o normal da faixa é ~$6.09). O estorno da etiqueta NÃO USADA
-- é automático ao deletar o envio na Veeqo (janela de 14 dias), MAS pra USPS
-- morre quando o SCAN form do dia é gerado (~tarde) → o alerta tem que chegar
-- MINUTOS depois da compra, não no fim do dia.
--
-- UMA linha por shipment da Veeqo (allocations[0].shipment). Walmart chega com
-- cost=0 e service vazio (etiqueta deles): fica registrado mas NUNCA entra em
-- média ou mediana. dest_state/dest_zip ficam guardados pra um dia o modelo de
-- faixa aprender zona (v1 é service + faixa de peso, cego a zona de propósito).
--
-- SEM colunas de estoque: frete é observação de custo, não quantidade. Quem
-- escreve quantidade continua sendo só o StockService.
-- Princípio #24: tudo schema-qualificado v3.*.

BEGIN;

CREATE TABLE IF NOT EXISTS v3.shipment_costs (
  shipment_id     BIGINT PRIMARY KEY,
  order_id        BIGINT NULL,
  order_number    TEXT NULL,
  channel         TEXT NULL,
  service         TEXT NULL,
  weight_g        NUMERIC NULL,
  cost            NUMERIC NULL,
  currency        TEXT DEFAULT 'USD',
  bought_at       TIMESTAMPTZ NULL,
  due_date        TIMESTAMPTZ NULL,
  dispatch_date   TIMESTAMPTZ NULL,
  dest_state      TEXT NULL,
  dest_zip        TEXT NULL,
  ny_day          DATE NULL,
  expected_cost   NUMERIC NULL,
  band            TEXT NULL,
  outlier         BOOLEAN NOT NULL DEFAULT false,
  outlier_reason  TEXT NULL,
  alerted_at      TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- "quanto gastamos por dia?" é a pergunta mais feita (summary por ny_day).
CREATE INDEX IF NOT EXISTS idx_shipment_costs_day
  ON v3.shipment_costs (ny_day);

-- "quais os outliers de hoje?" (alerta + card do dashboard).
CREATE INDEX IF NOT EXISTS idx_shipment_costs_outlier_day
  ON v3.shipment_costs (outlier, ny_day);

-- mediana móvel de 30d por faixa (expectedFor) filtra por band + bought_at.
CREATE INDEX IF NOT EXISTS idx_shipment_costs_band_bought
  ON v3.shipment_costs (band, bought_at);

COMMENT ON TABLE v3.shipment_costs IS 'Custo de cada etiqueta de envio comprada na Veeqo. Base do freight-watch (alerta de etiqueta cara antes do SCAN form).';
COMMENT ON COLUMN v3.shipment_costs.expected_cost IS 'Mediana 30d da faixa (service + peso) no momento do julgamento. Nulo = faixa fina demais pra julgar.';

COMMIT;
