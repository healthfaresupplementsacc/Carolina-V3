-- 097 — IMPRESSÃO DE ORDENS É UMA SÓ (09-30).
-- A "2ª Impressão de Ordens" (order_printing_2) nasceu de um costume antigo e no
-- fim das contas é o mesmo trabalho da 1ª: mesma pessoa, mesma tarefa, mesmo
-- resultado. Dois botões só confundiam quem está imprimindo ("clico no primeiro
-- ou no segundo?"). Agora é um só: "Impressão de Ordens".
--
-- HISTÓRICO NÃO SE MEXE (REGRA #0): os 74 eventos antigos de order_printing_2
-- ficam EXATAMENTE como estão — nada é apagado, nada é renomeado. O tipo
-- continua existindo pra eles poderem ser lidos. O que muda é só PRA FRENTE:
-- active = false → desaparece do kiosk e ninguém cria novo.
--
-- MÉTRICA: toda estatística de P&P soma impressão de ordens + empacotamento
-- (counts_as_pp = true nos dois, já era o caso) e trata order_printing_2 como
-- order_printing. Quem lê: ver o comentário em v3.activity_types.
UPDATE v3.activity_types
   SET active = false
 WHERE slug = 'order_printing_2';

-- deixa a regra escrita no banco, pra quem for ler a tabela daqui a seis meses
COMMENT ON COLUMN v3.activity_types.counts_as_pp IS
  'true = entra na estatistica de P&P. P&P = impressao de ordens + empacotamento (mesmo trabalho). 09-30: order_printing_2 foi desativada (botao unico "Impressao de Ordens"); o historico dela PERMANECE e conta como order_printing em qualquer metrica.';
