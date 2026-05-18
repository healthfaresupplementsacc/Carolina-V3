# Decisão FASE 0 — Carolina, silent_text e admin chat

Status: **DECIDIDO** (Bruno, FASE 0). Implementação: **FASE 1** (não nesta rodada).

## Regra

1. **`silent_text=TRUE` silencia ANÚNCIOS** da Carolina no canal de produção
   (`C09UNBXFRKK`): saudação, EOD, "fulano iniciou X", confirmações de
   rotina, etc. Continuam indo pro `silent_log` (comportamento atual,
   inalterado nesta rodada).

2. **`silent_text` NÃO silencia perguntas de desambiguação.** Quando a
   Carolina precisa de info pra registrar corretamente (ex.: "colocando
   label em qual produto?", "Bruno, que horas saiu?", "qual suplemento
   da revisão?"), isso **não é anúncio** — é necessário pro dado não
   ficar corrompido.

3. **Perguntas de desambiguação vão SEMPRE pro admin chat**
   (`C0B36DR5MP1`), nunca pro canal de produção. O admin chat **não é
   silenciado** (`client.js isAdminChannel` já o isenta de silent_text).
   Assim a ambiguidade é resolvida sem violar a regra do canal de chão.

4. **Reaction emoji continua livre** (✅ etc.) — não é texto, não é
   anúncio; sinaliza "li/registrei". Mantém-se o princípio futuro
   *"no reaction without record"* (Fase 1): só confirma se persistiu.

## Por que (evidência)

`docs/investigacao/06-reaction-sem-persistencia.md`: em 18/05 a Carolina
gerou **19 perguntas corretas** ("qual produto?", "que horas saiu?") e
**todas morreram no `silent_log`** porque eram `postMessage` no canal de
produção com `silent_text=TRUE`. As regras "não falar no canal" e "a
Carolina precisa perguntar pra registrar certo" se anulavam. Esta
decisão separa **anúncio** (silenciável) de **pergunta de
desambiguação** (vai pro admin chat, sempre visível ao Bruno/Thassio/
Henrique).

Nota: o user-id do bot é `U0B3EQLPEPL` (confirmado via `auth.test` na
FASE 0) — corrige o ACHISMO do doc 06: o único ✅ de 18/05 **era** a
Carolina.

## Implementação concreta (FASE 1 — NÃO feito agora)

- No pipeline único (dispatcher), separar dois tipos de saída da Carolina:
  - `announce(...)` → canal de produção, respeita `silent_text`/silent_log.
  - `askDisambiguation(...)` → **sempre** `postToChannel(managerChannelId, ...)`,
    nunca gated por `silent_text`.
- Toda pergunta de desambiguação referencia a row pendente (operador/
  evento) e a resposta do admin volta pelo mesmo dispatcher (idempotente).
- `silent_text` continua valendo para anúncios. **Não muda nesta rodada.**

## Fora de escopo desta decisão
- Não muda `silent_text` agora (segue TRUE).
- Não implementa o split de canais agora (Fase 1).
- Não altera reações nem o parser.
