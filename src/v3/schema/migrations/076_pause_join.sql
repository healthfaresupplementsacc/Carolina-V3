-- 076 — "VOCÊ ESTAVA NISSO DESDE O COMEÇO?" (entrada tardia numa pausa).
-- Bruno 08-19: "ask at the moment they join to the Pause 'did you work with him
-- from the beginning or started just now to work on it?' and then give them 2
-- options and so you will be able to know and how to address it properly."
--
-- O PROBLEMA (evento 3583, 19/08)
-- Vitor abriu um 'break' 11:18:36 → 12:43:07 com o Bruno Sarmento no cowork. O
-- evento do PRÓPRIO Vitor congelou certo (total_paused_seconds = 5071 = a pausa
-- inteira). Os eventos do Bruno Sarmento (#3575 revisão 09:50→13:05, #3576) NÃO:
-- ficaram com total_paused_seconds = 0, contando 3h de trabalho por cima de uma
-- pausa de 1h24. Duas causas: o freeze rodava só pro STARTER da pausa, e o Bruno
-- foi anexado DEPOIS (admin corrigiu cowork_with às 11:57:53), quando já não havia
-- caminho nenhum que olhasse pausa.
--
-- A DECISÃO
-- Quem entra numa pausa JÁ EM ANDAMENTO tem duas histórias possíveis, e só a
-- pessoa sabe qual é: ou ela estava ali desde o início (e o congelamento vale
-- desde started_at da pausa), ou ela chegou agora (vale de agora). O sistema não
-- adivinha: PERGUNTA, com duas opções, e GRAVA a resposta no evento de pausa dela.
--
--   joined_since = 'inicio'  → congela desde o started_at da pausa
--   joined_since = 'agora'   → congela desde o instante em que entrou
--   joined_since = NULL      → ainda não respondeu (a pergunta fica pendente no
--                              /op e aparece na próxima vez que ela tocar o kiosk)
--
-- RULE #0 — NUNCA BLOQUEIA
-- O caso do 3583 é exatamente o caso em que a pessoa NÃO está no kiosk quando é
-- anexada. Então o evento de pausa dela nasce com joined_since NULL, o sistema
-- assume o CONSERVADOR ('agora', congela do momento em que foi anexada) e diz isso
-- na tela. Se depois ela responder "desde o começo", os números são CORRIGIDOS.
-- Nada trava esperando resposta.
--
-- joined_at guarda o instante real da entrada (que não é started_at do evento
-- quando o admin cria o evento retroativo), pra que a correção posterior saiba
-- exatamente quantos segundos faltam creditar.
--
-- Aditivo: 3 colunas em v3.events, nenhuma tabela nova, nenhum default destrutivo.
-- Só o serviço src/v3/pause/service.js escreve joined_since/joined_at/join_assumed.

BEGIN;

ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS joined_since  TEXT;
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS joined_at     TIMESTAMPTZ;
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS join_assumed  BOOLEAN NOT NULL DEFAULT FALSE;

-- CHECK separado (e não inline) pra ser idempotente: ALTER ... ADD COLUMN IF NOT
-- EXISTS não recria a constraint quando a coluna já existe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_joined_since_chk'
  ) THEN
    ALTER TABLE v3.events
      ADD CONSTRAINT events_joined_since_chk
      CHECK (joined_since IS NULL OR joined_since IN ('inicio', 'agora'));
  END IF;
END $$;

-- índice da PERGUNTA PENDENTE: "pausas em que esta pessoa entrou e ainda não
-- respondeu". Parcial, minúsculo (só linhas sem resposta), lido a cada /op load.
CREATE INDEX IF NOT EXISTS idx_events_pause_join_pending
  ON v3.events(person_id, started_at)
  WHERE joined_since IS NULL AND joined_at IS NOT NULL AND ended_at IS NULL AND deleted_at IS NULL;

COMMENT ON COLUMN v3.events.joined_since IS
  'PAUSA/COWORK: como a pessoa entrou numa pausa já em andamento. inicio = estava desde o started_at da pausa; agora = chegou no instante em que entrou; NULL = ainda não respondeu (pergunta pendente no /op, assume ''agora'' até responder). Escrito só por src/v3/pause/service.js.';
COMMENT ON COLUMN v3.events.joined_at IS
  'PAUSA/COWORK: instante REAL em que a pessoa foi anexada à pausa (≠ started_at quando o admin anexa depois). Base do cálculo de quantos segundos creditar quando ela responde ''desde o começo''.';
COMMENT ON COLUMN v3.events.join_assumed IS
  'PAUSA/COWORK: TRUE enquanto o congelamento usou o padrão conservador ''agora'' sem confirmação humana. Vira FALSE quando a pessoa responde. A tela diz o que foi assumido (RULE #0: nunca bloqueia).';

COMMIT;
