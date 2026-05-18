# 03 — Auditoria mensagem por mensagem (gaps intenção → dado)

Formato por item: **Intenção** (texto cru) → **Entendeu** (parsed_type) → **Gravou** (rows) → **Dashboard** → **GAP**. EVIDENCIADO por ts/ids.

---

### 09:58 — "S-Plant 0134 …- Bruno" (editada de Potassium) · ts 1779112687 · conta U08JC85HMNE
- **Intenção:** Bruno inicia Potassium 0134; corrige p/ Plant Sterols.
- **Entendeu:** `start`. Operador: conta U08JC85HMNE → `resolveNameFromUserId` (parser/index.js:444) = **"Vitor"** (hardcoded), ignora o sufixo "- Bruno".
- **Gravou:** legacy `tasks` **487 (Bruno)** + **488 (Vitor)** — duas linhas, MESMO `slack_start_ts`, operadores diferentes (reprocessamento da edição resolveu diferente). ISA-88: phases **533 (Potassium/Vitor), 545 (Plant/Vitor), 534 (Plant/Vitor closed), 544 (Plant/Bruno open)**; workflows **453 (Potassium) e 454 (Plant)**, mesmo batch 0134. oal 77/78/79.
- **Dashboard:** múltiplos cards Plant/Potassium 0134; starter ora Vitor ora Bruno.
- **GAP:** (a) operador errado (Bruno→Vitor) — L-08; (b) edição cria N rows em vez de UPDATE — L-06; (c) 1 mensagem → 4 phase_instances + 2 tasks + 2 workflows. **Causa:** parser/index.js:444 mapping fixo por user-id; poller.js:67-72 reprocessa edição re-dispatchando; `findOrCreateWorkflowInstance` chaveia por produto+batch (produto mudou → wf novo).

### 10:14 — Simone "S- colocando as label das ordesn nos envelopes" · ts 1779113664
- **Intenção:** Simone segue no P&P (etiquetar envelopes das ordens).
- **Entendeu:** `start`, taskType genérico, sem suplemento, sem hint.
- **Gravou:** phase **537 "Linha de Produção"** (produto NULL), starter Simone, oal 82 dur **4h09** — depois `[fantasma_auto_cleanup]`.
- **Dashboard:** "Simone 🟢 Linha de Produção" (era P&P!).
- **GAP:** P&P virou phantom "Linha de Produção". **Causa:** dispatcher.js:~97-104 default "Linha de Produção" (corrigido após deploy 626acdcb, mas esta row é de antes).

### 12:15 — Ana "Ana_ F: linha de producao do Rutin 0138" · ts 1779120923
- **Intenção:** Ana **finaliza** a linha do Rutin.
- **Entendeu:** `unknown` — separador é `_` (underscore), o regex de prefixo (parser/index.js:~190-193) só aceita `- : ; , /`. Prefixo não casou → mensagem inteira não classificada.
- **Gravou:** **NADA**.
- **Dashboard:** Rutin segue aberto.
- **GAP:** finish real **descartado em silêncio**. O Rutin (task 489) só fechou às 12:45 pelo `slack_end_ts` 1779122749 = mensagem **"ANA- F: LIMPEZA"** (a F: errada fechou o Rutin). **Causa:** separador `_` fora do regex + parser não tem fallback p/ nota + dispatcher fecha "fase aberta mais recente" sem casar o alvo.

### 12:40 — Bruno "S: Iniciando Double Check Rutin e fechando as caixas" · ts 1779122429
- **Intenção:** DUAS ações — double-check do Rutin **e** fechar caixas (P&P).
- **Entendeu:** `start` (uma só).
- **Gravou:** 1 phase genérica.
- **GAP:** 2ª ação perdida; nada pede esclarecimento ao operador (Carolina perguntou, mas silenciado — doc 06). **Causa:** parser 1 tipo por mensagem; sem split multi-ação.

### 12:46 — Ana "ANA- F: LIMPEZA" · ts 1779122749
- **Intenção:** finalizar a **Limpeza**.
- **Entendeu:** `finish`, sem suplemento/hint.
- **Gravou:** fechou a phase **aberta mais recente que casou o template** → fechou indevidamente coisa errada; legacy task 489 (Rutin) `slack_end_ts`=este ts (Rutin fechado pela F de Limpeza). phase 539 (LIMPEZA→Linha Produção fantasma).
- **GAP:** F de "Limpeza" fechou o **Rutin**; "Limpeza" virou phantom "Linha de Produção". **Causa:** dispatcher `findOpenPhaseInstance` casa por template/última aberta, não pela tarefa nomeada; "Limpeza" não vira fase Limpeza.

### 13:41 Simone "Pausa para almoco" → 14:22 Simone "retorno almoco"
- **Intenção:** almoço e volta.
- **Entendeu:** 13:41 `pause_start` (ok). **14:22 `pause_start` de novo** (deveria ser `pause_end`/voltei).
- **Gravou:** pause **63 Simone 13:41→14:23** `ended_reason=auto_new_task` (fechada porque ela mandou "S- revisao Plant" 14:23, não pelo "retorno").
- **GAP:** "retorno almoco" não reconhecido como volta; break só fechou por efeito colateral de uma nova task. **Causa:** parser classifica "retorno almoco" como pausa, não retorno (regex de retorno não cobre "retorno almoco").

### 14:24 — "Bruno - Indo almocar agora" (PC compartilhado) · ts 1779128662
- **Intenção:** Bruno sai pra almoçar.
- **Entendeu:** `pause_start`. Operador via prefixo "Bruno -" + conta U0AU8N8FA00. `resolveOperator`: "Bruno" + conta não em `BRUNO_ALLOWED_ACCOUNTS` → **brunoBlocked** (parser/index.js:435) → operator null.
- **Gravou:** **sem pause vinculada ao Bruno** (não há pause de Bruno entre 14:24; a 68 é "[break não-rastreado]" da **Ana** 15:09). silent_log 55 "hmm Bruno, não registrou…manda as horas".
- **GAP:** break do Bruno não persistido; Carolina pediu horário mas **silenciado**. Bruno "nunca voltou" registrado. **Causa:** L-08 (Bruno bloqueado) + Carolina silenciada (doc 06) + auto-check não disparou (doc 07).

### 15:10 — Bruno "F: Formulacao e revisao parcial Plant (0134)" · ts 1779131420
- **Intenção:** **finalizar** formulação/revisão parcial.
- **Entendeu:** **`formulation_start`** (apesar de "F:").
- **Gravou:** abriu formulação em vez de fechar.
- **GAP:** sentido invertido (start vs finish). **Causa:** parser prioriza palavra "formulacao" sobre o marcador "F:".

### 15:20 — Bruno "Bruno- Retornando a revisao do Plant-0134" (editada) · ts 1779131989
- **Intenção:** Bruno retoma revisão.
- **Entendeu:** `unknown`.
- **Gravou:** NADA.
- **GAP:** retomada perdida. **Causa:** padrão "Retornando a revisao" não casa nenhum tipo; sem fallback p/ nota.

### 15:26 — Simone "S- ajudando na revisao do Plant…" · ts 1779132401
- **Intenção:** Simone ajuda Bruno na revisão (cowork).
- **Entendeu:** `join_producao`.
- **Gravou:** oal 91/95 join; silent_log 60 "🤝 Registrei Simone na Linha de Produção do Plant Sterols com Bruno" (**silenciado**).
- **GAP:** vira "Linha de Produção" join, não "ajudando Bruno na Revisão"; confirmação silenciada. **Causa:** join só na fase Linha de Produção; sem `activity_type='helping'`.

### Notes da Ana (10:36–13:35, "N: linha parada / label / ligando")
- **Entendeu:** `note` (a maioria) — exceto "Ana_" (unknown).
- **Gravou:** notes? `operator_notes` hoje tem **só 1 linha** (id 2, do App Home). As notes do parser **não aparecem em `operator_notes`** — vão pra outro lugar (engine.addNote linka a phase/wf; ver doc 06) e/ou silenciadas. **GAP/ACHISMO:** persistência de note do parser não confirmada em `operator_notes`; precisa rastrear `engine.addNote` (doc 06).

---
## Padrões de GAP recorrentes (EVIDENCIADO)
1. **Operador errado** por user-id fixo (Bruno↔Vitor): L-08.
2. **Edição → N rows** em vez de UPDATE: L-06.
3. **Default phantom "Linha de Produção"** p/ start sem contexto (corrigido em 626acdcb).
4. **Separador `_` e variações** → `unknown` → descarte silencioso.
5. **"F:"/"retorno"/multi-ação** mal classificados (sentido invertido / perdido).
6. **Carolina pergunta o que falta, mas tudo vai pro silent_log** (operador nunca vê) → ambiguidade nunca resolvida.
