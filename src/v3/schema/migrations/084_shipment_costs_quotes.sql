-- 084 — Cotação do copiloto de frete (FASE A do S15-VEEQO-LABEL-API-STUDY,
-- Bruno deu o go). O alerta antigo mandava "deleta e recompra" sem saber se
-- existia opção mais barata; medido em 8/8 outliers recentes, o pago JÁ ERA o
-- mais barato válido (objeção do Bruno: "vc vai ficar mandando td mundo
-- deletar, e se nao tiver opcao e essa eh a unica opcao oferecida no veeqo?").
-- Agora o freight-watch COTA (Rate Shopping API, read-only) antes de
-- aconselhar e guarda o resultado na própria linha da etiqueta:
--   quoted_best_cost    — a mais barata VÁLIDA (nunca Media Mail/Bound
--                         Printed/Library: restritas a livros, suplemento não
--                         pode) que chega no due_date quando dá
--   quoted_best_service — o nome do serviço dessa cotação
--   quoted_valid_count  — quantas cotações válidas a Veeqo devolveu
--   quoted_at           — quando cotou (NULL = ainda sem cotação)
-- SEM colunas de quantidade: frete continua observação de custo, nunca estoque.
-- Princípio #24: tudo schema-qualificado v3.*.

BEGIN;

ALTER TABLE v3.shipment_costs
  ADD COLUMN IF NOT EXISTS quoted_best_cost    NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS quoted_best_service TEXT NULL,
  ADD COLUMN IF NOT EXISTS quoted_valid_count  INT NULL,
  ADD COLUMN IF NOT EXISTS quoted_at           TIMESTAMPTZ NULL;

COMMENT ON COLUMN v3.shipment_costs.quoted_best_cost IS 'Melhor cotação VÁLIDA (sem Media Mail/Bound Printed/Library) no momento da compra. Fase A: só conselho, nada compra.';
COMMENT ON COLUMN v3.shipment_costs.quoted_at IS 'Quando o copiloto cotou. NULL = sem cotação (falha ou ainda na fila do tick).';

COMMIT;
