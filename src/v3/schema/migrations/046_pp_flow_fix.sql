-- 046: corrige o `flow` dos "Outro (X)".
-- O 024 jogou TODOS os catch-all em support/support (confiando no agrupamento
-- por SLUG na UI da Operator Page), mas o dashboard COLORE e classifica pelo
-- FLOW. Resultado visível: "Outro (Embalagem)" (packaging_other) aparecia como
-- Suporte (cor errada), apesar de já contar como P&P (counts_as_pp=true no 039).
--
-- Regra Bruno: tudo embaixo de "embalagem"/"envio" é P&P; linha e formulação
-- são produção; limpeza continua suporte. Cada _other herda o flow do irmão.
-- `flow` respeita a FK v3.flows(slug) = (pnp|production|support). Idempotente.
BEGIN;
UPDATE v3.activity_types SET flow = 'pnp'
 WHERE slug IN ('packaging_other', 'shipping_other');
UPDATE v3.activity_types SET flow = 'production'
 WHERE slug IN ('production_line_other', 'formulation_other');
-- cleaning_other permanece 'support' (correto — limpeza é suporte).
COMMIT;
