# HEALTHFARE — HANDOFF V3 (OPERAÇÃO REAL)

> **DOCUMENTO DE REFERÊNCIA** | 21 Maio 2026 · **ADENDO 12 Jun 2026 abaixo**
> Base do Sprint 2 (Dashboard + Esperado-vs-Realizado + Chat com a Carolina)
> Fundamentado no estudo direto do Slack de 14–21 Maio 2026 (operação real, não suposição)
> Atualiza e supera o HANDOFF MASTER (18 Mai, era pré-V3)

---

## ⚡ ADENDO — ESTADO 12 JUN 2026 (pivot Operator Page + Gemini)

**Mudança de arquitetura de input:** a **Operator Page** (`/op`, PIN 4
dígitos por operador) virou o input PRIMÁRIO — botões touch-first
escrevem DIRETO em `v3.events`/`v3.production_counts`
(`source='operator_page'`, `confidence='high'`), **sem LLM**. O Slack
continua como input ALTERNATIVO indefinidamente (Observer segue lendo);
um **dedupe-watcher** (cron 60s) casa registros duplicados
(pessoa+atividade+lote, ±2min) marcando o do Slack como
`superseded_by_event_id`, e registros do Slack SEM correspondente na
página viram notificação pro admin no #admin-orin (✅ aceita / ❌ ignora /
📝 edita — ver `docs/ADMIN_NOTIFICATIONS.md`).

**LLM:** provider primário agora é **Gemini 2.5 Flash (free tier, $0)**
com **fallback automático pro Anthropic Sonnet** (3 falhas/5min →
curto-circuito; `LLM_PROVIDER=anthropic` = rollback de 1 env var).
Custo projetado: de ~$102/mês → **~$0-5/mês**. Quando o Bruno desligar o
Slack pros operadores (plano em `docs/SLACK_CUTOFF_PLAN` — futuro),
cai pra ~$0.

**Entregas 12/jun (commits na v3-reset):** architect API read-only
(11 endpoints, 2 tokens), Operator Page completa (migration 018:
PIN scrypt, sessions, events.source, CHECK audit ampliado; cowork A+B;
voice Web Speech; clock-out P5), fix voice diagnóstico, ajustes de UI
(Almoço quick, Pausa exige nota), Gemini dual-provider, migration 020
dedupe_links + worker + NotificationHandler. Docs:
`OPERATOR_PAGE.md`, `ADMIN_NOTIFICATIONS.md`.

**Persona Carolina:** INTOCADA (mulher carioca no canal de produção;
admite ser AI só no admin chat). `silent_text` segue Bruno-only.

**Bloco autônomo noturno (12→13/jun) — entregas adicionais:**
- **Dead-letter de retry** (migration 021): msg que falha 3x no LLM sai
  da fila (audit + notification + Carolina avisa) — fim do risco de
  ~$20/dia por msg envenenada. Telemetria em
  `/api/v3/architect/diagnostics/queue`.
- **Admin Panel `/admin/`** (path novo; V4 intocado): senha
  `ADMIN_PASSWORD` (Railway), gerenciar operadores (PIN, auto-logoff,
  count-exempt, ativar/desativar, force-logout, timeline 7d) + **inbox
  de notificações** (✅/❌/📝 espelhando o Slack). API: `/api/adminpanel/*`
  (namespace novo — `/api/admin/*` era do V2 legado).
- **query_status semântico** (BUG #4): "quem está na linha?" filtra
  production_line; "formulando?", "limpeza?", "ordens?", nome de pessoa.
- **Cleanup**: 26 scripts one-shot arquivados em `scripts/archive/`;
  `.gitignore` protege `snapshots/` e config local.
- **Stale check**: 0 events abertos >2 dias (base limpa).
- Docs: `ADMIN_QUICK_REFERENCE.md`, `OPERATOR_CARD.md` (+ .html
  printável pra colar na fábrica).

**Rotina sugerida pro rollout:** rotacionar `GEMINI_API_KEY` (a inicial
foi exposta) → liberar o Vitor na página → acompanhar 1-2 dias
(#admin-orin + `/admin/` + `diagnostics/llm_metrics`) → liberar o resto
→ quando confortável, desligar o Slack pros operadores (custo LLM ≈ $0).

**Bloco zera-sistema (13/jun) — amarrou as pontas pra produção real:**
- **Carolina admin commands robustos**: `close_tasks` (fecha todas as tasks
  abertas de 1+ pessoas — resolve "@carolina finaliza os tasks do Vitor" e
  "fecha as atividades do Vitor e da Ana") e `close_specific_event` (fecha
  ev por id), com confirmação ✅ que lista as tasks antes; exclui
  long_running. (create/edit/delete/query já existiam.)
- **Analytics** (aba 📊 do /admin): bottles/dia, horas/operador, eventos por
  tipo, top supplements, breakdown diário; drill-down operador/supplement.
- **Histórico de auditoria** (aba 📋): audit_log filtrável e legível.
- **Hardening** (`docs/SECURITY.md`): CSP/HSTS/X-Frame nas rotas novas,
  rate-limits, brute-force ban (10/h→24h + alerta), session cleanup 8h.
- **CRUD de operadores** no /admin (criar/remover, soft-delete preserva
  histórico).
- **PWA /op** (instalável, offline: shell cacheado + fila de eventos que
  sincroniza quando a internet volta; botão 📱 Instalar). Fluxo online
  intocado.
- **Alertas proativos** (cron 30min, `WORKER_PROACTIVE_ALERTS_ENABLED`):
  operador ocioso >2h, task aberta >3h, contagem de bottles anômala (>70%
  da média) → notificação + Carolina no #admin-orin, resolvível na inbox.

Env vars novas: `ADMIN_PASSWORD`, `WORKER_PROACTIVE_ALERTS_ENABLED`.
Suite ~2053 tests. Custo LLM segue ~$0 (Gemini). Docs: `SECURITY.md`,
`ADMIN_QUICK_REFERENCE.md` (atualizado), `OPERATOR_CARD`.

**Bloco zera-sistema FASE 0 (13/jun) — UI fixes + voz:**
- **Grupos /op**: Envio Clínica → grupo 🚚 Envio; novo **✨ Algo Especial**
  (`special_task`, catch-all em Outros).
- **Regras por slug** (nota/quantidade obrigatórias, validadas front+server):
  | slug | nota obrig. | qtd ordens obrig. |
  |---|---|---|
  | break, meeting, training, special_task | ✅ | — |
  | order_printing, order_printing_2 | ✅ | ✅ (orders_printed INT>0) |
  | lunch, cleaning, production_line, formulation, review, packaging, labeling, orders, shipping, dc_shipment, clinic_shipment, box_closing, marketplace_prep, encapsulation, material_handling… | — | — |
- **Voice recording** (migration 022): MediaRecorder grava áudio junto da
  transcrição (Web Speech); até 60s; salvo em `v3.voice_recordings.audio_bytes`
  (BYTEA — **não há volume de app persistente**, então áudio vive no Postgres;
  cap 5MB, rate 20/h/pessoa). Admin ouve em 📊 Analytics → "🎤 Notas recentes".
  Offline: áudio NÃO enfileira (grande p/ localStorage) — o **texto** da nota
  persiste via Web Speech.
- **Analytics+**: min/ordem (order_printing), card de uso de voz.
- **Proativos+**: ordens anômalas (>3× média do operador), quota de áudio (≥400MB).
- Env: nenhuma nova. Migration 022 aplicada. Suite ~2060.

*(O restante deste documento descreve o estado de 21/mai — segue válido
como contexto da operação; onde conflitar com este adendo, vale o adendo.)*

---

## ÍNDICE

1. Resumo executivo
2. Onde o V3 está hoje (estado real)
3. HealthFare — a empresa e a operação real
4. Pessoas, contas e identificação
5. Os três fluxos independentes (Produção / P&P / Suporte)
6. Picking & Packing (fluxo da Simone — detalhado)
7. Esperado vs Realizado + deadlines configuráveis
8. O que cada um faz e o que costuma esquecer
9. Carolina V3 — o que ela é agora
10. O Chat com a Carolina (feature nova do Sprint 2)
11. Tasks futuras, planejamento e notificação
12. O que o dashboard precisa mostrar
13. Princípios não-negociáveis (atualizados pro V3)
14. IDs e contatos
15. Glossário do vocabulário real do time

---

## 1. RESUMO EXECUTIVO

HealthFare é uma fabricante de suplementos em Fort Lauderdale, Florida. Produz cápsulas e tablets, vende em FBA/Amazon, Walmart, TikTok Shop e eBay. Time pequeno (4 operadores, 1 manager, 2 owners) que se comunica em português brasileiro num canal de Slack (`#orders-and-inventory`).

O sistema **Carolina V3** (também chamado "HealthFare Production") é um rastreador de produção que lê CADA mensagem do canal via LLM (Claude Sonnet 4.6), entende linguagem livre em português, e registra o que cada pessoa está fazendo numa linha do tempo contínua — sem exigir códigos. O V3 substituiu um sistema legado que capturava quase nada.

**O objetivo central do sistema (nas palavras do Bruno):** medir quanto tempo cada coisa realmente leva, pra parar de chutar metas e passar a saber o que é realista esperar do time. Hoje as metas do Henrique são chute ("esperado é finalizar hoje") porque ninguém mede. O sistema existe pra trocar chute por dados.

**Estado atual:** Sprint 1 concluído. V3 capturando o canal ao vivo em modo shadow (observa e registra, não reage). Validado com dados reais — as timelines batem com a realidade. Próximo: Sprint 2 (dashboard de verdade + loop de metas + chat com a Carolina), depois virar `active`.

---

## 2. ONDE O V3 ESTÁ HOJE (ESTADO REAL — 21 MAI 2026)

- **Captura ao vivo:** webhook `/slack/events-v2` recebendo o canal privado `C09UNBXFRKK` em tempo real (via event `message.groups`). Funcionando.
- **Modo:** SHADOW. O Observer lê, entende e registra em `v3.*`, mas NÃO reage, NÃO posta, NÃO manda DM. O time não vê nada.
- **Qualidade:** ~88% das mensagens em alta/média confiança. As timelines de Ana, Bruno Sarmento, Simone e Vitor batem com o que aconteceu de verdade.
- **Catálogo:** 64 produtos com aliases em `v3.products` (não mais hardcoded — agora é dado).
- **Admins reconhecidos:** Thassio e Henrique viram `admin_intervention` (não criam event de produção). Bruno Camp ainda com `slack_user_id=NULL` (decisão do Bruno: raramente posta).
- **Custo:** ~$1–1.50/dia de LLM.
- **Endpoints de monitoramento (todos `?pin=510510`):** `/overview` (dashboard temporário ao vivo), `/timeline?date=`, `/messages-shadow`, `/events-shadow`, `/llm-metrics`, `/health`.
- **Legado:** ainda rodando em paralelo (poller próprio em `public.*`), inofensivo. Será desligado no cutover.

### Bugs reais já corrigidos no Sprint 1 (lições)

- **Catálogo hardcoded no parser legado** (não no banco) — por isso a migração só trouxe 14 de 73 produtos. Causa raiz do bug "produto não está no catálogo". Resolvido carregando os 64 como dados.
- **"S:"/"F:" virando inicial de pessoa** — o Vitor abre mensagens com "S:" (Start) e o sistema lia como "Simone". As atividades dele iam pro timeline da Simone. Resolvido: S/F são marcadores de verbo (começar/terminar), nunca inicial de pessoa. Iniciais soltas removidas dos aliases de identificação.
- **Cross-account "Bruno"** — Bruno Sarmento posta da conta do Vitor; o sistema confundia. Resolvido: nome no texto vence dono da conta; no canal de produção "Bruno" = sempre Bruno Sarmento.
- **Cache de falha** — erro transitório (crédito/429) envenenava o cache de resolução de autor. Resolvido: só cacheia resoluções bem-sucedidas.
- **Dupla-processamento** — worker re-pegava mensagem lenta. Resolvido com claim no DB.

---

## 3. HEALTHFARE — A EMPRESA E A OPERAÇÃO REAL

### 3.1 Básico

- Fabricante de suplementos (cápsulas e tablets), Fort Lauderdale FL.
- Timezone operacional: America/New_York (DST-aware).
- Idioma do time: português brasileiro.
- Marketplaces: FBA/Amazon, Walmart, TikTok Shop, eBay.
- Destinos de envio que aparecem no chat: **FBA**, **WH** (warehouse), **WFS** (Walmart Fulfillment Services), **WR**.
- Horário típico observado: começa ~8:00–9:45, termina ~18:00–18:30. Almoço entre ~13:00–15:00 (escalonado, não todos juntos).

### 3.2 Como o trabalho realmente acontece (observado no Slack)

Dois fluxos rodam **em paralelo** todo dia:

1. **Produção** (fabricar os suplementos) — Vitor/Bruno Sarmento formulam e encapsulam; Ana faz a linha de produção e revisão. Roda o dia todo, lote por lote.
2. **Picking & Packing / Ordens** (enviar pedidos dos marketplaces) — Simone faz de manhã, às vezes o dia todo, Ana ou Vitor ajudam. Imprime ordens, cola labels, embala, fecha caixas, envia.

Esses dois fluxos se cruzam: a mesma pessoa pode pular de um pro outro ("Ana- F; ordens / S: linha de producao"), e produtos prontos da produção viram estoque que o P&P envia.

### 3.3 Realidades operacionais que aparecem muito (importantes pro sistema)

- **Máquinas rodando sozinhas:** "Potassium rodando", "máquina de cápsulas iniciada" — a máquina trabalha sozinha enquanto a pessoa faz outra coisa. Um processo pode estar "ativo" sem alguém parado nele. (O sistema precisa entender que "rodando" é um estado de máquina, não necessariamente a pessoa ocupada.)
- **Linha para muito** por problemas de label/FNSKU, máquina de silica, máquina de bottle, falta de energia, balança queimada. Esses paços valem ouro de medir (downtime real).
- **Manutenção no meio da produção:** "pausa no Lithium para manutenção do Potassium" — trocas de contexto constantes.
- **Transformação/retrabalho:** trocar label, transformar Lithium de 60 para 200 tablets, refazer pesagem, trocar labels danificados. Isso é trabalho real e recorrente (não é "Transformação sem sentido" como o handoff antigo dizia — é retrabalho de produto).
- **Problema de eficiência de fórmula** (18 Mai, Thassio): as fórmulas do Bruno Sarmento faltaram 50+ unidades vs as do Vitor que sobravam. Sugere métrica futura: rendimento real vs esperado por formulador / por lote.

---

## 4. PESSOAS, CONTAS E IDENTIFICAÇÃO

### 4.1 Princípio core (mantido): pessoas são dados, não código

Zero nome hardcoded. Identificação é por entendimento do LLM, não regex. Turnover-proof: trocar operador não quebra nada.

### 4.2 Quem é quem

| Nome | Papel | Slack User ID | Conta(s) que usa |
|------|-------|---------------|------------------|
| Bruno Camp | owner | `U03URLL1D4L` | a própria (raramente posta) |
| Thassio | owner | `U03S46L2EUA` | a própria |
| Henrique Monteiro | manager | `U085SDY3F4Z` | a própria |
| Vitor | operator | `U08JC85HMNE` | a própria + compartilhadas |
| Simone | operator | `U07FG34TMPF` | a própria + compartilhadas |
| Ana | operator | (sem conta própria) | posta via Production Line `U0AU8N8FA00` e outras |
| Bruno Sarmento | operator | (sem conta própria) | posta via conta do Vitor e Production Line |

### 4.3 Regras de identificação (validadas no Slack)

- **Conta própria + sem outro nome no texto → autor = dono da conta.** Ex: conta do Vitor (`U08JC85HMNE`) com "S: Iniciando revisão" = Vitor.
- **Nome explícito no texto vence o dono da conta.** Ex: conta do Vitor com "Bruno- linha de produção" = Bruno Sarmento. Confirmado por "Henrique sou eu Bruno" (21 Mai).
- **No canal de produção, "Bruno" = sempre Bruno Sarmento** (operator). Bruno Camp (owner) não trabalha na linha.
- **"S:"/"F:"/"P:"/"N:" são marcadores legados de verbo** (Start/Finish/Produção/Nota), NUNCA inicial de pessoa. O time está sendo orientado a largar esses códigos e escrever natural — o V3 entende os dois jeitos.
- **Production Line `U0AU8N8FA00`** é conta neutra/compartilhada. Quase sempre quem assina é "Ana-" no texto. Sem assinatura — resolver por contexto.

### 4.4 Os códigos legados (S/F/P/N) — em extinção

A Carolina legada ensinou o time a usar: **S** (start), **F** (finish), **P** (produção/quantidade), **N** (nota). O time usa de forma inconsistente ("S:", "S-", "S;", às vezes nada). **Decisão do Bruno:** largar os códigos, orientar o time a escrever naturalmente o que está fazendo. O V3 não precisa deles. Mas eles vão continuar aparecendo por semanas, então o V3 trata como dica de verbo, não como obrigação.

---

## 5. OS TRÊS FLUXOS INDEPENDENTES (correção crítica)

> **ATENÇÃO — esta é a estrutura correta da operação, validada pelo Bruno (21 Mai).**
> O handoff antigo errava ao tratar P&P como "fase de um workflow". **P&P NÃO é fase de produção.** São TRÊS fluxos que rodam EM PARALELO e são INDEPENDENTES entre si.

```
== FLUXO A: PRODUÇÃO =======  == FLUXO B: PICKING & PACKING ==  == FLUXO C: SUPORTE ==
| fabricar suplementos     |  | enviar pedidos de clientes   |  | tarefas avulsas    |
| (cria estoque novo)      |  | (puxa do estoque existente)  |  | (eventual)         |
| fases CONECTADAS entre si|  | INDEPENDENTE da produção     |  | não preso a fluxo  |
============================  ================================  ======================
        roda o dia todo              manhã, deadline ~1pm              quando precisa
```

### FLUXO A — Produção (fabricar)

Fabrica os suplementos do zero. As fases SÃO conectadas (uma tende a depender da outra). Sequência **provável** (a confirmar e ajustar — ver nota abaixo):

```
Formulação → Mix → Encapsulação → Revisão → Linha de Produção → Contagem
```

| Fase | O que é | Atividades reais |
|------|---------|------------------|
| **Formulação** | Pesar matéria-prima na proporção da fórmula | "Formula Vitamin B2", "separando Plant para o Mix" |
| **Mix** | Misturar os ingredientes pesados | "no mix", "Mixzado pra amanhã" |
| **Encapsulação** | Máquina de cápsulas ou tablet (ou à mão) | "máquina de cápsulas Benfotiamine", "04 Akkermansia manualmente" |
| **Revisão** | QA do produto encapsulado | "Revisando Vita B2", frequentemente cowork |
| **Linha de Produção** | Envase em garrafas (tampa, lacre, label) | "linha de produção Plant 0136" |
| **Contagem** | Contar produto final — pode ser **bottles ou boxes** (depende do contexto) | reportado no EOD ("Plant 0136 P: 568"); cuidado com duplicação (ver 7.6) |

> **⚠️ NOTA DE INCERTEZA SOBRE A ORDEM (importante — decisão do Bruno: deixar ajustável).**
> A sequência acima é a ordem PROVÁVEL inferida do estudo do Slack, mas NÃO foi confirmada rastreando um lote único do início ao fim. Pontos não confirmados:
> - **Revisão** aparece em vários momentos (antes da linha, "revisão parcial", durante) — pode acontecer em mais de um ponto, não só entre Encapsulação e Linha.
> - **Mix** pode ser etapa separada ou parte da Formulação.
> - **Contagem** pode ser uma fase real ou só o reporte "P:" no fim do dia.
>
> **Implicação pro Sprint 2:** a ordem das fases NÃO deve ser hardcoded como sequência rígida. Deve ser **configurável** (admin define/reordena as fases de cada fluxo), e os pré-requisitos são SOFT (avisa se pular, nunca bloqueia). Assim, conforme os dados reais revelarem a sequência verdadeira (o próprio objetivo do sistema), o admin ajusta sem mexer em código. Começar flexível, enrijecer com dados — igual aos deadlines.

Notas adicionais: máquinas rodam sozinhas ("Potassium rodando") enquanto a pessoa faz outra coisa. "Linha de Produção" = especificamente o envase, não "produção" genérica. Encapsulação à mão existe (Akkermansia).

### FLUXO B — Picking & Packing (enviar pedidos)

**Completamente separado da produção.** São pedidos de clientes que chegam ao longo do dia, atendidos com o **estoque que já existe no warehouse**. NÃO depende da linha, encapsulação ou formulação.

- **Quem:** Simone e Ana, **toda manhã, logo que chegam.**
- **Deadline:** tem que estar pronto até ~**1pm** (quando o correio/post office chega). Deadline é **configurável** (ver seção 7.7).
- **A Simone reporta quantos foram empacotados ao longo do dia.**
- Detalhamento do fluxo: ver seção 6.

### FLUXO C — Suporte (avulso)

Tarefas que acontecem eventualmente, não presas a nenhum fluxo:
- Stock check / contagem de estoque
- Limpeza (warehouse, área)
- Organização
- Conserto de máquina (silica, bottle, label, FNSKU)
- Transformação / retrabalho (trocar label, transformar Lithium 60→200 tablets, refazer pesagem)
- Manutenção
- Reunião, Treinamento
- Almoço / pausa (meta-atividade)

### Por que a distinção importa pro dashboard

Cada fluxo tem sua própria lógica, métrica e visualização:
- **Produção** se mede por lote (tempo por fase, esperado vs realizado).
- **P&P** se mede por dia (quantas ordens, bateu o deadline do correio).
- **Suporte** se mede por ocorrência (quanto tempo parado em conserto, frequência de retrabalho).

Misturar os três (como o legado fazia) é a causa de muita confusão. No dashboard, são três seções separadas.

---

## 6. PICKING & PACKING (fluxo da Simone — detalhado)

Esta é uma **seção de primeira classe do dashboard** (decisão do Bruno — não é fase 2). É o que a Simone faz e precisa ser rastreado com início e fim de cada etapa.

### 6.1 O fluxo real (observado)

1. **Impressão das ordens** (1ª impressão) — "impressão das 502 ordens", "impressão das ordens - 168/169/152". O número é a quantidade de ordens.
2. **Segunda impressão** — "segunda impressão ordens". **A Simone frequentemente esquece de passar a quantidade na segunda impressão.** (Bruno quer que o sistema/Carolina aprenda a cobrar isso.)
3. **Colar labels nos envelopes** — "colocando as labels das ordens nos envelopes".
4. **Colocar produtos nos envelopes** — "colocando os produtos nos envelopes".
5. **Selar / fechar caixas** — "fechando as caixas para envio FBA", "double check e fechamento das caixas".
6. **Envio** — para FBA/Walmart/TikTok/eBay.

### 6.2 O que mais acontece no P&P

- **Contagem por ordem/produto:** "Saiu 01 Feminiva", "Nessa saiu 01 charcoal", "Akkermansia - 01", "#2846 - Glycinate 01". A Simone reporta o que saiu em cada ordem.
- **Conversa com o Henrique sobre ordens específicas:** números de ordem (#2846, #2854, #2859, #2860), marketplace (TikTok, Amazon, FBA, Walmart), ordens overdue, decisão de fulfillment.
- **Entrada de produto (returns):** "Entrada produto (Return) Vitamin B2 - 01".
- **FNSKU:** "colocando FNSKU em 110 D-Aspartic para envio Walmart".
- **Transformação/troca de label:** "transformando 190 unidades Lithium de 60 para 200 tablets e trocando as labels".

### 6.3 Futuro: integração Veeqo

Bruno planeja integrar a **API do Veeqo** pra ter o momento exato da impressão e a quantidade de ordens automaticamente. Por enquanto, o sistema rastreia o que a Simone reporta no chat + começo/fim de cada etapa. O design do P&P deve deixar espaço pra essa integração depois.

### 6.4 O que rastrear agora no P&P

- Início e fim de cada etapa (impressão, 2ª impressão, labels, embalar, fechar caixas, envio).
- Quantidades quando mencionadas (nº de ordens, unidades por produto).
- O que ficou pendente ("quais produtos ficaram pendentes nas ordens de hoje").
- **Padrões de esquecimento** (ex: quantidade na 2ª impressão) — pra Carolina aprender a cobrar.

---

## 7. ESPERADO vs REALIZADO (o loop de metas)

Este é o coração do valor que o Bruno quer. Funciona assim na realidade:

### 7.1 De manhã — a META (esperado)

O Henrique posta o esperado do dia (nem sempre, mas frequente). Exemplos reais:

- 19 Mai 07:50 — "Separação das próximas formulações. Esperado é que sejam finalizadas hoje. BR-2026-0135 PLANT STEROLS 750>FBA / BR-2026-0136 PLANT STEROLS 100>WFS, 150>WR, 500>FBA"
- 18 Mai 14:49 — "BR-2026-0134 > PLANT STEROLS FBA>750"
- 15 Mai 13:44 — "BR-2026-0131 APPLE CIDER 240>WH, 660>FBA"

Estrutura da meta: **lote (BR-2026-XXXX) + produto + quantidade(s) por destino (FBA/WH/WFS/WR)**.

### 7.2 Ao longo do dia — o trabalho

O time fabrica. O V3 rastreia tempo real de cada fase por lote.

### 7.3 Fim do dia — o REALIZADO

Ana (ou alguém) posta a produção do dia. Exemplos reais:

- 19 Mai 18:27 — "produção de hoje: Plant (0135) -P; 723 / Plant (0136) - P:568"
- 20 Mai 18:22 — "Produção de hoje: Plant (0136) P; 143 / Vitamin B2 (0142) P; 951 / Vitamin B2 (0151) P; 193"
- 15 Mai 18:08 — "produção de hoje: Apple Cider (0131) P: 869 / Acido Hyaluronic (0137) P:541"

Estrutura do realizado: **produto (lote) + quantidade produzida**.

### 7.4 O loop que o dashboard fecha

Quando você busca "Plant Sterols", o dashboard deve mostrar, por dia/lote:
- **Esperado:** 750 FBA (0135), 750 total (0136 com destinos)
- **Realizado:** 723 (0135), 568 (0136)
- **Atingiu?** 0135: 723/750 = 96% (não bateu por 27). 0136: bateu.
- **Tempo real:** quanto levou cada fase do lote (formulação X min, encapsulação Y, linha Z).

### 7.5 Por que isso importa (Bruno, nas palavras dele)

"Hoje a gente não tem como rastrear quanto eles fazem por dia, fica difícil colocar uma meta de produção. Por isso fazemos esse sistema — queremos que ele rastreie, nos dê números reais, pra sabermos quantas horas/minutos/segundos as coisas levam, pra controlar quanto podemos esperar deles, e tornar isso uma coisa contínua. Todo dia de manhã a Carolina vai saber o que esperar deles." Destino (FBA/WFS/WR) por enquanto é guardado mas não usado no tracking — entra em fase 2.

### 7.6 Contagem: bottles vs boxes + detecção de duplicação (regra crítica)

Duas realidades que o sistema precisa tratar:

**1. A contagem pode ser de BOTTLES ou de BOXES — depende do contexto.**
"Contei 568" pode ser 568 garrafas OU 568 caixas. O sistema precisa inferir a unidade pelo contexto (a fase, o produto, o que foi dito antes). Quando não der pra ter certeza da unidade, marca como incerto e não assume.

> **Heurística de magnitude (dica do Bruno):** números **acima de ~50 raramente são caixas** — quase sempre são bottles. Caixas costumam vir em quantidades pequenas (10, 20, 30). Pode chegar a 200 caixas, mas é raro. Então: número grande (50+) → provavelmente bottles; número pequeno e redondo (10/20/30) → pode ser caixas. É dica de inferência, não regra rígida — o contexto ainda manda, e na dúvida marca incerto.

**2. Risco de duplicação de quantidade — o sistema deve ALERTAR, não somar cego.**
Às vezes a quantidade contada durante o dia (fase Contagem) é a MESMA reportada no EOD ("produção de hoje"). Ex: a pessoa conta 568 de manhã e à tarde o EOD repete "Plant 0136 P: 568". É o mesmo 568, não 1136.

> **Regra:** quando o sistema detectar o MESMO número sendo reportado mais de uma vez para o mesmo produto/lote (ou qualquer sinal de possível dupla-entrada de quantidade), ele deve **chamar atenção / sinalizar** — "esse 568 já foi reportado antes; é a mesma contagem ou é adicional?" — em vez de somar automaticamente. O admin (ou a Carolina via chat de aprendizado) confirma se é duplicata ou quantidade nova.

Isso conecta com o princípio "nada se perde" (registra ambos, mas marca a suspeita) e com o chat de aprendizado da Carolina (seção 10) — ela traz a suspeita, o Bruno confirma, ela aprende o padrão.

### 7.7 Deadlines configuráveis (decisão do Bruno)

Deadlines NÃO são fixos no código. O admin define e muda quando quiser. Razão: a HealthFare ainda está descobrindo o próprio timing real — hoje os deadlines são flexíveis; conforme o sistema der dados, ficam mais rígidos. O sistema deve **suportar** essa rigidez crescente sem assumir nada hoje.

Implementação recomendada: **deadlines como configuração editável por fluxo** (não hardcoded), com:
- Um deadline por fluxo (P&P, Envio FBA/Walmart, Produção), editável no dashboard.
- Valor atual + histórico de mudança (auditado).
- O sistema usa o deadline vigente pra: (a) calcular "bateu ou não", (b) alertar conforme se aproxima ("faltam 2h pro corte do correio e ainda tem 30 ordens").
- Deadlines podem ser recorrentes (todo dia 1pm) ou pontuais (corte do FBA nesta sexta).

Exemplos reais que viram deadlines configuráveis:
- **P&P / correio:** ~1pm diário (hoje flexível).
- **Envio FBA/Walmart:** dia/hora de corte semanal (muda conforme a semana).
- **Produção:** "esperado finalizar o lote hoje" (Henrique) — deadline pontual por lote quando quiser.

> O Bruno: "queremos ser mais estritos, mas dependemos de entender nosso timing — e é isso que o sistema vai nos ajudar a fazer."

---

## 8. O QUE CADA UM FAZ E O QUE COSTUMA ESQUECER

> Padrões observados, NÃO regras (qualquer um pode fazer qualquer coisa).

- **Ana:** linha de produção, revisão, etiquetagem, conserto de máquina (label/silica/FNSKU), ajuda a Simone nas ordens. Posta via Production Line. Costuma narrar bem os problemas da linha ("linha parada vou arrumar a label").
- **Simone:** Picking & Packing (ordens) de manhã, depois linha/revisão/Akkermansia manual. Posta da conta dela. **Esquece de passar quantidade na 2ª impressão.** Às vezes não fecha atividade.
- **Vitor:** formulação, encapsulação (máquina de cápsulas/tablet), revisão, linha. Posta da conta dele. Também posta por Bruno Sarmento.
- **Bruno Sarmento:** formulação, encapsulação, manutenção de máquina, linha. Não tem conta própria — posta via conta do Vitor (sempre assinando "Bruno-") e Production Line.
- **Henrique:** manager. Posta metas de manhã, gerencia ordens (overdue, marketplace, fulfillment), pede contagens de estoque, libera produtos no sistema. Não opera linha.
- **Thassio:** owner. Logística (caixas Uline, tampas, bags), aponta problemas (dimensão de caixa errada, eficiência de fórmula). Não opera linha.
- **Bruno Camp:** owner. Raramente posta; quando posta é supervisão/alerta ("a máquina de cápsula ficou ligada").

### Esquecimentos recorrentes (pra Carolina aprender a cobrar)

- Não fechar atividade ("ontem a limpeza não foi fechada" — Carolina legada já cobrava isso).
- Não passar quantidade na 2ª impressão de ordens (Simone).
- Não avisar o que está fazendo (Henrique pergunta "me atualizem o que estão fazendo agora").
- Não dar entrada/atualização de um lote que está rodando (Carolina legada: "continuo sem informações sobre o Plant Sterols").

---

## 9. CAROLINA V3 — O QUE ELA É AGORA

A "Carolina" como **persona humana** foi aposentada no V3. O sistema é "HealthFare Production". "Carolina" sobrevive só como rótulo cosmético do assistente admin e como nome que o time já conhece.

No V3:
- O Observer lê cada mensagem e registra (modo shadow hoje).
- Quando virar `active`, a Carolina V3 poderá reagir (emoji após registrar) e, no futuro, cobrar coisas / fazer broadcast.
- **NÃO** é mais uma persona que finge ser humana com sotaque carioca — isso era do legado. O foco do V3 é rastreamento honesto e útil.

### Histórico relevante: como a Carolina legada se comunicava

Ela mandava bom dia, lembrava o esquema S/F/P/N, cobrava atividades não fechadas, perguntava status de lote ("o Plant Sterols está encapsulando, formulando, ou em outra etapa?"). Esse comportamento de **cobrança proativa** é o que o Bruno quer recriar no V3 — mas de forma mais inteligente e controlável (ver seção 10).

---

## 10. O CHAT COM A CAROLINA (feature nova do Sprint 2)

Esta é uma ideia nova e central que o Bruno descreveu. **No dashboard, um chat onde o Bruno conversa com a Carolina sobre o dia a dia.**

Como funciona (visão do Bruno):
- A Carolina pergunta ao Bruno sobre o que está acontecendo na operação e o que vale a pena chamar atenção no Slack.
- O Bruno confirma ou corrige: "isso você está certa, temos que chamar atenção mesmo / isso não precisa".
- A Carolina **aprende** com essas confirmações e o sistema se ajusta.

Exemplos do que ela poderia trazer:
- "A Simone não passou a quantidade na 2ª impressão de novo. Quer que eu cobre isso no canal?"
- "O lote 0135 está há 3h na encapsulação sem atualização. Normal?"
- "A linha parou 4 vezes hoje por problema de label. Isso é recorrente — vale investigar?"

E o Bruno responde, treinando o que é digno de atenção e o que é ruído. Isso conecta com:
- `llm_corrections` (já existe no schema) — correções viram aprendizado.
- `person_language_profile` — como cada um escreve.
- Um novo conceito de "regras de atenção" que a Carolina vai refinando com o Bruno.

**Implicação técnica:** o chat precisa de um endpoint conversacional (Bruno ↔ Carolina) com memória do que foi confirmado, e a Carolina precisa acesso ao estado do dia (timelines, pendências, padrões) pra trazer observações úteis.

---

## 11. TASKS FUTURAS, PLANEJAMENTO E NOTIFICAÇÃO

Bruno quer (todos os três):

1. **Criar tasks futuras** — "amanhã vamos fazer Tribulus". Registra como planejado.
2. **Planejar** — uma visão de o que está previsto pra frente (não só o que já aconteceu).
3. **Notificação opcional por task** — o admin escolhe, por task, se quer ser avisado quando ela iniciar. Ex: cria "Tribulus amanhã" com notificação ON — quando o V3 detectar que o Tribulus começou no canal, avisa o admin.

Isso exige:
- Tabela de tasks planejadas (produto/lote/atividade/data prevista/notificar sim-não).
- O Observer cruza o que detecta ao vivo com as tasks planejadas — quando bate, marca como iniciada e notifica (se ON).
- Visão de planejamento no dashboard (o que vem, o que está em curso, o que foi feito).

---

## 12. O QUE O DASHBOARD PRECISA MOSTRAR

Consolidando tudo que o Bruno pediu:

### Visões
1. **Por pessoa** — timeline do dia + estatísticas (horas trabalhadas, % por fluxo/fase, com quem fez cowork, pausas).
2. **Fluxo A — Produção** — o que está/esteve em Formulação, Mix, Encapsulação, Revisão, Linha, Contagem. Quem, qual lote, quanto tempo por fase. Esperado vs realizado por lote.
3. **Fluxo B — Picking & Packing** — seção dedicada e independente: tudo que a Simone/Ana fazem, início/fim de cada etapa, quantas ordens, quantos empacotados ao longo do dia, deadline do correio (bateu ou não), pendências, esquecimentos.
4. **Fluxo C — Suporte** — tarefas avulsas: conserto (downtime), limpeza, organização, transformação/retrabalho, manutenção, reunião, treinamento.
5. **Produção do dia (Esperado vs Realizado)** — meta do Henrique vs realizado da Ana, por produto/lote, com indicador de meta batida.
6. **Histórico por produto** — busca "Plant Sterols" → todos os dias, metas, realizados, % atingimento, tempo médio por fase.
7. **Planejamento / tasks futuras** — o que vem, com notificação opcional.
8. **Deadlines** — configuráveis por fluxo, com alerta de aproximação e indicador de cumprimento.
9. **Chat com a Carolina** — conversa de aprendizado (seção 10).

### Controle total do admin (requisito forte do Bruno)
O admin pode **editar, adicionar, pausar, começar, remover** TUDO — tasks passadas, presentes e futuras. Nada é read-only pro admin. Tudo auditado.

### Princípio sagrado: nada se perde
> "Isto é um registro de tasks e nada pode ser perdido. Todos os tasks registrados, e se não tiver registro, rastreia mesmo assim."

Toda atividade detectada vira registro. Mesmo as ambíguas/incompletas (marca como incerto, mas registra). O admin pode depois corrigir. Nunca descarta silenciosamente.

---

## 13. PRINCÍPIOS NÃO-NEGOCIÁVEIS (atualizados pro V3)

1. **A pessoa é a unidade primária** — cada um tem uma timeline contínua; atividades acontecem nela; produtos/lotes agregam atividades de várias pessoas.
2. **Identificação é entendimento, não regex** — o LLM entende quem é pelo texto/contexto; iniciais soltas nunca identificam pessoa.
3. **Nomes/produtos são dados, não código** — zero hardcode; turnover-proof; catálogo editável.
4. **S/F/P/N são verbos legados em extinção** — nunca inicial de pessoa; time escreve natural.
5. **Nada se perde** — todo registro fica; ambíguo vira incerto, não lixo; admin corrige depois.
6. **Admin controla tudo** — editar/adicionar/pausar/começar/remover passado, presente e futuro.
7. **Esperado vs realizado** — o sistema existe pra trocar chute por dados de tempo real.
8. **Honestidade do sistema** — quando não tem certeza, marca incerto em vez de inventar.
9. **Shadow antes de active** — observa e valida antes de reagir no Slack.
10. **A Carolina aprende com o Bruno** — correções e confirmações ajustam o sistema.
11. **Três fluxos independentes** — Produção, P&P e Suporte rodam em paralelo e não se misturam; cada um tem lógica, métrica e visão própria.
12. **Deadlines são configuráveis** — definidos e ajustados pelo admin, nunca hardcoded; ficam mais rígidos conforme o sistema revela o timing real.
13. **Ordem das fases é configurável** — a sequência de produção não é hardcoded; admin define/reordena; pré-requisitos são SOFT (avisa, nunca bloqueia); enrijece conforme os dados revelam a sequência real.
14. **Nunca soma quantidade cegamente** — números repetidos para o mesmo produto/lote podem ser duplicata; o sistema sinaliza e pergunta em vez de somar; unidade (bottle vs box) inferida do contexto, marcada incerta quando ambígua.
15. **Cérebro desacoplado (motherboard)** — o V3 (dados + lógica de entendimento) é o núcleo. Dashboards e sistemas externos são CLIENTES que plugam numa API/contrato estável. Princípios: (a) trocar, adicionar ou remover um dashboard NÃO afeta o cérebro nem os outros clientes; (b) dá pra ter 2+ dashboards/sistemas ao mesmo tempo, cada um filtrando a informação que quer; (c) o cérebro não conhece nem depende de nenhum cliente específico; (d) o contrato de dados (API) é versionado e estável. Construir tudo daqui pra frente com essa separação núcleo↔cliente em mente.

---

## 14. IDs E CONTATOS

### Pessoas
| Quem | Slack User ID | DM |
|------|---------------|-----|
| Bruno Camp (owner) | `U03URLL1D4L` | `D03UL80GDRB` |
| Thassio (owner) | `U03S46L2EUA` | `D03V1RNLSKT` |
| Henrique Monteiro (manager) | `U085SDY3F4Z` | `D085DLHDRCK` |
| Vitor (operator) | `U08JC85HMNE` | `D08JY69V1G8` (própria) / `D09FRA004LW` |
| Simone (operator) | `U07FG34TMPF` | `D07FXKPUD6D` |
| Ana (operator) | sem conta própria | via Production Line |
| Bruno Sarmento (operator) | sem conta própria | via conta do Vitor / Production Line |

### Contas compartilhadas
| Conta | User ID | Dono primário |
|-------|---------|---------------|
| Vitor | `U08JC85HMNE` | Vitor |
| Simone | `U07FG34TMPF` | Simone |
| Production Line | `U0AU8N8FA00` | neutra (geralmente Ana) |

### Canais e bot
| O quê | ID |
|-------|-----|
| Canal de produção `#orders-and-inventory` (privado) | `C09UNBXFRKK` |
| Canal admin | `C0B36DR5MP1` |
| Bot (HealthFare Production / Carolina) | `U0B3EQLPEPL` |
| Bot DM | `D0B3CSSUBNJ` |

### Técnico
- Railway: `productionlineservice-production.up.railway.app`
- Webhook V3: `/slack/events-v2` (event `message.groups`, canal privado)
- Schema: namespace `v3.*` no Postgres
- Modelo LLM: `claude-sonnet-4-6` (editável via setting)
- PIN admin: `510510`
- Branch: `v3-reset`

---

## 15. GLOSSÁRIO DO VOCABULÁRIO REAL DO TIME

| Termo no chat | Significado |
|---------------|-------------|
| **S: / S- / S;** | Start (começar atividade) — verbo, não pessoa |
| **F: / F-** | Finish (terminar atividade) |
| **P: / P;** | Produção — quantidade de potes/bottles produzidos |
| **N: / N;** | Nota/observação |
| **0134, 0135, BR-2026-0136** | Número do lote (batch) |
| **FBA** | Fulfillment by Amazon (destino de envio) |
| **WH** | Warehouse (destino) |
| **WFS** | Walmart Fulfillment Services (destino) |
| **WR** | Destino de envio (confirmado pelo Bruno como destino válido) |
| **FNSKU** | Etiqueta de identificação Amazon (aplicada no produto) |
| **Linha de produção** | Envase em garrafas (tampa, lacre, label) — etapa final |
| **Formula / Formulação** | Pesar e preparar a matéria-prima |
| **Mix** | Misturar os ingredientes pesados |
| **Máquina de cápsulas / tablet** | Encapsulação (cápsula ou comprimido) |
| **Revisão** | QA do produto encapsulado, antes da linha |
| **Double check** | Conferência final + fechamento de caixas |
| **Ordens** | Pedidos dos marketplaces (Picking & Packing) |
| **Primeira/segunda impressão** | Etapas da impressão de labels das ordens |
| **Silica** | Sachê dessecante (insumo); "máquina de silica" também aparece como ponto de falha |
| **Transformar / trocar label** | Retrabalho: mudar embalagem/label de produto pronto |
| **Rodando** | Máquina trabalhando sozinha (ex: "Potassium rodando") |
| **Liberar no sistema** | Henrique habilita um produto/lote no sistema de gestão |
| **Akkermansia manual** | Encapsular à mão (não tem em máquina) |
| **bottles / potes** | Unidade de produto final |

---

**FIM DO HANDOFF V3.**
Versão 1.0 · 21 Mai 2026 · base do Sprint 2.
Fundamentado no Slack real de 14–21 Mai + decisões do Bruno.
