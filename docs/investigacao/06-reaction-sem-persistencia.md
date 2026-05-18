# 06 — Carolina reaction / resposta sem persistência (BUG L-12 focal)

## 6.1 Mensagens com reaction da Carolina hoje
**EVIDENCIADO:** varrendo `_raw/messages_today.json`, **só 1** mensagem teve reaction o dia inteiro: ts `1779112687` (`white_check_mark`, `users:["U0B3EQLPEPL"]`). `U0B3EQLPEPL` **não é a Carolina** (bot = `U09DQGJ1ES3` em `config.slack.bryceUserId`). **Carolina não reagiu (✅) a nada hoje.**

## 6.2 As respostas da Carolina existem — mas vão TODAS pro silent_log
**EVIDENCIADO** (`_raw/silent_log_today.json`, 19 linhas, todas `kind='text'`, `intended_channel=C09UNBXFRKK`):
- 44 "oi gente bom dia", 45 "Vitor você está junto com Simone nas ordens?", 46 "as ordens ja foram concluidas?", 47/48 "a Plant Sterols ainda está no ar. Terminou?", 49 "Simone, colocando label em qual produto?", 50 "Ana, a Rutin não foi encerrada", 52 "📝 nota do Vitor — Ajuda no packing", 53 "Vitor revisando qual suplemento?", 55 "hmm Bruno, não registrou… manda as horas", 56/59/60 cowork, 58 "ué Ana, não vi vc sair", 61/62…

Ou seja: a Carolina **detectou as ambiguidades certas e perguntou** ("qual produto?", "qual suplemento?", "que horas saiu?") — **mas com `silent_text=TRUE` toda postagem no canal de produção é suprimida** (`client.js:134` `postMessage` → `isSilent('text')` → `logSilent`). O operador **nunca vê** a pergunta → o dado fica ambíguo pra sempre.

## 6.3 Ponto de código
- Reaction: `slack/client.js:223 addReaction` → `if (await isSilent('reactions')) { logSilent(...,'reaction'); return }`. Hoje **0 linhas `kind='reaction'`** em silent_log → addReaction não foi chamada ou não logou; combinado com 0 ✅ da Carolina nas mensagens. **ACHISMO:** estado de `silent_reactions` (não inspecionei `app_state`); **EVIDENCIADO:** Carolina não confirmou nada visualmente.
- Persistência ≠ reaction: o ✅ (legacy) é emitido em `poller.js:137/156/167/177/227` **após** o handler legacy aceitar — mas é **independente** de a row ISA-88 ter sido criada. Não existe princípio "no reaction without record": a reaction (quando sai) confirma o **parse legacy**, não a persistência no modelo final.
- "Reage mas não persiste" acontece quando: parser classifica algo (✅ legacy) mas (a) silent gate engole, e/ou (b) dispatcher ISA-88 falha/!dispatched (`safeDispatch` engole erro) → operador "vê ✅" e acha que registrou, mas ISA-88 não tem nada. Hoje, com silent_text, nem o ✅ aparece — pior: **silêncio total**, operador sem feedback nenhum.

## 6.4 Conclusão L-12
O bug não é "reaction sem persistência" isolado; é **três camadas**:
1. `silent_text=TRUE` mata TODA comunicação da Carolina no canal (perguntas que resolveriam a ambiguidade) → 19 mensagens úteis perdidas hoje.
2. Reaction não é vinculada a uma row (confirma parse, não persistência).
3. Quando dispatcher ISA-88 não persiste (erro engolido por `safeDispatch`), não há sinal nenhum.
**Decisão do Bruno necessária:** manter `silent_text=TRUE` (regra dada) **vs** a Carolina precisar falar no canal pra fechar ambiguidade. Hoje as duas coisas se anulam.
