-- 075 DOWN — desfaz as preferências por conta. Simétrico ao 075: derruba SÓ o
-- que o 075 criou.
--
-- ATENÇÃO: derrubar v3.user_prefs apaga o layout da página Hoje (e qualquer outra
-- preferência salva na conta) de TODO MUNDO. Ninguém perde acesso a nada — as
-- páginas voltam ao padrão de fábrica e o navegador ainda tem a cópia local —
-- mas o ajuste de cada pessoa se perde. Não roda isso com o sistema em uso.

BEGIN;

DROP TABLE IF EXISTS v3.user_prefs;

COMMIT;
