-- 076 DOWN — desfaz a pergunta "você estava nisso desde o começo?".
-- Simétrico ao 076: derruba SÓ o que o 076 criou (3 colunas, 1 CHECK, 1 índice).
--
-- ATENÇÃO: derrubar joined_since/joined_at apaga a RESPOSTA HUMANA de quem entrou
-- tarde numa pausa. Os números já corrigidos em total_paused_seconds FICAM (são
-- outra coluna, do 043), mas a justificativa de POR QUE aquele desconto tem aquele
-- tamanho se perde, e a pergunta pendente de quem ainda não respondeu some sem
-- ter sido feita. Não roda isso com o sistema em uso.

BEGIN;

DROP INDEX IF EXISTS v3.idx_events_pause_join_pending;

ALTER TABLE v3.events DROP CONSTRAINT IF EXISTS events_joined_since_chk;

ALTER TABLE v3.events DROP COLUMN IF EXISTS join_assumed;
ALTER TABLE v3.events DROP COLUMN IF EXISTS joined_at;
ALTER TABLE v3.events DROP COLUMN IF EXISTS joined_since;

COMMIT;
