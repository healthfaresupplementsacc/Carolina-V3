-- DOWN — DROP tabela. Irreversível pra dados, mas a tabela é
-- só staging pra confirmações pendentes — perda aceitável.
BEGIN;
DROP TABLE IF EXISTS v3.pending_commands;
COMMIT;
