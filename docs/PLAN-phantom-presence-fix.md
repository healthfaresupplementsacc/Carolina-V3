# Plano — Corrigir "phantom presence" (EMS atribui tarefa a quem não está trabalhando)

## O que aconteceu hoje (18/07) — causa-raiz confirmada
1. **ev2346** "Bruno Sarmento · Pesagem", `source=ems_auto`, 10:52–11:16, batch BR-2026-0278.
   O EMS reportou uma pesagem com `operator.name`/`ems_user_id` = Bruno. O worker
   `ems-activity-sync.js` (`_resolvePersonId` → `_autoCheckin`) confiou e criou o evento.
   **Bruno NÃO tem nenhum login manual hoje** — ele não está trabalhando. Vitor é quem
   fez a formulação desse lote (ev2345 encapsulação, ev2347 mix — mesmo batch, minutos depois).
2. Como ev2346 existe, `findMachineRecv` (op.js:991-992) considera Bruno "presente"
   (**tem evento hoje**) e elegível a receber máquina. No almoço do Vitor (14:09) a
   encapsulação foi passada pro Bruno (ev2354, aberto) — máquina rodando sob alguém ausente.
3. O worker `absence-alert.js` mandou "Bruno sem função há 10/30/50/60 min" + checkout auto.

**JÁ CORRIGIDO (dados de hoje):** ev2346 + ev2354 reatribuídos Bruno→Vitor, audit-logged.
Bruno #7 não tem mais nada aberto; a máquina voltou pro Vitor. Sangria estancada.

## Comportamento desejado (decisões do Bruno)
- **Guard na fonte:** EMS pode criar a task de quem não logou hoje, MAS ela nasce
  **`unconfirmed`** (fica com o nome da pessoa) e essa pessoa **não conta como
  "presente"** pra handoff/idle/absence enquanto não confirmar.
- **Escalonamento (sem check-in do "dono"):** se a pessoa da task unconfirmed **não
  fizer check-in em 1h30**, a task vira "questionável". Aí, **a próxima vez que
  QUALQUER funcionário logar na página de check-in**, ele é perguntado:
  - **Adjacência** (o que logou trabalhou o MESMO lote perto no tempo): *"A pesagem
    do [suplemento] (lote X) foi VOCÊ ou o Bruno?"* → [FUI EU] [FOI O BRUNO] [OUTRO: explicar].
  - **Presença** (fallback geral): *"O Bruno está trabalhando hoje?"* → [SIM] [NÃO] [OUTRO].
  - Se o primeiro perguntado não sabe/não responde ("não sei"), **continua perguntando
    cada funcionário que logar** até alguém responder.
- **Resposta é autoritativa:**
  - "FUI EU" / "OUTRO=fulano" → a task **move pra quem respondeu** (ou pro indicado).
  - "FOI O BRUNO" / "Bruno SIM trabalha" → confirma a task no Bruno (vira confirmada).
  - "Bruno NÃO trabalha hoje" → move a(s) task(s) unconfirmed do Bruno pro operador de
    formulação real. Se **só há UM outro operador de formulação** (ex.: Vitor) → move
    automático pra ele. Se há mais de um → pergunta/【já será resolvido pela adjacência】.
- **Sempre explicar no Slack** (voz da Carolina/sistema, tom gentil), ex.:
  > O sistema registrou que o Bruno Sarmento fez a pesagem mais cedo hoje, porém foi o
  > Vitor. Achei por engano que o Bruno estava trabalhando agora. Obrigado, Vitor, por
  > avisar. Já ajustei todas as tarefas de hoje pra ficarem corretas.

## Implementação

### A. Guard no worker EMS (`src/workers/ems-activity-sync.js`)
- Em `_autoCheckin`, ao criar a task: detectar se `tracker_person_id` **tem login hoje**
  (`operator_sessions` com created hoje) OU já tem evento manual hoje. Se **não**:
  - criar o evento normalmente MAS marcar **`confidence='low'`** + descrição
    `[EMS auto — não confirmado: <pessoa> não fez check-in hoje]`;
  - gravar uma linha em nova tabela **`v3.ems_unconfirmed`** (ou settings) com
    `{event_id, person_id, ems_key, batch_number, stage, product_name, since}`.
- Isso NÃO bloqueia (REGRA #0) — só marca.

### B. "Presente" passa a ignorar unconfirmed
- `findMachineRecv` (op.js:984) e o gate de `anyonePresent` (alert-gate.js) + a checagem
  do `absence-alert`: **desconsiderar eventos `ems_auto` com `confidence='low'`
  não-confirmados** ao decidir "tem evento hoje / está presente". Ou seja: um phantom
  não torna ninguém elegível a handoff, nem "presente" pra parar de perguntar, nem alvo
  do alarme de ausência.
  - Implementação limpa: um predicado SQL reutilizável `is_confirmed_presence(person)`:
    tem sessão hoje OU evento hoje que NÃO seja ems_auto-unconfirmed.

### C. Escalonamento 1h30 (worker)
- Um tick (reusar o `absence-alert` ou o ems-sync) marca as linhas `ems_unconfirmed`
  cujo `since` > 90min e cujo dono ainda não logou → `status='questionable'`.

### D. Pergunta na página de check-in (op.js + src/op/app.js)
- Novo GET **`/api/v3/op/pending-confirmations`** (requireSession): retorna, pro operador
  logado, a próxima pergunta pendente (se houver), no formato:
  `{ kind: 'adjacency'|'presence', unconfirmed_event_id, subject_person:{id,name},
     batch_number, product_name, stage, options:[...] }`.
  - **adjacency** só quando o operador logado tem um evento MANUAL no MESMO batch dentro
    de ~30min do evento unconfirmed. Senão **presence**.
- Novo POST **`/api/v3/op/pending-confirmations/answer`**:
  `{ unconfirmed_event_id, answer: 'me'|'subject'|'not_working'|'other', other_person_id?, note? }`
  - `me` → reatribui o evento pro `s.person_id`; confirma; Slack.
  - `subject` / presence `yes` → confirma no dono (limpa unconfirmed); sem Slack (estava certo).
  - `not_working` → move TODAS as unconfirmed do dono hoje pro operador de formulação real
    (auto se só houver um; senão usa a resposta); fecha/ajusta handoffs derivados; Slack.
  - `other` → move pro `other_person_id`; Slack.
  - "não sei" (skip) → não resolve; fica pro próximo que logar (não repergunta pra quem
    já disse "não sei" nesse dia — guarda skip por pessoa).
- Reusar o padrão visual do card EMS já existente (`/api/v3/op/ems/my-activity` +
  `register-detected`) — a página já sabe mostrar um card de confirmação no login.

### E. Slack (helper)
- Função `explainReassignment({subject, real, tasks, reason})` → posta no canal dos
  operadores + admin, na voz da Carolina, agradecendo quem avisou. Respeita kill-switch
  (mas correção de dado é informativa; mandar no admin sempre).

## Verificação
- Testes unit no worker (guard não confirma quem não logou; presente ignora unconfirmed).
- Smoke: simular EMS task pra pessoa sem login → vira unconfirmed → findMachineRecv NÃO a
  escolhe → após "1h30" (forçar `since`) vira questionable → login de outro operador
  retorna a pergunta certa → responder "fui eu" move a task + posta Slack.
- Suíte inteira verde antes do deploy.

## Fora de escopo agora
- Não mexe no fluxo de handoff quando a pessoa É confirmada (funciona).
- Não muda a confiança do EMS quando a pessoa logou (EMS continua sendo a verdade da máquina).
