-- desfaz o 080. ATENCAO: so roda se nenhum source passar de 20 chars,
-- senao o Postgres recusa (e recusar e o certo — voltar truncaria dado).
BEGIN;
ALTER TABLE v3.events ALTER COLUMN source TYPE VARCHAR(20);
COMMIT;
