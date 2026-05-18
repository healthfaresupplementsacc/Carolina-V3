# RESUMO EXECUTIVO — Investigação 18 Mai 2026

Investigação read-only (sem fix, sem mutação). Evidência: `_raw/*.json` (dump de prod do dia) + código com `path:linha`. Detalhe nos docs 01–11.

## 3 maiores descobertas
1. **Existem 4 escritores do mesmo evento, sem reconciliação** (parser-legacy, parser-ISA88, App Home, Carolina), gravando em tabelas diferentes, com 3 lógicas de operador e 2 de fechamento de fase. 1 mensagem do Bruno (09:58) virou **4 phase_instances + 2 tasks + 2 workflow_instances**. (docs 04, 05, 08)
2. **A Carolina detectou as ambiguidades certas e perguntou 19 vezes hoje — e TODAS foram pro `silent_log`** (silent_text=TRUE no canal de produção). Os operadores nunca veem as perguntas → a ambiguidade nunca se resolve. (doc 06)
3. **A identidade do operador é estruturalmente quebrada:** Bruno trabalha o dia todo pela conta `U08JC85HMNE` que o parser mapeia fixo para "Vitor"; "Bruno Sarmento" não existe no banco; `Bruno Camp` tem um DM-id inválido (`D03UL80GDRB`). Trabalho do Bruno é gravado como Vitor/Bruno aleatoriamente. (docs 03, 07, 08)

## 5 bugs mais críticos (causa raiz EVIDENCIADA)
1. **L-08 operador trocado** — `parser/index.js:444` mapeia user-id→nome fixo (só Vitor/Simone); `BRUNO_ALLOWED_ACCOUNTS` contém ids errados; Bruno não cadastrado. Ev.: tasks 487(Bruno)/488(Vitor) mesmo `slack_ts`.
2. **L-06 edição/reprocesso → N rows** — `poller.js:67-72` re-dispatcha edição sem idempotência por `slack_ts`; `findOrCreateWorkflowInstance` chaveia por produto+batch. Ev.: phases 533/534/544/545, wf 453+454.
3. **L-12 Carolina silenciada** — toda `postMessage` no canal cai em `silent_log` (silent_text). Ev.: `_raw/silent_log_today.json` 19 perguntas úteis perdidas.
4. **Modelo duplo sem reconciliação** — legacy `tasks`/`pauses` vs ISA-88 escritos em paralelo; leituras divergentes (board lê tasks, App Home lê ISA-88). Ev.: doc 05.
5. **Descarte silencioso** — separador `_` ("Ana_"), "retorno almoco"→pause_start, "F:"→formulation_start, multi-ação → `unknown`/errado, **sem nota, sem aviso**. Ev.: msgs 12:15, 14:22, 15:10, 15:20 (doc 03). (Phantom "Linha de Produção" já mitigado no deploy 626acdcb, mas as rows de hoje ficaram.)

## Recomendação principal (1 parágrafo)
Não adianta corrigir bug a bug: a raiz é arquitetural — múltiplos escritores sem chave de idempotência nem resolução de operador única. Recomendo **um dispatcher canônico idempotente por `source_id` (slack_ts/wizard/tool)** que parser, App Home e Carolina chamem; `resolveOperator` único no dispatcher com as regras do Bruno (prefixo > contexto 2min > dono da conta por slack_user_id > NULL+pergunta no admin chat); ISA-88 como modelo único (legacy read-only→drop em fases); e "no reaction/confirmation without record". Fazer em 3 fases com legacy em sombra antes de dropar (doc 10).

## Tempo estimado pra resolver tudo
~**2–3 semanas** de trabalho focado (Fase 1 dispatcher único 3–5d; Fase 2 leituras ISA-88 2–3d; Fase 3 migração+drop 3–4d + janelas de validação com o time). **ACHISMO** — depende de quanto parser/App Home mudam.

## Risco de NÃO resolver
Corrupção continua a cada poll (30s) com o time trabalhando: horas/produção/operador errados → folha/relatórios/decisão de chão furados; perda de confiança do time na ferramenta; dado histórico cada dia mais sujo (mais caro de migrar depois); a Carolina vira ruído (pergunta no vazio). Hoje já: ~11 phantoms, ≥6 duplicações de batch 0134, almoço do Bruno não registrado, Rutin fechado pela "F: Limpeza".

## Precisa de decisão do Bruno antes de prosseguir
- Slack user-id REAL do **Bruno Sarmento** e do **Bruno Camp** (o atual é inválido).
- Suplemento canônico: `supplement_catalog` ou `supplements`?
- Perguntas de desambiguação da Carolina podem ir **só pro admin chat** (canal nunca silenciado), mantendo `silent_text=TRUE` no canal de produção?
- Aprovar a abordagem "dispatcher único + ISA-88 + matar legacy em fases" (doc 10) antes de qualquer código.

## Índice
01 comunicação · 02 dados · 03 auditoria msg-a-msg · 04 fontes de evento · 05 modelos duplicados · 06 reaction/silenciamento · 07 auto-check · 08 card duplicado Vitor · 09 App Home "Outro" · 10 arquitetura unificada · 11 pendências/limites. Evidência bruta: `_raw/`.
