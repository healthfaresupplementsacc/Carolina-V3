# Carolina — Documento Mestre de Remodeling

**HealthFare Supplements Production Tracking System**
**Versão:** 1.0
**Data:** 14 de maio de 2026
**Autor do documento:** Bruno Camp (com Claude)

---

## Como usar este documento

Este é um documento de referência completo do sistema. **Não é pra ser entregue inteiro para o Claude Code ou Cowork de uma vez.** Foi feito pra ser:

1. **A fonte da verdade** sobre como o sistema deveria funcionar
2. **A referência** que você consulta quando algo parece confuso
3. **A origem das entregas faseadas** — você arranca pedaços específicos para mandar pra implementação, controladamente

A última seção do documento ("Roadmap de Entregas") lista as 7 entregas em ordem com escopo claro. Trabalhe uma por vez. Depois de cada entrega, rode o smoke test correspondente. Só passe pra próxima quando a anterior estiver estável.

---

## Sumário

1. [Princípios do sistema](#1-princípios-do-sistema)
2. [Glossário](#2-glossário)
3. [Visão geral da arquitetura](#3-visão-geral-da-arquitetura)
4. [Modelo de dados](#4-modelo-de-dados)
5. [Operadores e contas Slack](#5-operadores-e-contas-slack)
6. [Tipos de trabalho e fluxo do dia](#6-tipos-de-trabalho-e-fluxo-do-dia)
7. [Tarefas — ciclo de vida](#7-tarefas--ciclo-de-vida)
8. [Sistema de "join" e co-trabalho](#8-sistema-de-join-e-co-trabalho)
9. [Breaks e pausas](#9-breaks-e-pausas)
10. [Picking & Packing (Simone)](#10-picking--packing-simone)
11. [Contagem de bottles](#11-contagem-de-bottles)
12. [App Home — interface de botões](#12-app-home--interface-de-botões)
13. [Parsing de mensagens — sistema híbrido](#13-parsing-de-mensagens--sistema-híbrido)
14. [Sistema de perguntas pendentes (com janela de 20min)](#14-sistema-de-perguntas-pendentes)
15. [Carolina como agente AI no chat admin](#15-carolina-como-agente-ai-no-chat-admin)
16. [Painel admin — poder total](#16-painel-admin--poder-total)
17. [Anúncios no canal de produção](#17-anúncios-no-canal-de-produção)
18. [Dashboard — visualizações](#18-dashboard--visualizações)
19. [Calendário, backup, retenção](#19-calendário-backup-retenção)
20. [Stack técnica recomendada](#20-stack-técnica-recomendada)
21. [Como usar Claude Code para implementação](#21-como-usar-claude-code-para-implementação)
22. [Roadmap de entregas faseadas](#22-roadmap-de-entregas-faseadas)
23. [Apêndice A — Catálogo de suplementos HealthFare](#apêndice-a--catálogo-de-suplementos-healthfare)
24. [Apêndice B — Bugs específicos a corrigir](#apêndice-b--bugs-específicos-a-corrigir)

---

## 1. Princípios do sistema

Estes princípios devem guiar toda decisão de design daqui pra frente. Quando houver conflito entre uma feature nova e um princípio, o princípio ganha.

### 1.1 Facilidade pra quem tá na linha de produção

O time da linha trabalha com as mãos sujas, com pressa, e às vezes com outras pessoas esperando atrás deles. **Toda interação com a Carolina tem que poder ser feita em menos de 10 segundos.** Se um operador precisa pensar "como é que escreve isso mesmo?", o design falhou. Botões clicáveis são preferíveis a digitação. Linguagem natural é preferível a códigos. Sem códigos pra decorar.

### 1.2 Admin tem controle total

O admin (Bruno, Thassio, Henrique) deve poder corrigir **qualquer coisa**, a **qualquer momento**, em qualquer parte do sistema, com poucos cliques. Se a Carolina errou, o admin conserta. Se um funcionário esqueceu de marcar algo, o admin adiciona. Sem exceções, sem campos travados.

### 1.3 Carolina nunca expõe procedimento interno

Funcionários nunca devem ver palavras como "admin", "dashboard", "database", "API", "config". A Carolina não pede pra funcionário falar com o admin. Se ela tem dúvida ou um problema, ela manda discretamente pro chat admin. Pro funcionário, ela só age natural.

### 1.4 Carolina sempre varia o jeito de falar

Cada tipo de mensagem da Carolina tem pelo menos 20 variações. Ela nunca repete a mesma frase no mesmo dia. Tom: profissional carioca, séria mas não robótica, dura quando precisa, gentil por padrão. Sem "claro!" ou "com certeza!". Sem emoji excessivo (no máximo 1 por mensagem, e só quando faz sentido).

### 1.5 Toda ação destrutiva confirma antes

Fechar uma tarefa, deletar um registro, atualizar contagem, mexer em break — tudo que mexe na database vindo de instrução em linguagem natural (no chat admin) **propõe primeiro e espera confirmação**. Tipo: "Vou fechar a tarefa #423 das Ordens da Simone às 11:29 e setar contagem como 188. Confirma?"

Se o admin responder algo que não é "sim" claro, a Carolina reconsidera mantendo o contexto e propõe de novo. Sempre confirma antes de executar.

### 1.6 Estabilidade > Features novas

Quando há um bug, ele é resolvido antes de qualquer feature nova. Quando algo no sistema está instável (tipo o que aconteceu nas últimas duas semanas), parar de adicionar coisas e estabilizar primeiro. Cada feature deploy tem que ter smoke test que prove que funciona.

### 1.7 Sem memória entre cliques na App Home

Quando uma pessoa clica num botão da App Home (Iniciar, Pausa, Produção, etc.), a Carolina sempre pergunta "quem é você?" primeiro, mesmo que tenha perguntado 1 minuto antes. Razão: o time forma fila, várias pessoas usam a mesma conta em sequência, e memória de pessoa causaria atribuição errada.

### 1.8 Sistema híbrido — regras primeiro, AI como fallback

Pra parsing de mensagens no canal de produção, regras (regex) tentam primeiro porque são rápidas e gratuitas. Se as regras não dão certeza, a AI (Haiku) é acionada com contexto pra interpretar. 90% das mensagens são resolvidas pelas regras. Os 10% complicados (com erros de digitação, contexto, referências) vão pra AI.

---

## 2. Glossário

| Termo | Definição |
|---|---|
| **Carolina** | O bot que roda no Slack e gerencia o tracking. Tem dois cérebros: parser (regras) e Haiku (AI). |
| **Operador** | Pessoa que trabalha na produção. Hoje são Ana, Bruno, Simone, Vitor. |
| **Conta Slack** | Conta no Slack usada por um ou mais operadores. Algumas são compartilhadas (Production Line). |
| **Conta compartilhada** | Conta Slack usada por mais de um operador, por exemplo @Production Line (Ana + Bruno). |
| **Tarefa** | Unidade de trabalho com início, fim, tipo, operadores e dados associados. |
| **Tipo de tarefa** | Categoria: Produção, Revisão, Limpeza, Packing, Linha de Produção, Formulação, Encapsulação, Label, Outro. |
| **Join** | Ato de uma segunda pessoa entrar numa tarefa que outra já abriu, virando co-trabalhadora. |
| **Helpers** | Operadores adicionais numa tarefa (não o que abriu). |
| **Break / Pausa** | Período em que um operador está fora da produção (almoço, banheiro, etc). |
| **Pergunta pendente** | Pergunta da Carolina a um operador esperando resposta, com janela de tempo configurável (default 20min). |
| **Canal de produção** | `C09UNBXFRKK` — onde os funcionários trabalham. |
| **Canal admin** | `C0B36DR5MP1` — onde só Bruno/Thassio/Henrique conversam com a Carolina. |
| **Dashboard** | A página web com todas as visualizações e controles admin. |
| **App Home** | A "página" da Carolina dentro do Slack, acessível clicando no nome dela na sidebar. |
| **Smoke test** | Bateria curta de testes manuais que prova que uma feature funciona depois do deploy. |

---

## 3. Visão geral da arquitetura

```
┌─────────────────────────────────────────────────────────────────┐
│                         SLACK                                    │
│                                                                  │
│  Canal de Produção (C09UNBXFRKK)    Canal Admin (C0B36DR5MP1)   │
│         │                                    │                   │
│         │  mensagens dos funcionários        │  perguntas admin  │
│         │  + cliques na App Home             │  comandos admin   │
│         ▼                                    ▼                   │
└─────────┼────────────────────────────────────┼──────────────────┘
          │                                    │
          │                                    │
┌─────────▼────────────────────────────────────▼──────────────────┐
│                    SERVIDOR (Railway)                            │
│                                                                  │
│  ┌──────────────┐   ┌───────────────┐   ┌──────────────────┐   │
│  │   Parser     │──▶│   Tasks       │──▶│   PostgreSQL DB   │   │
│  │   (regras)   │   │   Engine      │   │                   │   │
│  └──────────────┘   └───────────────┘   └──────────────────┘   │
│         │                  ▲                     ▲              │
│         │ (incerto)        │                     │              │
│         ▼                  │                     │              │
│  ┌──────────────┐          │                     │              │
│  │  Haiku AI    │──────────┘                     │              │
│  │  (fallback)  │                                │              │
│  └──────────────┘                                │              │
│         ▲                                         │              │
│         │  (chat admin)                          │              │
│         │                                         │              │
│  ┌──────┴───────┐   ┌───────────────┐            │              │
│  │  Admin AI    │   │  Dashboard    │────────────┘              │
│  │  Agent       │   │  (Express)    │                            │
│  │  (propose-   │   └───────────────┘                            │
│  │   confirm)   │           ▲                                    │
│  └──────────────┘           │                                    │
│                             │                                    │
└─────────────────────────────┼────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   Browser do    │
                    │   admin         │
                    └─────────────────┘
```

### Componentes

**Parser (cérebro 1):** código que recebe cada mensagem do canal de produção e tenta entender o que é. Usa regex e listas de padrões. Rápido (5ms) e grátis. Resolve 90% das mensagens.

**Haiku AI (cérebro 2 — fallback do parser):** quando o parser não tem certeza do que uma mensagem significa, manda pro Haiku com contexto. Haiku interpreta e devolve a ação a ser tomada. Lento (1-2s) e custa ~$0.001 por chamada.

**Admin AI Agent:** Haiku conectado ao chat admin (C0B36DR5MP1). Tem acesso à database, ao histórico do canal de produção, e a um conjunto de tools (close_task, update_count, etc). Funciona em modo propose-then-confirm: nunca executa ação destrutiva sem o admin confirmar.

**Tasks Engine:** módulo que gerencia o ciclo de vida das tarefas. Abrir, fechar, dar join, fazer pausa, etc. É o que fala diretamente com o banco.

**Dashboard:** página web (Express + HTML/JS) que mostra estado do dia, tarefas, breaks, ordens, produção, com controles admin.

**App Home:** interface dentro do Slack com botões clicáveis pros operadores. Conversa com o servidor via Block Kit interactive.

---

## 4. Modelo de dados

### 4.1 Tabela `operators`

Lista de pessoas que trabalham na produção.

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | PK |
| `name` | string | Nome de exibição (ex: "Ana", "Bruno", "Simone", "Vitor") |
| `aliases` | array | Outros nomes que esse operador atende (ex: "Aninha", "Bru") |
| `active` | bool | Se está ativo no time atualmente |
| `role` | string | Função primária (ex: "produção", "packing", "formulação") |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

### 4.2 Tabela `slack_accounts`

Cada conta Slack que o sistema rastreia. Algumas são pessoais, algumas compartilhadas.

| Campo | Tipo | Descrição |
|---|---|---|
| `slack_user_id` | string | PK — ID do Slack (ex: U0AU8N8FA0) |
| `display_name` | string | Nome exibido no Slack (ex: "Production Line", "Vitor HealthFare") |
| `is_shared` | bool | Se mais de um operador usa essa conta |
| `default_operator_id` | UUID | Operador padrão (dono da conta), se houver |
| `created_at` | timestamp | |

### 4.3 Tabela `account_operators`

Liga contas Slack aos operadores que podem usá-las. Muitos-para-muitos.

| Campo | Tipo | Descrição |
|---|---|---|
| `slack_user_id` | string | FK |
| `operator_id` | UUID | FK |
| `is_owner` | bool | Se esse operador é o "dono" da conta |

**Configuração inicial:**

- Conta `@Production Line` (U0AU8N8FA0) → Ana, Bruno (sem owner explícito)
- Conta `Vitor HealthFare` → Vitor (owner), Ana, Simone
- Conta `Simone` → Simone (owner), Ana
- (qualquer pessoa pode logar em qualquer conta — princípio do Bruno)

### 4.4 Tabela `tasks`

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | PK |
| `task_type` | enum | producao, revisao, limpeza, packing, linha_producao, formulacao, encapsulacao, label, outro |
| `supplement` | string nullable | Nome do suplemento (null se tipo não exige) |
| `batch` | string nullable | Número do lote |
| `target_count` | int nullable | Quantidade alvo de bottles |
| `final_count` | int nullable | Quantidade final produzida |
| `status` | enum | open, closed, abandoned |
| `started_at` | timestamp | Quando abriu |
| `ended_at` | timestamp nullable | Quando fechou |
| `started_by_operator_id` | UUID | Quem abriu |
| `closed_by_operator_id` | UUID nullable | Quem fechou |
| `slack_account_used` | string | Slack ID da conta que foi usada pra abrir |
| `slack_start_ts` | string | Timestamp Slack da mensagem que abriu |
| `slack_end_ts` | string nullable | Timestamp Slack da mensagem que fechou |
| `notes` | text nullable | Observação geral |
| `input_method` | enum | button, message, admin |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

### 4.5 Tabela `task_participants` (NOVA — substitui campo `helpers`)

Registra todos os operadores que trabalharam numa tarefa, incluindo quem abriu.

| Campo | Tipo | Descrição |
|---|---|---|
| `task_id` | UUID | FK |
| `operator_id` | UUID | FK |
| `role` | enum | starter (abriu), joiner (entrou no meio), closer (fechou) — pode ter mais de uma role |
| `joined_at` | timestamp | Quando essa pessoa entrou na tarefa |
| `left_at` | timestamp nullable | Quando essa pessoa saiu (raramente usado) |

### 4.6 Tabela `pauses` (breaks)

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | PK |
| `operator_id` | UUID | FK — quem está em pausa |
| `slack_account_used` | string | Slack ID da conta |
| `reason` | enum nullable | almoço, banheiro, manutencao, outro |
| `started_at` | timestamp | |
| `ended_at` | timestamp nullable | null = ainda em pausa |
| `ended_reason` | enum nullable | manual (voltei), auto_new_task (abriu nova tarefa) |
| `slack_start_ts` | string nullable | |
| `slack_end_ts` | string nullable | |

### 4.7 Tabela `orders_sessions` (picking & packing)

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | PK |
| `date` | date | Dia da sessão |
| `operator_id` | UUID | Quem fez (geralmente Simone) |
| `helpers` | UUID[] | Operadores que ajudaram |
| `shift` | enum | manhã, tarde |
| `pass_number` | int | 1ª impressão, 2ª impressão, etc |
| `order_count` | int | Quantas ordens nessa sessão |
| `started_at` | timestamp | |
| `ended_at` | timestamp nullable | |
| `notes` | text nullable | |

### 4.8 Tabela `production_counts`

Registros de bottles produzidos por suplemento/lote num dia.

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | PK |
| `date` | date | Dia |
| `supplement` | string | Nome do suplemento |
| `batch` | string nullable | |
| `count` | int | Quantidade |
| `source` | enum | manual_button, end_of_day_message, admin_edit |
| `task_id` | UUID nullable | Tarefa vinculada (se houver) |
| `reported_by_operator_id` | UUID nullable | |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

### 4.9 Tabela `messages_log`

Registro de toda mensagem processada (pra timeline e auditoria).

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | PK |
| `slack_ts` | string | Timestamp Slack |
| `slack_account_used` | string | Conta que mandou |
| `operator_id` | UUID nullable | Resolvido pra qual operador |
| `text` | text | Conteúdo |
| `was_edited` | bool | Se foi mensagem editada |
| `parsed_as` | string | O que o parser entendeu (start, finish, pause, note, unknown, etc) |
| `confidence` | enum | regex_exact, regex_loose, ai_fallback, ai_admin |
| `action_taken` | string | O que aconteceu (task_opened:UUID, task_closed:UUID, ignored, etc) |
| `created_at` | timestamp | |

### 4.10 Tabela `pending_questions`

Perguntas que a Carolina fez e está esperando resposta.

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | PK |
| `operator_id` | UUID | A quem foi feita |
| `question_type` | enum | confirm_close, identify_supplement, identify_label, ordersecond_count, supplement_for_join, etc |
| `context` | jsonb | Dados pra entender a pergunta (tarefa relacionada, etc) |
| `asked_at` | timestamp | Quando foi feita |
| `expires_at` | timestamp | Quando expira (default asked_at + 20min) |
| `resolved_at` | timestamp nullable | Quando foi respondida |
| `resolution` | jsonb nullable | Como foi resolvida |
| `slack_question_ts` | string | TS da mensagem da pergunta |

### 4.11 Tabela `app_config`

Configurações editáveis pelo admin.

| Campo | Tipo | Descrição |
|---|---|---|
| `key` | string | PK |
| `value` | jsonb | |
| `updated_by` | string | |
| `updated_at` | timestamp | |

Chaves importantes:
- `pending_question_window_minutes` (default: 20)
- `ai_fallback_enabled` (default: true)
- `ai_admin_confirmation_required` (default: true)
- `morning_reminder_enabled` (default: true)
- `morning_reminder_text` (mensagem atual)
- `cleaning_alert_minutes` (default: 60)
- `eod_summary_hour` (default: 19)
- `production_channel_id`
- `admin_channel_id`

### 4.12 Tabela `task_aliases` (pra merge / drag-drop)

Quando o admin mescla duas tarefas que deveriam ser uma, as descrições viram sinônimos. Próxima vez que aparecer qualquer um dos termos, sistema sabe que é a mesma família.

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | PK |
| `canonical_term` | string | Termo principal |
| `alias_term` | string | Termo sinônimo |
| `learned_at` | timestamp | |
| `learned_from_task_id` | UUID nullable | A partir de qual merge foi aprendido |

---

## 5. Operadores e contas Slack

### 5.1 Cadastro

No painel admin, página "Operadores & Contas". Dois CRUDs:

**Operadores:**
- Adicionar/editar/desativar
- Nome, aliases, função, ativo/inativo

**Contas Slack:**
- Listar todas as contas conhecidas (auto-descobertas quando alguém manda mensagem pela primeira vez)
- Pra cada uma: marcar como compartilhada ou pessoal
- Pra contas compartilhadas: associar quais operadores podem usar
- Definir operador padrão (owner)

### 5.2 Configuração inicial

| Conta Slack | Display Name | Tipo | Operadores associados | Owner |
|---|---|---|---|---|
| U0AU8N8FA0 | Production Line | Compartilhada | Ana, Bruno | (nenhum) |
| (Vitor) | Vitor HealthFare | Pessoal mas pode ser usada por outros | Vitor, Ana, Simone | Vitor |
| (Simone) | Simone | Pessoal mas pode ser usada por outros | Simone, Ana | Simone |

**Princípio:** qualquer pessoa pode logar em qualquer conta sem problema. Quando alguém clica na App Home ou manda mensagem, o sistema sempre pergunta "quem é?" ao invés de assumir.

### 5.3 Resolução de operador

Quando uma mensagem chega ou um botão é clicado, o sistema precisa saber **quem** é o operador. A lógica:

**Via App Home (botão):** sempre pergunta primeiro, no Passo 1 de cada modal.

**Via mensagem no canal:**

1. Se a mensagem começa com `Nome - ` ou `Nome: ` ou `Nome — ` (qualquer nome cadastrado nos operadores ou seus aliases), usa esse nome.
2. Se não tem prefixo de nome **e** a conta Slack é pessoal de um operador (não compartilhada), atribui ao dono.
3. Se a conta é compartilhada **e** não tem prefixo, o parser flaga a mensagem como "operador desconhecido" e pergunta no canal: "quem tá postando, Ana ou Bruno?" (com 20 variações da pergunta).
4. Se a pessoa tá em uma pergunta pendente recente (últimos 20min) da mesma conta, **pode** inferir que é a mesma pessoa. Mas isso é uma heurística e a Carolina deve passar pelo AI fallback se tiver dúvida.


## 6. Tipos de trabalho e fluxo do dia

Esta seção descreve **como o dia realmente funciona na HealthFare** pra que o sistema seja desenhado em volta da realidade, não de uma abstração.

### 6.1 Tipos de trabalho

| Tipo | Quem faz tipicamente | Suplemento obrigatório? | Notas |
|---|---|---|---|
| **Picking & Packing** | Simone (com ajuda da Ana) | Não | Imprime ordens de manhã, depois empacota. Geralmente 2 impressões: ~8:46 e ~11:00. |
| **Formulação** | Vitor, Bruno | Sim | Preparar a fórmula antes de virar cápsula. |
| **Encapsulação** | Bruno | Sim | Transformar fórmula em cápsulas. |
| **Revisão** | Qualquer um | Sim | Conferir lote, cápsulas, qualidade. |
| **Linha de Produção** | Ana, e qualquer um | Sim | Pôr suplemento na linha, embalar nos potes finais. **Só um suplemento por vez.** |
| **Limpeza** | Qualquer um | Não | Geralmente fim do dia. Não deveria durar mais de 1h. |
| **Label** | Qualquer um | Sim, mas pode perguntar depois | Colocar etiqueta nos potes. |
| **Outro** | Qualquer um | Não | Catch-all pra coisas não classificadas. |

### 6.2 Fluxo típico de um dia

```
08:00  Carolina manda lembrete de manhã no canal
08:30+ Operadores chegam
08:30  Simone começa Picking (imprime 1ª leva de ordens)
09:00+ Vitor começa Formulação do Suplemento X
       Bruno começa Encapsulação do Suplemento Y (paralelo)
       Ana ajuda Simone no Packing OU faz Limpeza
09:30+ Vitor termina Formulação X, começa Revisão do Y
       Bruno termina Encapsulação Y, começa Encapsulação Z
11:00  Simone faz 2ª impressão (mais ordens)
12:00+ Almoço escalonado (não todos juntos)
13:30+ Volta do almoço
       Ana inicia Linha de Produção do X (Vitor pode dar join)
14:00+ Linha de Produção X termina → contagem de bottles
       Inicia Linha de Produção do Y (próximo suplemento)
...
17:00+ Limpeza
17:30  Mensagem de produção do dia (totais de bottles por suplemento)
18:00  Carolina manda EOD review se houver tarefa em aberto
18:30  Time vai embora
19:00  Carolina manda resumo do dia pro admin chat
```

### 6.3 Casos especiais que o sistema precisa entender

**Múltiplas tarefas em paralelo por uma só pessoa.** Bruno pode estar fazendo Formulação Y **e** Encapsulação X ao mesmo tempo. Sistema deve permitir um operador ter mais de uma tarefa aberta simultaneamente.

**Co-trabalho em Linha de Produção.** Linha de Produção é a tarefa que mais junta gente. Se Vitor abriu Linha de Produção do Green Tea e a Ana fala "ajudando o Vitor na linha de produção", o sistema deve:

- Detectar que já existe Linha de Produção aberta (do Green Tea, do Vitor)
- Adicionar Ana como participante (join) automaticamente — sem perguntar qual suplemento, porque Linha de Produção só tem um suplemento ativo por vez
- Anunciar no canal: "Ana entrou na Linha de Produção do Green Tea junto com Vitor"

**Encerramento em cascata por nova tarefa.** Quando alguém abre uma nova tarefa sem fechar a anterior, e o tipo de nova tarefa indica que a anterior terminou:

- Simone tá em Ordens. Manda "iniciei Revisão do Ginger". Carolina entende que Ordens acabou e Revisão começou. Fecha Ordens automaticamente.
- Mas é uma heurística: a Carolina deve **propor** o fechamento da tarefa anterior antes de executar, OU confirmar via pergunta com janela de 20min. "Simone, fechei suas Ordens agora pra abrir a Revisão do Ginger, ok?"

**Linha de produção troca de suplemento.** Quando alguém abre Linha de Produção de outro suplemento e a anterior ainda estava aberta:

- Carolina entende que a anterior terminou
- Pede a contagem da anterior antes de abrir a nova: "Quantos bottles fizeram do Green Tea antes de passar pro Saw Palmetto?"

---

## 7. Tarefas — ciclo de vida

### 7.1 Estados de uma tarefa

```
[abrir] → OPEN ──┬──→ [fechar] ──→ CLOSED
                 │
                 ├──→ [admin abandona] ──→ ABANDONED
                 │
                 └──→ [admin reabre] ──→ OPEN (de novo)
```

### 7.2 Abertura de tarefa

**Via App Home (botão Iniciar tarefa):**
1. Pergunta quem (Passo 1)
2. Pergunta tipo, suplemento, lote, target_count, notas
3. Cria registro na DB
4. Cria task_participant com role=starter
5. Anuncia no canal de produção
6. Reage com ✅ se houver mensagem associada (normalmente não há)

**Via mensagem no canal:**
1. Parser identifica como início (S:, "comecei", "iniciei", "to fazendo", etc)
2. Resolve operador
3. Extrai suplemento, lote, tipo
4. Se faltar info crítica, cria pergunta pendente
5. Se tudo ok, cria tarefa + participant
6. Reage com ✅ na mensagem original

### 7.3 Fechamento de tarefa

**Via App Home (botão Fechar tarefa):**
- Confirmação 1-click
- Se tarefa é Produção/Linha de Produção, pergunta opcionalmente quantos bottles
- Cria task_participant com role=closer se for pessoa diferente do starter
- Anuncia no canal

**Via mensagem no canal:**
1. Parser identifica como fim (F:, "terminei", "acabei", "fechei", "pronto", "feito", "concluí", "ja terminei", "já acabei", e variações)
2. Resolve operador
3. **Cross-operator fallback:** se o operador resolvido não tem tarefa aberta do tipo/suplemento, mas outra pessoa tem, fechar a tarefa dessa outra pessoa e adicionar o resolvido como closer.
4. **Last-resort fallback:** se F sem suplemento e a pessoa tem **uma única** tarefa aberta, fecha essa.
5. Se F sem S correspondente **e** sem nenhuma tarefa aberta da pessoa **e** sem outra tarefa óbvia, registrar como **atividade pontual** (registro de evento sem duração, aparece na timeline). Não ignorar.

### 7.4 Edição de tarefa (admin)

Admin pode editar a qualquer momento:
- Tipo
- Suplemento
- Batch
- Operador starter
- Lista de participantes (adicionar/remover)
- started_at / ended_at (incluindo timestamps no passado)
- Status (open / closed / abandoned)
- final_count
- notes

### 7.5 Reabertura (admin)

Admin pode reabrir tarefa fechada se foi fechada por engano. Quando reabre:
- Status volta pra OPEN
- ended_at vira null
- Pode adicionar novos participantes
- Anuncia no canal: "Tarefa X foi reaberta"

### 7.6 Tarefa "vazia" (sem operador, admin cria)

Admin pode criar tarefa sem operador definido. Status fica "aguardando". Quando alguém clica em "dar join" nessa tarefa pelo Slack ou App Home, vira o starter, started_at é setado pro momento do join, e a tarefa fica OPEN.

---

## 8. Sistema de "join" e co-trabalho

### 8.1 Princípio

Qualquer pessoa pode entrar em qualquer tarefa aberta, a qualquer momento. Não precisa pedir autorização. O sistema registra quem entrou, quando entrou, e anuncia no canal.

### 8.2 Como dar join

**Via App Home:** ao abrir a Home, existe uma seção "Tarefas em aberto agora" listando **todas** as tarefas abertas (não só da conta dele). Em cada uma, botão "Entrar nessa tarefa". Clica, confirma quem é (Passo 1 de sempre), e está dentro.

**Via mensagem:** quando alguém escreve algo que indica entrar numa tarefa existente:
- "ajudando o Vitor na linha de produção" → join na Linha de Produção do Vitor
- "S: ordens" enquanto Simone já tem Ordens aberta → Carolina pergunta se está ajudando (com janela 20min)
- "S: limpeza" enquanto outra pessoa tem Limpeza aberta → mesmo

### 8.3 Anúncios

Cada evento de join gera um anúncio no canal de produção:

> 🤝 **Ana** entrou na Linha de Produção do Green Tea junto com Vitor.

Cada fechamento agrupa todos os participantes:

> ✅ **Linha de Produção do Green Tea** finalizada — duração 1h45min. Trabalharam juntos: Vitor, Ana, Simone.

(Com 20 variações de cada mensagem.)

### 8.4 Conflito de detecção (mesma descrição, pessoas diferentes)

Quando alguém abre `S:` com descrição parecida com uma tarefa já aberta de outra pessoa, mas não tá claro se é join ou tarefa nova, Carolina pergunta:

> "Ana, tá ajudando a Simone no packing das 188 ordens, ou é outra tarefa?"

Janela de 20min pra responder. Se confirmar "ajudando", faz join. Se "outra tarefa", abre separado. Se não responder, default é abrir separado e o admin que reconcilia depois.

---

## 9. Breaks e pausas

### 9.1 Princípio

Quando um operador tá em break, ele não tá trabalhando. Quando tá trabalhando, não tá em break. É impossível estar nos dois ao mesmo tempo. Sistema deve garantir essa invariante automaticamente.

### 9.2 Abertura de pausa

**Via App Home:** botão Pausa / Voltei. Passo 1 pergunta quem. Passo 2 pede motivo (opcional: almoço, banheiro, manutenção, outro).

**Via mensagem:**
- "pausa", "indo pausar", "intervalo"
- "vou almoçar", "indo almoçar", "saindo pro almoço", "almoço"
- "vou no banheiro", "brb", "volto já"
- "indo embora", "saindo" (interpretado como break, admin classifica depois)

### 9.3 Fim de pausa — três caminhos

**Caminho 1 — Volta explícita:**
- "voltei", "voltei do almoço", "tô de volta", "retornei", "cheguei", "voltando", "voltei da pausa"
- Variações com erro: "voltie", "voltei jah", "ja voltei", "tovolta"

**Caminho 2 — Atividade nova fecha break automaticamente:**
Se um operador está em pausa aberta e manda qualquer mensagem que vira tarefa (S:, "comecei", "to fazendo", etc), o break é **fechado automaticamente** no timestamp dessa mensagem. Anuncia no canal: "Bem-vinda de volta, Ana! Registrei o fim do seu break."

**Caminho 3 — Admin força fim:**
No painel admin, lista de breaks ativos com botão "Encerrar break" pra cada um. Admin pode também encerrar pra alguém que esqueceu de marcar volta.

### 9.4 Admin com poder total sobre breaks

Admin pode:
- Encerrar break de qualquer pessoa
- Adicionar break retroativo (caso alguém esqueceu de marcar e foi almoçar)
- Editar started_at, ended_at, motivo, operador
- Deletar break (caso alguém marcou sem querer)

### 9.5 Alertas de break longo

- Break > 1h30: avisa no admin chat ("Bruno tá em break há 1h32min, normal?")
- Break > 3h: alerta sério no admin chat
- Break que cruza fim do dia (alguém esqueceu de marcar volta e foi embora): mensagem no admin chat, e no dia seguinte de manhã o break é auto-encerrado às 18:30 do dia anterior

---

## 10. Picking & Packing (Simone)

Esta seção descreve o sistema específico do Picking & Packing porque tem várias particularidades.

### 10.1 Como funciona na vida real

Simone (com ajuda eventual da Ana) faz:
1. **Picking:** imprime as ordens do dia (Amazon, etc) — geralmente em 2 ou 3 levas (1ª impressão de manhã, 2ª no meio da manhã, às vezes 3ª).
2. **Packing:** empacota cada ordem na embalagem certa.
3. **Envio:** prepara as caixas pra retirar.

Tudo isso é **uma operação contínua** ao longo da manhã, com pausas naturais.

### 10.2 Modelagem

Cada "impressão" vira uma `orders_session`. Uma sessão tem:
- pass_number (1, 2, 3...)
- order_count (quantas ordens nessa impressão)
- started_at / ended_at
- operator + helpers

### 10.3 Mensagens típicas que Simone manda

- "Bom dia, S - impressao das ordens - 188" → abre orders_session pass=1, count=188
- "Segunda impressao feita - 67" → abre orders_session pass=2, count=67 (fecha a anterior automaticamente)
- "Segunda impressao feita" (sem número) → cria sessão pass=2 sem count, e Carolina pergunta "Quantas ordens nessa segunda impressão, Simone?" (janela 20min)
- "F- ordens" → fecha a sessão aberta atual
- "F- ordens da segunda impressao feitas" → fecha a sessão atual

### 10.4 Bugs específicos a resolver

O parser hoje frequentemente erra com Picking & Packing. Casos:

- "F- ordens da segunda impressao feitas" — palavra "Mullein" ou outro suplemento pode pegar primeiro e o sistema acha que é fechamento de suplemento. **Fix:** "ordens" sempre vence sobre nome de suplemento.
- "Ja impacotei e ja iniciei a Revisao do Ginger" — mensagem composta com fechamento implícito + abertura nova. **Fix:** detectar verbos no passado ("impacotei", "terminei") + verbo de início ("iniciei", "comecei") = fecha o atual + abre o novo.

### 10.5 Admin com poder total

Admin pode (NOVO, hoje não tem):
- Criar nova orders_session do zero
- Editar todos os campos: operator, helpers, pass_number, count, started_at, ended_at, notes
- Adicionar helpers retroativamente (caso a Ana ajudou e ninguém marcou)
- Deletar sessão
- Reabrir sessão fechada por engano

### 10.6 Visualização no dashboard

Card "Ordens — Picking & Packing":
- Total de ordens do dia (soma de todas as sessões)
- Lista das sessões: pass_number, operator + helpers, count, duração
- Estado atual (em andamento / finalizado)
- Tempo total ativo (descontando gaps entre sessões)

---

## 11. Contagem de bottles

### 11.1 Duas formas de registrar

**Formato A — Ao fechar tarefa:**
Quando uma tarefa de Produção ou Linha de Produção é fechada, Carolina pergunta opcionalmente quantos bottles. Pode pular (mostra 0 ou null no momento, espera o registro de fim de dia).

**Formato B — Mensagem de fim de dia:**
Geralmente um operador (Ana, normalmente, mas pode ser qualquer um) manda uma mensagem com múltiplos suplementos e contagens no fim do dia:

> Ana - Producao de hoje:
> Graviola (0124) - 67
> Glycinate (0118) - 295
> Mullein (0122) - 181
> Glutathione (0128) - 95
> Berberine (0119) - 291
> Saw Palmetto (0104) - 193

### 11.2 Parsing da mensagem de fim de dia

Carolina deve:

1. Detectar que é mensagem de produção do dia (palavras-chave: "produção de hoje", "produção", "totais", "bottles", ou só uma lista de "nome (batch) - número")
2. Parsear cada linha: extrair `supplement`, `batch` (opcional), `count`
3. Pra cada linha, atualizar o `final_count` da tarefa correspondente (matching por supplement + batch + data)
4. Se não houver tarefa correspondente, criar registro em `production_counts` com source=`end_of_day_message`
5. Calcular total e responder no canal:

> Anotado, Ana! Total de hoje: 1.122 bottles em 6 suplementos. Me avisa se tiver algo pra atualizar.

6. **Cross-check com admin:** se algum número parece muito fora do normal (> 2x média ou < 50% média do suplemento), avisa no admin chat: "Recebi 67 do Graviola hoje, mas a média é 200. Confere se tá certo?"

### 11.3 Ordens fora de ordem

A mensagem pode vir em qualquer ordem, com formato variado. Carolina deve aceitar:

- `Graviola 0124 - 67`
- `67 Graviola (0124)`
- `Graviola - 67 - 0124`
- `(0124) Graviola 67`

Se o parser tem dúvida sobre uma linha específica, manda pra AI (Haiku) interpretar com contexto da lista de suplementos válidos.

### 11.4 Admin edita totais

No painel admin, seção "Produção do dia":
- Lista todos os suplementos contados hoje
- Cada linha editável (count, batch, operator que reportou)
- Botão "Adicionar suplemento" pra incluir contagem manualmente
- Botão "Re-escanear chat" pra fazer parsing de novo das mensagens de hoje


## 12. App Home — interface de botões

### 12.1 Conceito

Cada usuário do Slack tem uma "App Home" pra Carolina, acessível clicando no nome dela na sidebar do Slack. É uma tela dedicada onde a pessoa pode ver o que tá rolando e registrar ações sem digitar.

Importante: **a App Home é por conta Slack, não por operador.** A conta @Production Line tem uma App Home. A Ana e o Bruno veem a mesma tela quando abrem.

### 12.2 Layout da App Home

```
┌─────────────────────────────────────────────────────┐
│  Carolina — HealthFare Production                    │
│                                                       │
│  📍 Conta: [Display Name da conta]                   │
│                                                       │
│  ───────────────────────────────────────────────    │
│                                                       │
│  ⏱ Tarefas abertas (todas):                          │
│                                                       │
│  • Linha de Produção · Green Tea                    │
│    Vitor + Ana · 1h32min                            │
│    [Entrar nessa tarefa] [Fechar tarefa]            │
│                                                       │
│  • Limpeza                                          │
│    Bruno · 22min                                    │
│    [Entrar nessa tarefa] [Fechar tarefa]            │
│                                                       │
│  • Ordens 2ª impressão                              │
│    Simone · 18min                                   │
│    [Entrar nessa tarefa] [Fechar tarefa]            │
│                                                       │
│  ───────────────────────────────────────────────    │
│                                                       │
│  ⏸ Em break:                                         │
│  • (ninguém agora)                                  │
│                                                       │
│  ───────────────────────────────────────────────    │
│                                                       │
│  O que você quer registrar?                          │
│                                                       │
│  [▶️ Iniciar nova tarefa]                            │
│  [📦 Registrar produção]                             │
│  [⏸️ Pausa]                                          │
│  [↩️ Voltei do break]                                │
│  [📋 Nota / observação]                              │
│                                                       │
│  ───────────────────────────────────────────────    │
│                                                       │
│  Concluídas hoje:                                    │
│  09:00-09:30 Ana - Limpeza                          │
│  09:30-10:45 Bruno - Graviola 0124 (165 bottles)    │
│  ...                                                 │
│                                                       │
└─────────────────────────────────────────────────────┘
```

### 12.3 Modais (pop-ups) — todos começam com "quem"

**Regra de ouro:** sem memória de pessoa. Cada clique pergunta "quem é você?" no Passo 1.

#### 12.3.1 Modal — Iniciar nova tarefa

**Passo 1: Quem está fazendo?**
[Botões dos operadores cadastrados pra essa conta]

**Passo 2: Detalhes**
- **Tipo** (dropdown obrigatório): Produção, Revisão, Limpeza, Packing, Linha de Produção, Formulação, Encapsulação, Label, Outro
- **Suplemento** (dropdown — obrigatório se Tipo for Produção, Revisão, Formulação, Encapsulação, Label; opcional pro resto)
- **Lote/Batch** (texto, opcional)
- **Quantidade alvo** (número, opcional)
- **Observação** (texto, opcional)
- [Confirmar] [Cancelar]

**Resultado:** cria tarefa + participant. Anuncia no canal de produção.

#### 12.3.2 Modal — Registrar produção (bottles)

**Passo 1: Quem está reportando?**
**Passo 2:**
- **Suplemento** (dropdown obrigatório)
- **Lote** (texto)
- **Quantidade de bottles** (número obrigatório)
- [Confirmar]

**Resultado:** cria/atualiza production_count + atualiza final_count da tarefa correspondente se houver.

#### 12.3.3 Modal — Pausa

**Passo 1: Quem está saindo?**
**Passo 2:**
- **Motivo** (dropdown opcional): Almoço, Banheiro, Manutenção, Outro
- **Observação** (texto opcional)
- [Confirmar]

**Resultado:** cria registro em pauses. Anuncia: "Ana saiu pro almoço · 12:30"

#### 12.3.4 Modal — Voltei do break

**Passo 1: Quem voltou?**
**Passo 2:** confirma rapidamente
- "Você está em break desde 12:30 (1h0min). Marcar volta agora?"
- [Sim, voltei] [Cancelar]

**Resultado:** fecha o break. Anuncia: "Ana voltou · 13:30 · break durou 1h"

Se a pessoa **não tem** break aberto, mensagem amigável: "Você não tem break aberto agora, [Nome] :)"

#### 12.3.5 Modal — Nota / observação

**Passo 1: Quem está anotando?**
**Passo 2:**
- **Texto** (obrigatório)
- **Vincular a uma tarefa?** (dropdown opcional com tarefas abertas dessa pessoa)
- [Confirmar]

**Resultado:** cria registro de nota (vinculado a tarefa se especificado).

#### 12.3.6 Modal — Fechar tarefa (quando clica no botão da tarefa específica)

**Passo 1: Quem está fechando?** (porque pode ser pessoa diferente de quem abriu)
**Passo 2:** confirma
- "Fechar tarefa [Linha de Produção · Green Tea] iniciada por Vitor às 11:30?"
- Se tipo for Produção/Linha de Produção, campo opcional: "Quantos bottles produziram?"
- [Sim, fechar] [Cancelar]

**Resultado:** fecha tarefa, registra closer, anuncia no canal.

#### 12.3.7 Modal — Entrar em tarefa (join)

**Passo 1: Quem está entrando?**
**Passo 2:** confirma
- "Entrar na tarefa [Linha de Produção · Green Tea] junto com Vitor?"
- [Sim, entrar] [Cancelar]

**Resultado:** adiciona task_participant com role=joiner. Anuncia: "Ana entrou na Linha de Produção do Green Tea junto com Vitor."

### 12.4 Quando uma ação confirma, Carolina posta no canal

Toda ação via botão gera mensagem no canal de produção. Razão: o canal continua sendo o lugar onde todo mundo vê o que tá rolando. Os botões só substituem a digitação — não silenciam o canal.

Exemplos:

- ▶️ Iniciar: "🟢 Ana iniciou Limpeza · 14:32 _(via Production Line)_"
- ✅ Fechar: "🔴 Bruno fechou Berberine 0119 (45min, 480 bottles) · 14:35"
- 🤝 Join: "🤝 Ana entrou na Linha de Produção do Green Tea junto com Vitor"
- 📦 Produção: "📦 Simone registrou 256 bottles de Graviola 0124"
- ⏸ Pausa: "⏸ Vitor saiu pro almoço · 12:30"
- ↩ Volta: "▶ Ana voltou · 13:32 _(break: 1h2min)_"

O "_(via [Display Name])_" só aparece se a conta é compartilhada. Para contas pessoais, omitir.

### 12.5 Limitação técnica

Botões interativos só funcionam em mensagens, modais e App Home. **Não funcionam em Canvas.** Por isso a escolha de App Home (sempre acessível na sidebar) ao invés de Canvas.

### 12.6 Indicador no dashboard

Cada card de tarefa/produção/break no dashboard tem um pequeno ícone indicando como foi registrado:
- 🖱 botão (App Home)
- ⌨ mensagem digitada
- 🛠 admin (criado/editado manualmente)

---

## 13. Parsing de mensagens — sistema híbrido

### 13.1 Princípio

Toda mensagem do canal de produção passa por uma cascata:

```
Mensagem chega
     │
     ▼
[1] Cérebro 1 — Parser por regras (regex)
     │
     ├─ Resolveu com alta confiança → executa ação
     │
     ├─ Resolveu com baixa confiança → vai pro [2]
     │
     └─ Não resolveu nada → vai pro [2]
     │
     ▼
[2] Cérebro 2 — Haiku AI fallback
     │
     ├─ Recebe: mensagem + contexto (últimas N mensagens, tarefas abertas, perguntas pendentes, operadores)
     │
     ├─ Devolve: ação estruturada (start_task, finish_task, pause, etc) + confidence
     │
     ├─ Se confidence alta → executa
     │
     └─ Se baixa → ignora ou pergunta no canal
```

### 13.2 Cérebro 1 — Parser por regras

Continua basicamente como hoje, com melhorias:

**Tags em qualquer formato/posição:**
- S, F, P, N
- Separadores: `:`, `;`, `/`, `-`, espaço
- Em qualquer posição (começo, meio, fim)
- Maiúscula ou minúscula
- Regra de isolamento: a letra deve estar isolada (espaço, pontuação, início/fim ao redor) — não pegar S dentro de palavras

**Palavras em português:**
- Início: `comecei`, `iniciei`, `to fazendo`, `começando`, `vou começar`, `iniciando`, `pegando`
- Fim: `terminei`, `acabei`, `finalizei`, `fechei`, `pronto`, `feito`, `concluí`, `kbei`, `terminado`
- Pausa: `pausa`, `vou no break`, `vou almoçar`, `indo almoçar`, `almoço`, `brb`, `volto já`, `tô saindo`
- Volta: `voltei`, `tô de volta`, `cheguei`, `voltei do almoço`, `retornei`, `voltando`
- Produção: `produzi`, `fiz`, `total de potes`, `bottles`, `feitos`, `produção de hoje`

**Erro de digitação tolerante:** "voltie", "comecie", "termienei", "kbei", "jah", "tovolta" — incluir variações comuns nas listas. Mas não tentar fazer fuzzy matching automático (muito ruído).

**Mensagens compostas:** detectar quando uma mensagem tem fim de uma tarefa + início de outra ("impacotei e ja iniciei a Revisao do Ginger" → fecha ordens + abre revisão Ginger).

**Mensagens editadas:** subscrever ao evento `message_changed` do Slack. Quando uma mensagem é editada, reprocessar como nova com o novo conteúdo.

### 13.3 Cérebro 2 — Haiku AI fallback

**Quando aciona:**
- Parser retornou `unknown` (não reconheceu nada)
- Parser reconheceu mas com baixa confiança (ex: F sem suplemento e a pessoa tem 3 tarefas abertas, qual fechar?)
- Pessoa tem pergunta pendente e mandou mensagem que não bate exatamente nos padrões esperados
- Mensagem tem múltiplas interpretações possíveis

**Contexto enviado pro Haiku:**
- A mensagem em si (texto original)
- Quem mandou (operador resolvido, ou candidatos se for conta compartilhada)
- Últimas 10 mensagens do canal
- Tarefas abertas no momento (todas)
- Breaks ativos
- Perguntas pendentes não resolvidas
- Lista de operadores cadastrados
- Lista de suplementos válidos

**Resposta esperada do Haiku (JSON estruturado):**
```json
{
  "intent": "start_task" | "finish_task" | "pause" | "return" | "production_count" | "answer_pending" | "join_task" | "note" | "unknown",
  "operator": "Ana",
  "supplement": "Berberine",
  "batch": "0119",
  "task_type": "producao",
  "count": 256,
  "target_task_id": "uuid",
  "confidence": "high" | "medium" | "low",
  "reasoning": "texto explicando como chegou na conclusão"
}
```

**Ação tomada por confidence:**
- High → executa direto
- Medium → executa mas faz pergunta de confirmação no canal ("Ana, fechei a Berberine 0119 com 256 bottles, certo?")
- Low → não executa. Manda mensagem amigável pedindo esclarecimento.

### 13.4 Custos estimados

Volume típico no canal: ~80 mensagens/dia. Parser resolve ~70 sozinho. AI fallback é chamado ~10 vezes/dia. Cada chamada Haiku custa ~$0.001. **Custo mensal estimado: $0.30 a $1**.

Comparação com "AI em tudo" (Caminho B): ~80 chamadas/dia × $0.001 × 30 = $2.40/mês. Diferença pequena, mas latência é muito maior em todas as mensagens.

---

## 14. Sistema de perguntas pendentes

### 14.1 Conceito

Quando a Carolina faz uma pergunta a um operador, ela registra essa pergunta na tabela `pending_questions` com janela de tempo (default 20 minutos). Qualquer mensagem desse operador nessa janela é primeiro tentada como resposta àquela pergunta.

### 14.2 Tipos de pergunta

| Tipo | Quando | Contexto necessário |
|---|---|---|
| `confirm_close` | "Você já terminou X?" | task_id |
| `identify_supplement` | "Qual suplemento você está fazendo?" | task_id (recém-criado sem suplemento) |
| `identify_label` | "Que label tá colocando?" | task_id |
| `confirm_join` | "Tá ajudando o Vitor na Linha de Produção do X?" | task_id da tarefa existente |
| `who_posted` | "Quem tá postando, Ana ou Bruno?" | slack_account, message_ts |
| `second_print_count` | "Quantas ordens na 2ª impressão?" | orders_session_id |
| `bottle_count` | "Quantos bottles do X você fez?" | task_id |
| `clarify_action` | (AI fallback genérico) | message_id |

### 14.3 Resolução de resposta

Quando uma mensagem chega de alguém com pergunta pendente:

1. Sistema busca a pergunta pendente mais recente desse operador
2. Tenta resolver via regras primeiro:
   - Resposta tipo "sim", "yes", "ja", "ja kbei", "kbei", "jah", "ja terminei", "acabei", "pronto" → confirma
   - Resposta tipo "não", "no", "ainda nao", "n", "ainda" → nega
   - Resposta numérica pura → tentativa de contagem
   - Resposta com nome de suplemento → tentativa de identificação
3. Se regras não resolvem com certeza, manda pro Haiku com contexto da pergunta
4. Haiku interpreta e retorna ação
5. Sistema executa, fecha a pergunta pendente, e atualiza dados conforme

### 14.4 Resposta indireta (mudança de tarefa = resposta tácita)

Se a Carolina perguntou "já terminou X?" e em vez de responder a Simone abre uma tarefa nova (`S: Revisão Ginger`), isso é interpretado como **sim, terminei**. Sistema fecha X automaticamente no timestamp da nova mensagem e abre a nova.

Carolina anuncia: "Fechei suas Ordens automaticamente porque você começou a Revisão. Se foi engano, me avisa."

### 14.5 Janela configurável

Default 20 minutos. Admin pode mudar no painel admin (chave `pending_question_window_minutes`).

### 14.6 Expiração

Quando uma pergunta expira sem resposta:
- Sistema marca como `resolved_at = NOW`, `resolution = {expired: true}`
- **Não pergunta de novo** (princípio: não enche o saco do funcionário)
- Manda mensagem discreta no admin chat: "Perguntei pra Simone se ela terminou as Ordens há 20min, não tive resposta clara. Status da tarefa: ainda aberta."
- Admin decide o que fazer (fechar manual, ignorar, etc)

### 14.7 Uma pergunta por vez por operador

Se a Carolina já tem uma pergunta pendente pra um operador, ela **não faz outra pergunta** até a primeira ser resolvida ou expirar. Razão: evitar empilhar perguntas e gerar caos.

### 14.8 Cancelamento via ação explícita

Se o operador faz uma ação explícita (clica no botão da App Home, ou manda uma mensagem com tag clara), a pergunta pendente é automaticamente cancelada — o sistema assume que a ação explícita resolveu o assunto.


## 15. Carolina como agente AI no chat admin

### 15.1 Conceito

No canal admin (C0B36DR5MP1), a Carolina é um **agente AI completo**: ela ouve, analisa, propõe ações, e executa após confirmação. Não é só "responder perguntas com dados". Ela pode mexer em qualquer coisa do sistema, mas sempre com confirmação humana antes de executar ações destrutivas ou que alteram a database.

### 15.2 Capacidades

**Análise (sem confirmação):**
- Responder perguntas sobre o estado do dia
- Resumir o que aconteceu em qualquer período
- Comparar com dias anteriores, tendências
- Explicar o que ela fez e por quê (auditoria)
- Identificar problemas potenciais ("Olha, o Bruno tá em break há 3h, parece estranho")
- Ler e citar mensagens do canal de produção
- Sugerir prompts pra você passar pro Claude Code corrigir o código

**Ação (com confirmação):**
- Fechar tarefas abertas
- Reabrir tarefas fechadas
- Editar tarefas (qualquer campo)
- Criar tarefas retroativas
- Adicionar/remover participantes
- Encerrar breaks
- Adicionar breaks retroativos
- Editar/criar orders_sessions
- Atualizar contagens de produção
- Adicionar/editar/desativar operadores
- Configurar contas Slack
- Mudar configurações (janela de pergunta pendente, alertas, etc)
- Mandar mensagens no canal de produção

### 15.3 Padrão Propose-Then-Confirm

Toda ação destrutiva ou que altera a database passa por:

1. **Admin pede:** "fecha as ordens da Simone e atualiza pra 188"
2. **Carolina propõe:** "Vou fechar a orders_session #423 (Simone, 1ª impressão, aberta às 8:46) e setar count=188. Confirma?"
3. **Admin responde:**
   - "sim" / "ok" / "confirma" / "pode" → executa
   - "muda X" / "na verdade é Y" → re-propõe com ajuste
   - "cancela" / "deixa" / "não" → não executa
   - resposta ambígua → AI re-pergunta mantendo o contexto

4. **Carolina executa e confirma:** "Feito. orders_session #423 fechada às [hora atual], count=188. Aparece atualizado no dashboard."

### 15.4 Re-pensar mantendo contexto

Se o admin responde com correção (não é sim claro), Carolina:
- Lembra do contexto da pergunta original
- Lembra das correções acumuladas
- Re-propõe com o ajuste
- **Sempre** pede confirmação antes de executar, mesmo que pareça óbvio

Exemplo:
> Admin: fecha as ordens da Simone
> Carolina: Vou fechar a orders_session #423 da Simone (1ª impressão, aberta às 8:46). Confirma?
> Admin: na verdade é a segunda impressão
> Carolina: Ok, então vou fechar a orders_session #427 da Simone (2ª impressão, aberta às 11:00). Confirma?
> Admin: sim
> Carolina: Feito. orders_session #427 fechada.

### 15.5 Ações sem confirmação (read-only)

Pra perguntas e análise, executa direto:

> Admin: o que a Ana tá fazendo agora?
> Carolina: A Ana tem 2 tarefas abertas: Linha de Produção do Saw Palmetto (com Vitor, há 32min) e uma nota das 14:15 sobre manutenção. Não tá em break.

> Admin: por que você ficou perguntando pra Simone se ela terminou as ordens hoje?
> Carolina: Às 11:33 eu perguntei pra Simone se as ordens já fecharam porque o parser não reconheceu "F- ordens da segunda impressao feitas" às 11:29 (o ponto-e-vírgula faltando ou alguma coisa no parsing). Ela respondeu às 11:44 com foto e o parser também não pegou. A pergunta pendente expirou às 11:53. Recomendo passar isso pro Claude Code com este prompt: "[prompt sugerido]"

### 15.6 Sugestão de prompts para Claude Code

Quando a Carolina identifica um problema técnico (bug no parser, lógica errada, falta de tratamento), ela:

1. Diagnostica o problema
2. Explica em linguagem natural pro admin
3. Sugere um prompt formatado pra você copiar e colar no Claude Code

Exemplo:
> Carolina: Detectei que mensagens com formato "F- ordens da segunda impressao feitas" não estão sendo reconhecidas como fechamento de orders_session. O parser tem prioridade errada: ele pega o nome do suplemento antes de procurar "ordens".
>
> Sugestão de prompt pro Claude Code:
> ```
> No arquivo src/parser/index.js, a função detectOrdersFinish() deve ter prioridade sobre a detecção de suplemento. Atualmente quando uma mensagem contém "F- ordens da segunda impressao feitas", o parser pega "feitas" como nome de suplemento e ignora a parte de ordens. Reordene a lógica para que orders_finish seja verificado ANTES de qualquer match de suplemento. Adicione testes que cubram: "F- ordens", "F- ordens da segunda impressao feitas", "F: ordens 2 impressao".
> ```
>
> Quer que eu refine esse prompt ou está bom?

### 15.7 Acesso ao canal de produção

Carolina-admin **lê** o canal de produção (C09UNBXFRKK) sob demanda. Quando o admin faz perguntas como "o que aconteceu hoje?", "o que a Ana disse?", "por que esse break tá aberto?", ela busca as mensagens relevantes e cita.

**Não posta automaticamente no canal de produção a partir do chat admin.** Só posta quando o admin pede explicitamente ("manda no canal pra todo mundo que X").

### 15.8 Painel de configuração de AI no dashboard

Página nova no admin: "Configurações Carolina AI"

Toggle e campos editáveis:
- ✅ AI fallback do parser ligado (default: on)
- ✅ Confirmação antes de ação destrutiva no admin chat (default: on, **fortemente** recomendado deixar)
- ✅ Sugestão de prompts pro Claude Code (default: on)
- 🔢 Janela de pergunta pendente em minutos (default: 20)
- 🔢 Limiar de break longo em minutos (default: 90)
- 🔢 Limiar de limpeza longa em minutos (default: 60)
- 🔢 Horário do lembrete de manhã (default: 08:00)
- 🔢 Horário do EOD review (default: 18:00)
- 🔢 Horário do resumo admin (default: 19:00)
- 📝 Texto do lembrete de manhã (textarea editável)
- 📝 System prompt da Carolina admin (textarea editável, com aviso "mexer aqui pode quebrar comportamento")
- 🔢 Quantas mensagens recentes mandar como contexto pro AI fallback (default: 10)
- 🔢 Quantos dias guardar dados antes de avisar pra fazer backup (default: 15)

Botão "Salvar" persiste em `app_config`.

---

## 16. Painel admin — poder total

### 16.1 Princípio

Admin pode editar, criar, deletar, mover, reabrir **qualquer coisa**, a qualquer momento. Nada é travado. Tudo registrado em log de auditoria.

### 16.2 Páginas do painel admin

**16.2.1 Dashboard (página principal)**
Já existe. Mantém o que tem hoje, mais:
- Botão "+ Nova Tarefa" em cada seção
- Botão de editar em cada item, com todos os campos editáveis
- Botão de fechar em cada tarefa aberta
- Botão de reabrir em tarefas fechadas
- Drag & drop pra mesclar tarefas similares

**16.2.2 Operadores & Contas Slack**
- CRUD de operadores (nome, aliases, ativo, função)
- CRUD de contas Slack (display, compartilhada, owner, operadores associados)

**16.2.3 Catálogo de suplementos**
- Lista dos 73 suplementos da HealthFare
- Adicionar novos com aliases
- Editar nome/aliases
- Marcar como inativo (parou de produzir)

**16.2.4 Breaks**
- Lista todos os breaks ativos
- Botão encerrar em cada um
- Botão adicionar break retroativo
- Edição completa de qualquer break

**16.2.5 Picking & Packing**
- Lista todas as orders_sessions do dia
- CRUD completo (criar, editar, deletar, reabrir)
- Adicionar/remover helpers

**16.2.6 Produção (bottles)**
- Lista de production_counts do dia
- Editar contagens
- Botão re-escanear chat (re-faz parsing de mensagens do dia)
- Adicionar contagem manual

**16.2.7 Logs e auditoria**
- Lista cronológica de todas as mensagens processadas
- Pra cada uma: o que o parser entendeu, qual ação tomou, em qual tarefa
- Filtros por operador, tipo, data

**16.2.8 Calendário e histórico**
- Date picker
- Volta dias anteriores, vê dashboard daquele dia
- Banner "Visualizando: DD/MM/YYYY"

**16.2.9 Backup**
- Lista de exports já feitos
- Botão "Exportar tudo agora" (JSON download)
- Lembrete automático após 15 dias sem export

**16.2.10 Configurações Carolina AI**
- Toggles e campos da seção 15.8

**16.2.11 Broadcast no canal**
- Textarea pra Carolina postar mensagem no canal de produção
- Botão "Enviar"
- Histórico de broadcasts

### 16.3 Auditoria de mudanças admin

Toda ação do admin é logada:
- Quem (qual admin)
- Quando
- O que mudou (before / after)
- De onde (dashboard botão / admin chat AI / etc)

Visualizável na página de Logs.

---

## 17. Anúncios no canal de produção

### 17.1 Princípio

Toda ação importante gera anúncio no canal pra todo mundo ver o que tá rolando. Mas evita ruído: ações triviais não geram anúncio.

### 17.2 O que anuncia

| Evento | Mensagem (1 das 20 variações) |
|---|---|
| Início de tarefa | "🟢 Ana iniciou Limpeza · 14:32" |
| Fim de tarefa | "🔴 Bruno fechou Berberine 0119 (45min, 480 bottles) · 14:35" |
| Join | "🤝 Ana entrou na Linha de Produção do Green Tea junto com Vitor" |
| Tarefa completa com múltiplos | "✅ Linha de Produção do Green Tea finalizada — 1h45min · Trabalharam: Vitor, Ana, Simone" |
| Produção registrada | "📦 Simone registrou 256 bottles de Graviola 0124" |
| Início de pausa | "⏸ Vitor saiu pro almoço · 12:30" |
| Fim de pausa | "▶ Ana voltou · 13:32 (break: 1h2min)" |
| Tarefa reaberta | "♻️ Tarefa Limpeza foi reaberta pelo admin" |
| Tarefas mescladas | "🔗 Tarefas mescladas: 'ordens' e 'packing' viraram uma só" |
| Total do dia | "🎉 Total de hoje: 1.122 bottles em 6 suplementos. Bom trabalho, gente!" |

### 17.3 O que NÃO anuncia

- Perguntas internas pra um operador específico (vai pro próprio canal mas como pergunta direta, não como anúncio)
- Edições admin no painel (a menos que o admin marque "também anunciar no canal")
- Erros internos / problemas técnicos (vão pro admin chat)
- Notas pessoais

### 17.4 Variações

Cada tipo de anúncio tem **mínimo 20 variações**. Sistema escolhe aleatório evitando repetir a mesma 2x no mesmo dia.

### 17.5 Reações na mensagem original

Quando uma mensagem do canal foi processada com sucesso pelo parser, Carolina reage com ✅. Quando foi processada via AI fallback, reage com ✅ também (não diferencia pro funcionário). Quando ignora porque não é trabalho (conversa casual, "bom dia"), não reage.

---

## 18. Dashboard — visualizações

### 18.1 Hero (topo da página)

Container destacado com:
- **Total de hoje:** grande, central
- **Total de ontem:** comparação (com seta ⬆/⬇)
- **Total da semana:** soma
- **Média do mês:** referência

### 18.2 Estimativas de tempo

Pra cada tarefa aberta, mostrar:
- Tempo já decorrido
- Tempo médio histórico desse tipo+suplemento
- Estimativa de conclusão (se baseline existe)
- Cor verde / amarela / vermelha conforme passa da média

### 18.3 Em Andamento

Lista de tarefas abertas. Cada card mostra:
- Tipo + suplemento + batch
- Operador starter + helpers
- Início, duração, estimativa
- Indicador de input (🖱 / ⌨ / 🛠)
- Botões admin: editar, fechar, reabrir, mesclar

### 18.4 Ordens — Picking & Packing

Card dedicado:
- Total de ordens do dia
- Sessões (1ª impressão, 2ª impressão, etc)
- Operator + helpers
- Tempo total ativo
- Botões admin

### 18.5 On Break

Banner amarelo quando alguém está em pausa:
- Nome
- Duração
- Botão "Encerrar break" (admin)

### 18.6 Resumo por Suplemento

Sidebar com lista de todos os suplementos trabalhados hoje:
- Nome
- Tempo total dedicado
- Bottles produzidos
- Indicador 🟢 se ainda há tarefa aberta

### 18.7 Timeline por operador (NOVO)

Seção com card por operador ativo no dia. Cada card mostra timeline cronológica de todas as ações da pessoa:

```
Ana
─────────────────────────────────────
08:45 chegou
09:00 começou Limpeza
09:30 fechou Limpeza (30min)
09:32 começou Picking helper (com Simone)
10:00 fim helper Picking
10:05 começou Graviola 0124
11:00 fechou Graviola (165 bottles)
12:30 saiu pro almoço
13:30 voltou
13:35 começou Linha de Produção Saw Palmetto (joined Vitor)
...
```

Inclui tanto tarefas formais quanto eventos pontuais (F sem S, observações soltas que mencionaram trabalho). Filtra mensagens conversacionais ("bom dia", etc).

### 18.8 Notas e observações

Lista de notas do dia (ordenadas por timestamp). Editáveis pelo admin.

### 18.9 Calendário

Date picker no topo da página. Volta dias anteriores. Banner azul "Visualizando: DD/MM/YYYY" com botão "← Voltar para hoje". Polling pausa quando viewing histórico.

### 18.10 Indicador de saúde

Pequeno health badge no header:
- 🟢 Carolina conectada, parser ok, AI ok, DB ok
- 🟡 Algum subsistema degradado
- 🔴 Erro crítico

Click no badge mostra detalhes.

---

## 19. Calendário, backup, retenção

### 19.1 Histórico

Banco guarda **tudo permanentemente**. Calendário permite visualizar qualquer dia anterior. Sem TTL de exclusão automática.

### 19.2 Backup

Após 15 dias sem backup, painel admin mostra banner: "Já fazem 15 dias sem export. Faça backup pra evitar acumular dados no servidor."

Botão "Exportar tudo" gera JSON dump:
- Todas as tarefas, breaks, orders, contagens
- Todas as mensagens logadas
- Configurações
- Catálogo de suplementos
- Operadores e contas

Download direto no browser. Admin guarda onde quiser.

### 19.3 Retenção a longo prazo

Padrão: nada é deletado. Se o banco crescer demais (Railway cobra por espaço), criar política:
- Manter últimos 90 dias online no banco principal
- Backups automáticos semanais pra cold storage (S3, etc)
- Painel admin permite restaurar dia específico se necessário

Mas isso é otimização pra depois — começa sem deletar nada.


## 20. Stack técnica recomendada

### 20.1 Visão geral

| Componente | Tecnologia | Por quê |
|---|---|---|
| Servidor | Node.js + Express (atual) | Já existe, funciona, mantém |
| Banco | PostgreSQL (Railway) | Já existe, robusto |
| Slack | Slack Web API + Block Kit + Events API | Padrão do Slack |
| AI fallback parser | Anthropic Haiku 4.5 | Já configurado, $0.80/M tokens |
| Admin AI agent | Anthropic Sonnet ou Haiku | Sonnet pra raciocínio melhor, Haiku se quiser economizar |
| Frontend dashboard | HTML + Vanilla JS (atual) | Mantém, é simples e funciona |
| Hospedagem | Railway (atual) | Mantém |
| Code editor / agent | **Claude Code** | Migrar de Cowork |

### 20.2 Por que Claude Code ao invés de Cowork

| Aspecto | Cowork | Claude Code |
|---|---|---|
| Onde roda | Servidor remoto (sandbox) | Local no seu computador |
| Acesso a arquivos | Via mount (sync intermitente) | Direto no filesystem |
| Truncamento de arquivos | Acontece com arquivos grandes | Não acontece |
| Git integration | Limitado | Nativo, faz commits |
| Velocidade de feedback | Lento por causa de sync | Imediato |
| Capacidade pra projetos grandes | Frágil | Robusto |
| Custo | Incluído no Claude.ai | Incluído na sua subscription |

**Recomendação:** migrar todo desenvolvimento pra Claude Code. Manter este chat (Claude.ai) só pra planejamento estratégico e documentação como esse doc mestre.

### 20.3 Outras ferramentas opcionais

**MCP servers:** Claude Code suporta MCP (Model Context Protocol). Você pode conectar Claude Code direto ao Railway e ao Slack via MCP, deixando ele:
- Ver logs do Railway diretamente
- Testar endpoints sem deploy
- Mandar mensagens de teste no Slack
- Consultar a database real

Isso é otimização pra depois — comece sem MCP, adicione se sentir falta.

**Agent SDK / Managed Agents:** Anthropic tem framework pra criar agents AI autônomos com session management. Pode ser usado pra construir a "Carolina-admin AI agent" da seção 15. Vale considerar quando essa parte for implementada. Hoje a abordagem mais simples (chamar Haiku via API direto) funciona bem pro escopo.

**Code review automático:** existem ferramentas tipo CodeRabbit que fazem review de PRs automaticamente. **Não recomendo pra esse momento** — adicione depois que o sistema tiver smoke tests automatizados. Antes disso, é overhead sem ganho.

---

## 21. Como usar Claude Code para implementação

### 21.1 Instalação

No terminal (PowerShell ou Command Prompt):

```bash
npm install -g @anthropic-ai/claude-code
```

Depois, dentro da pasta do projeto:

```bash
cd "C:\Users\bruno\OneDrive\Documents\Claude Projects\Supplements Production Line\healthfare-tracker"
claude
```

Na primeira vez ele pede login (mesma conta Anthropic). Depois é só rodar `claude` e conversar.

### 21.2 Fluxo recomendado de trabalho

**Para cada entrega:**

1. Abre o doc mestre (este aqui) na seção da entrega
2. Roda `claude` no terminal dentro da pasta do projeto
3. Cola a seção da entrega como prompt inicial
4. Claude Code lê o código existente, propõe plano
5. Você aprova
6. Ele implementa, faz commits granulares
7. Você roda smoke test local (se possível)
8. Deploy pro Railway (`railway up`)
9. Smoke test em produção
10. Se passar, próxima entrega
11. Se não passar, debug com Claude Code antes de avançar

### 21.3 Hábitos pra evitar problemas

**Sempre commitar antes de mudanças grandes.** Você pode pedir ao Claude Code: "Antes de começar, faça um commit do estado atual com mensagem 'pre-feature-X'". Assim se algo quebra, `git reset` volta.

**Pedir testes junto com implementação.** "Implementa essa feature **e** escreve smoke tests que verificam que funciona". O parser, principalmente, deve ter testes automatizados — assim toda mudança futura é validada.

**Não pedir várias features de uma vez.** Uma entrega por sessão. Claude Code também perde contexto se você empilha muito.

**Validar deploy antes de fechar a sessão.** Roda smoke test em produção antes de declarar "feito".

**Manter um log das entregas.** Cada entrega gera um pequeno doc "Entrega N — o que foi feito, o que foi testado, o que ficou pendente". Acumula no diretório do projeto pra referência.

### 21.4 Quando usar Claude.ai (esse chat) vs Claude Code

| Tarefa | Onde |
|---|---|
| Planejar feature | Claude.ai |
| Discutir trade-offs | Claude.ai |
| Escrever doc | Claude.ai |
| Revisar logs e diagnosticar bug | Claude.ai ou Claude Code |
| Implementar feature | **Claude Code** |
| Refatorar código | **Claude Code** |
| Adicionar testes | **Claude Code** |
| Configurar deploy | **Claude Code** |
| Conversar com a Carolina-admin | (vai pro Slack, não é aqui) |

---

## 22. Roadmap de entregas faseadas

### Visão geral

7 entregas em ordem. Cada uma é um deploy independente com smoke test próprio. Não passa pra próxima sem o smoke test passar.

| # | Entrega | Esforço estimado | Dependências |
|---|---|---|---|
| 1 | Bugs urgentes (estabilização) | 1-2 dias | Nenhuma |
| 2 | Admin com poder total | 2-3 dias | #1 |
| 3 | App Home — visualização + fechar | 2-3 dias | #2 (operadores cadastrados) |
| 4 | App Home — modais de criar | 2-3 dias | #3 |
| 5 | Sistema de join + anúncios | 2 dias | #4 |
| 6 | Parsing AI híbrido + perguntas pendentes | 2-3 dias | #5 |
| 7 | Carolina-admin AI agent | 3-4 dias | #6 |

Total: 14-21 dias úteis de trabalho com Claude Code.

---

### Entrega 1 — Bugs urgentes (estabilização)

**Objetivo:** consertar tudo que tá quebrado hoje, sem feature nova. Estabilizar fundação.

**Escopo:**

1. **Mensagens editadas processadas.** Subscrever ao evento `message_changed` do Slack. Quando uma mensagem é editada, reprocessar como nova.

2. **Tag em qualquer posição/formato.** Reescrever detecção de S/F/P/N. Aceitar separadores: `:`, `;`, `/`, `-`, espaço, fim/início. Posição: qualquer (começo, meio, fim). Maiúscula ou minúscula. Regra de isolamento: letra deve ter espaço ou pontuação ou início/fim ao redor.

3. **Fim de break automático quando atividade nova.** Quando operador em break manda mensagem que vira tarefa (S:, "comecei", etc), fechar break automaticamente. Aceitar "voltei", "voltei do almoço", "tô de volta" como volta explícita.

4. **Co-trabalho básico.** Quando alguém abre tarefa com descrição parecida com tarefa já aberta de outra pessoa, perguntar com janela 20min. Se confirmar "ajudando", adicionar como participant. Linha de Produção é caso especial: se já tem Linha de Produção aberta, nova menção é join automático (sem perguntar).

5. **F sem S correspondente vira atividade pontual.** Em vez de ignorar, registrar como evento pontual com duração zero. Aparece na timeline.

6. **Bugs específicos:**
   - "F- ordens da segunda impressao feitas" deve fechar a orders_session (não confundir com nome de suplemento)
   - "Ja impacotei e ja iniciei a Revisao do Ginger" deve fechar ordens + abrir revisão Ginger
   - Quantidade de 2ª impressão somar no total
   - Tempo de packing contar corretamente

7. **Smoke test automatizado.** Criar arquivo de testes em `src/parser/__tests__/` com casos de teste pra cada padrão. Rodar com `npm test`. Toda mudança futura no parser passa por esses testes.

**Smoke test manual (você roda depois do deploy):**

- [ ] Manda `Bruno- Green Tea-0098-S` no canal → registra início de tarefa
- [ ] Manda `S; revisao Glutathione` → registra início de revisão
- [ ] Manda `F/ Berberine` → fecha Berberine
- [ ] Manda `voltei` em break aberto → fecha break
- [ ] Manda nova tarefa S em break aberto → fecha break + abre tarefa
- [ ] Edita uma mensagem depois de mandar → bot processa a edição
- [ ] Manda `F- ordens da segunda impressao feitas` → fecha orders_session
- [ ] Manda `Ja impacotei e ja iniciei a Revisao do Ginger` → fecha ordens + abre revisão Ginger
- [ ] Vitor manda `F: Fenugreek` quando Bruno abriu Fenugreek → fecha tarefa do Bruno (cross-operator)
- [ ] Manda `F: Limpeza` sem S correspondente → registra evento pontual

---

### Entrega 2 — Admin com poder total

**Objetivo:** dar ao admin controle completo do sistema via dashboard. Sem isso, fica impossível corrigir os erros que a Carolina inevitavelmente faz.

**Escopo:**

1. **Modal de edição completo pra todas as entidades.**
   - Tarefas: editar tipo, suplemento, batch, operador starter, lista de participants, started_at, ended_at, status, final_count, notes
   - Orders sessions: editar operator, helpers, pass_number, count, started_at, ended_at, notes
   - Production counts: editar todos os campos
   - Breaks: editar operator, started_at, ended_at, motivo
   - Notas: editar texto, tarefa vinculada
   - Operadores: CRUD completo
   - Suplementos: CRUD do catálogo

2. **Botões de ação em cada item:**
   - Editar
   - Fechar (pra abertos)
   - Reabrir (pra fechados)
   - Deletar (com confirmação)
   - Mesclar (drag & drop ou seleção múltipla)

3. **Criação manual:**
   - "+ Nova tarefa" (com todos os campos, inclusive started_at no passado)
   - "+ Nova orders_session"
   - "+ Novo break retroativo"
   - "+ Nova contagem manual"

4. **Mesclagem de tarefas (drag & drop ou botão "mesclar"):**
   - Selecionar 2+ tarefas
   - Botão "Mesclar"
   - Sistema usa S mais antigo + F mais recente
   - Aprende sinônimos em `task_aliases`

5. **Log de auditoria.** Toda mudança admin é registrada em tabela `admin_audit_log`. Página "Logs" mostra cronologia.

**Smoke test:**

- [ ] Cria tarefa nova com started_at de ontem
- [ ] Edita operator de uma tarefa existente
- [ ] Adiciona helper retroativo a uma tarefa
- [ ] Reabre tarefa fechada
- [ ] Mescla duas tarefas — verifica que aprendeu sinônimo
- [ ] Encerra break de outra pessoa
- [ ] Adiciona break retroativo
- [ ] Cria orders_session manual
- [ ] Edita count de production_count
- [ ] Cadastra novo operador
- [ ] Adiciona alias a suplemento

---

### Entrega 3 — App Home (visualização + fechar tarefa)

**Objetivo:** introduzir a App Home com visualização do estado e o botão mais útil (fechar tarefa). Validar que infraestrutura funciona antes de adicionar mais botões.

**Escopo:**

1. **Setup técnico:**
   - Habilitar Home Tab nas settings do app Carolina
   - Adicionar scopes Slack necessários
   - Reinstalar app
   - Subscrever a `app_home_opened`
   - Subscrever a `block_actions`
   - Adicionar Request URL pra Interactivity

2. **Cadastro de contas Slack:** página admin pra associar operadores a contas (precondição: entrega 2 cadastrou operadores).

3. **App Home — apenas visualização inicial:**
   - Header com display name da conta
   - Lista de tarefas abertas (todas, não só dessa conta)
   - Lista de quem está em break
   - Lista de concluídas hoje
   - Tudo read-only

4. **Botão Fechar tarefa (em cada tarefa aberta):**
   - Modal Passo 1: Quem está fechando?
   - Modal Passo 2: confirma + opcional bottles
   - Executa, anuncia no canal

5. **Botão Entrar em tarefa (em cada tarefa aberta):**
   - Modal Passo 1: Quem está entrando?
   - Modal Passo 2: confirma
   - Adiciona participant, anuncia

**Smoke test:**

- [ ] Abre Carolina na sidebar do Slack → App Home renderiza
- [ ] Vê todas as tarefas abertas listadas
- [ ] Clica em "Fechar tarefa" numa aberta → pop-up pergunta quem
- [ ] Seleciona "Sou Bruno" → confirma → tarefa fecha
- [ ] Anúncio aparece no canal de produção
- [ ] Dashboard atualiza
- [ ] Clica "Entrar em tarefa" → join funciona

---

### Entrega 4 — App Home (modais de criar)

**Objetivo:** completar a App Home com todos os modais de criação. Ponto onde funcionários podem operar 100% sem digitar tag.

**Escopo:**

1. **Modal Iniciar nova tarefa** — Passo 1 (quem) + Passo 2 (tipo, suplemento, batch, target, nota).

2. **Modal Registrar produção** — Passo 1 (quem) + Passo 2 (suplemento, batch, count).

3. **Modal Pausa** — Passo 1 (quem) + Passo 2 (motivo).

4. **Modal Voltei do break** — Passo 1 (quem) + confirmação rápida.

5. **Modal Nota** — Passo 1 (quem) + Passo 2 (texto + tarefa opcional).

6. **Indicador de input no dashboard:** ícone 🖱 / ⌨ / 🛠 em cada card.

7. **Reescrever mensagem de manhã** pra incluir como usar a App Home (mas mantém tags antigos como opção).

**Smoke test:**

- [ ] Cria tarefa via App Home → aparece no dashboard + anúncio no canal
- [ ] Registra produção via App Home
- [ ] Abre break via App Home → banner aparece
- [ ] Marca volta via App Home → banner some
- [ ] Adiciona nota via App Home
- [ ] Mensagem de manhã chega às 8:00 com texto novo
- [ ] Ícone 🖱 aparece em tarefas criadas via botão

---

### Entrega 5 — Sistema de join + anúncios completos

**Objetivo:** maturar o sistema de co-trabalho com anúncios detalhados e detecção inteligente.

**Escopo:**

1. **Linha de Produção como tarefa única.** Quando alguém menciona "ajudando na linha de produção" e existe Linha de Produção aberta, join automático (sem perguntar suplemento).

2. **Anúncios de join.** "Ana entrou na Linha de Produção do Green Tea junto com Vitor."

3. **Anúncios de fechamento agrupado.** "Linha de Produção do Green Tea finalizada — 1h45min. Trabalharam: Vitor, Ana, Simone."

4. **20 variações** de cada tipo de anúncio.

5. **Detecção de conflito refinada.** Quando descrição é parecida mas não Linha de Produção, perguntar com 20min de janela. Default se não responder: tarefa separada.

6. **Timeline individual no dashboard.** Cards por operador com todas as ações cronológicas.

**Smoke test:**

- [ ] Vitor abre Linha de Produção Saw Palmetto
- [ ] Ana manda "ajudando o Vitor na linha de produção" → join automático
- [ ] Anúncio "Ana entrou..." aparece
- [ ] Outro operador fecha → anúncio agrupado mostra todos os participantes
- [ ] Timeline da Ana mostra todas as ações dela do dia em ordem
- [ ] Anúncios variam (não repete a mesma frase 2x no mesmo dia)

---

### Entrega 6 — Parsing AI híbrido + perguntas pendentes

**Objetivo:** adicionar inteligência ao parser. AI fallback resolve casos que regex não dá conta. Perguntas pendentes ganham comportamento robusto com janela de 20min.

**Escopo:**

1. **Sistema de pending_questions.** Tabela + lógica. Janela 20min (configurável).

2. **Resolução de respostas indiretas.** Mudança de tarefa = resposta tácita "sim, terminei o anterior".

3. **Cérebro 2 — Haiku fallback.** Quando parser não tem certeza, manda mensagem + contexto pro Haiku. Recebe ação estruturada de volta.

4. **Loop prevention.** Cada pergunta é feita 1x. Se expira, registra no admin chat e desiste.

5. **Painel de configuração Carolina AI.** Página com toggles e campos editáveis (seção 15.8 do doc).

**Smoke test:**

- [ ] Carolina faz pergunta a operador → registra em pending_questions
- [ ] Operador responde com erro de digitação ("ja kbei sim") → parser regex falha → AI resolve → pergunta fecha
- [ ] Operador responde indiretamente (abre nova tarefa) → tarefa anterior fecha automaticamente
- [ ] Pergunta expira sem resposta → admin chat recebe notificação
- [ ] Carolina não repete a pergunta
- [ ] Mensagem ambígua de produção → AI interpreta corretamente
- [ ] Painel admin permite mudar janela de 20 pra 30min e funciona

---

### Entrega 7 — Carolina-admin como agente AI

**Objetivo:** transformar o chat admin em interface conversacional poderosa pra gerenciar tudo.

**Escopo:**

1. **Carolina lê canal de produção sob demanda.** Quando admin pergunta sobre algo do canal, busca mensagens relevantes via API Slack.

2. **Tools disponíveis ao agente:**
   - get_tasks_today / get_task_by_id
   - close_task / reopen_task / edit_task
   - get_breaks_today / end_break / add_break_retroactive
   - get_orders_today / create_orders_session / edit_orders_session
   - get_production_counts / update_count / add_count
   - get_messages_from_production_channel
   - get_operator_stats
   - update_config
   - post_to_production_channel

3. **Padrão propose-then-confirm.** Toda ação destrutiva passa pelo padrão: proposta → confirmação → execução → relatório.

4. **Re-pensar com contexto.** Admin pode corrigir proposta com texto livre. Carolina ajusta mantendo o histórico.

5. **Sugestão de prompts pra Claude Code.** Quando identifica bug no código, sugere prompt formatado.

6. **Configuração no painel admin.** Toggles: confirmação obrigatória, sugestão de prompts, etc.

**Smoke test:**

- [ ] Admin pergunta "o que tá acontecendo agora?" → resposta com estado atual
- [ ] Admin pede "fecha as ordens da Simone" → Carolina propõe, espera confirmação
- [ ] Admin corrige "na verdade é a segunda impressão" → Carolina re-propõe
- [ ] Admin diz "sim" → executa e relata
- [ ] Admin pergunta "por que isso aconteceu?" sobre evento passado → Carolina explica com contexto
- [ ] Carolina sugere prompt pro Claude Code quando identifica bug
- [ ] Toggle "confirmação obrigatória" off → Carolina executa direto (com aviso)
- [ ] Admin pede "manda no canal pra todo mundo X" → Carolina posta após confirmação

---

## Apêndice A — Catálogo de suplementos HealthFare

73 produtos. Sistema deve reconhecer variações de digitação e abreviações.

```
Potassium Iodide
Lithium Orotate
Benfotiamine
Pantothenic Acid
Valerian Root
Hyaluronic Acid
White Kidney Bean Extract
Ginger Root Extract
Vitamin B2 Riboflavin
Licorice Root Extract
Activated Charcoal
Aged Black Garlic
Pygeum
Graviola Soursop Extract
Myo Inositol
Pine Bark Extract
Stinging Nettle Root Leaf Extract
Plant Sterols
Bitter Melon Extract
D-Aspartic Acid
Green Tea Extract
Bilberry Extract
Skullcap
Butchers Broom
Devils Claw Root
Mullein Leaf Extract
He Shou Wu Fo-Ti
Chromium Picolinate
Yohimbine HCL
Melatonin
Saw Palmetto
NAC
L-Glutamine
Berberine with Ceylon Cinnamon
Vitamin B1 Thiamine
Tribulus Terrestris
Apple Cider Vinegar
Folic Acid
Glutathione
Ginkgo Biloba Extract
Aloe Vera
Rutin
Multi Collagen Peptides
Panax Ginseng & Ginkgo Biloba
Fenugreek Seed Extract
Banaba Leaf Extract
Psyllium Husk Fiber
Cayenne Pepper
Fadogia Agrestis Extract
Akkermansia Muciniphila
Gymnema Sylvestre Extract
Hawthorn Berry Extract
Magnesium Citrate
Chlorophyll
Magnesium Glycinate
Rhodiola Rosea
Turkesterone with Tongkat Ali
Magnesium
NAD Supplement
Stinging Nettle Root Extract
Beet Root
Acetyl L-Carnitine
```

**Aliases comuns que o sistema deve reconhecer:**

- "Fenugreek" / "Fenugrek" / "Fenugreco"
- "Glutathione" / "Glutationa"
- "Berberine" / "Berberina"
- "Ginger" / "Gengibre"
- "Green Tea" / "Chá Verde"
- "Saw Palmetto" / "Sabal"
- "Mullein" / "Verbasco"
- "Graviola" / "Soursop"
- "Glycinate" → contexto Magnesium Glycinate
- "Mullein Leaf" → Mullein Leaf Extract
- (admin pode adicionar mais no painel)

---

## Apêndice B — Bugs específicos a corrigir (Entrega 1)

Lista enumerada pra Claude Code ter referência clara.

| # | Caso | Comportamento atual | Comportamento esperado |
|---|---|---|---|
| B1 | "Bruno- Green Tea-0098-S" | Ignorado (S no fim com hífen) | Reconhece como início de Green Tea 0098 pra Bruno |
| B2 | "S; revisao Glutathione" | Ignorado (separador ;) | Reconhece como início de revisão de Glutathione |
| B3 | "F/ Berberine" | Ignorado (separador /) | Reconhece como fechamento de Berberine |
| B4 | Mensagem editada | Ignorada | Reprocessada como nova |
| B5 | "voltei" durante break | Não fecha break | Fecha break |
| B6 | Nova tarefa durante break | Cria tarefa, break continua | Cria tarefa + fecha break |
| B7 | "Ana - S: ordens" enquanto Simone tem Ordens aberto | Cria tarefa separada | Pergunta se é join (janela 20min) |
| B8 | "ajudando o Vitor na linha de producao" enquanto Vitor tem Linha aberta | Pede suplemento | Join automático (Linha de Produção é única) |
| B9 | Vitor manda "F: Fenugreek" quando Bruno abriu Fenugreek | Não fecha | Fecha a tarefa do Bruno, registra Vitor como closer |
| B10 | "F- ordens da segunda impressao feitas" | Confundido com nome de suplemento | Fecha a orders_session aberta |
| B11 | "Ja impacotei e ja iniciei a Revisao do Ginger" | Não processa nada | Fecha ordens + abre revisão Ginger |
| B12 | Simone manda "Segunda impressao feita" sem número | Cria sessão sem perguntar | Cria sessão + pergunta count (20min janela) |
| B13 | "F Limpeza" (sem dois pontos, < 10 chars) | Ignorado por filtro de tamanho | Reconhece como fechamento |
| B14 | Quantidade de 2ª impressão não soma no total | Ignorada | Soma no total do dia |
| B15 | F sem S correspondente | Ignorado / pergunta | Registra como atividade pontual |
| B16 | Admin não consegue editar Picking & Packing | Botão não existe | Botão de edit em cada orders_session |
| B17 | Admin não consegue tirar pessoa de break | Botão não existe | Botão "Encerrar break" em cada pausa ativa |
| B18 | Carolina repete pergunta infinitamente | Sem controle | Faz 1x, expira em 20min, avisa admin |

---

## Fim do documento

Este documento mestre é a referência viva do projeto. Atualize quando decisões mudarem. Use as seções de roadmap como base pra criar prompts ao Claude Code, uma entrega por vez.

**Próximos passos imediatos:**

1. Ler este documento completo
2. Instalar Claude Code (`npm install -g @anthropic-ai/claude-code`)
3. Começar Entrega 1 — Bugs urgentes
4. Rodar smoke test da Entrega 1
5. Se passar, partir pra Entrega 2

Boa sorte 🙂
