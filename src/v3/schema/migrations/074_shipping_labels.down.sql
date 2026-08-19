-- 074 DOWN — desfaz as etiquetas de envio (S15.37).
-- Simétrico da 074: as duas tabelas somem e o CHECK do kind volta aos três
-- valores da 073. Ordem importa: shipping_label_prints e print_files apontam
-- pra print_queue, então caem antes de qualquer coisa mexer nela.
--
-- ATENÇÃO: derrubar isso APAGA o histórico de etiquetas impressas e os PDFs
-- guardados. Só faz sentido em rollback de deploy no mesmo dia, nunca como
-- limpeza (REGRA #0: dado registrado não se joga fora).
-- Se existir algum job kind='shipping_labels' na fila, o CHECK novo o rejeitaria,
-- então esses jobs viram 'picklist' antes (nada some, só muda de rótulo).

BEGIN;

DROP TABLE IF EXISTS v3.shipping_label_prints;
DROP TABLE IF EXISTS v3.print_files;

UPDATE v3.print_queue SET kind = 'picklist' WHERE kind = 'shipping_labels';

ALTER TABLE v3.print_queue DROP CONSTRAINT IF EXISTS print_queue_kind_check;
ALTER TABLE v3.print_queue ADD CONSTRAINT print_queue_kind_check
  CHECK (kind IN ('bin_labels','box_label','picklist'));

COMMIT;
