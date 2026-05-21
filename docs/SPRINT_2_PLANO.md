# HEALTHFARE V3 — PLANO DO SPRINT 2

> **PLANO DE EXECUÇÃO** | 21 Maio 2026
> Base: HEALTHFARE_HANDOFF_V3.md (operação real)
> Princípio fundador: **cérebro desacoplado (motherboard)** — dados separados da apresentação
> Modelo: construir em blocos, validar cada um, igual Sprint 1. NADA vai pro Claude Code sem o Bruno aprovar bloco a bloco.

---

## VISÃO GERAL

O Sprint 1 construiu o cérebro: o V3 entende as mensagens e registra os dados em `v3.*`. O Sprint 2 transforma esses dados em **controle** — dashboards, metas (esperado vs realizado), planejamento, e o chat de aprendizado da Carolina. Tudo sobre uma **camada de API limpa** pra que dashboards e sistemas externos sejam clientes plugáveis, não partes acopladas do cérebro.

### A arquitetura-alvo (motherboard + clientes)

```
+-----------------------------------------------------------+
|  CEREBRO V3 (motherboard) -- nao conhece nenhum cliente    |
|  [Observer LLM]  [Services: Event/Batch/Goal/Count]        |
|  [Dados v3.*: events, counts, goals, batches, ...]         |
|                        |                                    |
|                 [API DE DADOS /api/v3/data/*]  <- contrato  |
|                        |                          estavel    |
+------------------------|-----------------------------------+
                        |  (qualquer cliente pluga aqui)
        +---------------+---------------+
        v               v               v
  [Dashboard V3]  [Outro dashboard]  [Sistema externo]
  filtra o que    (futuro / BI)      (Veeqo, ERP...)
  quer mostrar    filtra o que quer  filtra o que consome
```

Regras do desacoplamento:
- O cerebro NAO conhece nenhum cliente. Sem "if dashboard X".
- A API de dados retorna JSON puro (nao HTML). E o unico contrato.
- Cada cliente FILTRA o que quer. Adicionar/trocar/remover cliente nao toca o cerebro nem os outros.
- A API e VERSIONADA (/api/v3/data/...) -- mudancas nao quebram clientes existentes.
- Autenticacao na borda da API (token), nao dentro do cerebro.

---

## BLOCO 0 -- DESACOPLAMENTO (ajuste do Sprint 1) - FUNDACAO

**Por que primeiro:** o Sprint 1 gera HTML direto nos endpoints (/overview, /timeline, /messages-shadow, /events-shadow retornam pagina, nao dado). A logica de query esta embutida no HTML. Pra tudo que vem ser desacoplado, a camada de dados precisa existir primeiro.

### 0.1 Investigacao (Claude Code reporta ANTES de mexer)
- Mapear os endpoints /api/admin/v3/* atuais: quais geram HTML, qual logica de query cada um tem.
- Identificar a logica de dados embutida no HTML.
- Reportar o estado de acoplamento ao Bruno antes de mudar.

### 0.2 Extrair a camada de dados (JSON API)
- Criar /api/v3/data/* retornando JSON puro:
  - /api/v3/data/timeline?date= -- eventos por pessoa
  - /api/v3/data/production?date= -- events de producao por lote/fase
  - /api/v3/data/pp?date= -- picking & packing
  - /api/v3/data/support?date= -- tarefas de suporte
  - /api/v3/data/goals?date= -- metas (quando Bloco 2 existir)
  - /api/v3/data/counts?date= -- production_counts
  - /api/v3/data/batches -- lotes ativos/historicos
  - /api/v3/data/person/{id}/history -- historico por pessoa
  - /api/v3/data/product/{id}/history -- historico por produto
- A logica de query vive em services/repositories REUTILIZAVEIS, nao duplicada no HTML.
- Os endpoints HTML atuais (/overview etc) passam a CONSUMIR a mesma camada de dados (chamam o repository, nao query direto). O dashboard temporario continua funcionando, mas agora come da mesma fonte que a API.

### 0.3 Autenticacao na borda
- Hoje e PIN na query (?pin=510510). Manter por ora, mas estruturar pra trocar por token/JWT depois sem tocar o cerebro.
- Auth num middleware na borda da API, nao espalhada.

### 0.4 Contrato versionado
- /api/v3/data/* e o contrato v3. Documentar o shape de cada resposta (README ou OpenAPI simples).
- Mudanca futura que quebraria -> vira /api/v4/data/*, clientes antigos seguem.

**Entregavel do Bloco 0:** camada de dados JSON pronta, dashboard temporario atual consumindo dela, contrato documentado. Nada visual muda pro Bruno ainda -- e fundacao.

---

## BLOCO 1 -- FASES E FLUXOS (modelo de dados)

**Por que:** o dashboard precisa agrupar atividades por fluxo (Producao/P&P/Suporte) e por fase. Hoje o V3 tem activity_types solto, sem fluxo/fase.

### 1.1 Modelo
- Adicionar a cada activity_type (ou tabela nova): FLUXO (production/pnp/support) e FASE.
- Configuravel: admin define/edita/reordena fases por fluxo (principio 13). Nao hardcoded.
- Pre-requisitos SOFT (avisa, nao bloqueia).

### 1.2 Mapeamento inicial (do handoff, ajustavel)
- Producao: Formulacao -> Mix -> Encapsulacao -> Revisao -> Linha -> Contagem
- P&P: impressao -> 2a impressao -> labels -> embalar -> fechar caixas -> envio
- Suporte: conserto, limpeza, organizacao, transformacao, manutencao, reuniao, treinamento, almoco

### 1.3 Migracao
- Classificar os events existentes do shadow nos fluxos/fases (re-tag retroativo).
- Idempotente, auditado.

---

## BLOCO 2 -- METAS (esperado vs realizado)

**O coracao do valor.** Ver handoff secao 7.

### 2.1 Modelo
- v3.production_goals: produto, lote, quantidade esperada, destino (FBA/WH/WFS/WR -- guardado, nao usado no tracking ainda), data, origem (canal/dashboard), criado_por.
- Liga ao production_counts (realizado) pelo produto+lote.

### 2.2 Deteccao automatica (Observer)
- Quando o Henrique posta meta de manha ("BR-2026-0135 Plant Sterols 750>FBA"), o Observer detecta e grava como goal.
- Categorizacao nova: goal_set (separada de eod_count).

### 2.3 Input manual (dashboard)
- Formulario pra admin criar/editar meta direto no dashboard (acessivel de qualquer lugar).

### 2.4 Anti-duplicacao de quantidade (handoff 7.6)
- Mesmo numero 2x pro mesmo produto/lote -> SINALIZA, nao soma. Pergunta se e duplicata ou adicional.
- Unidade bottle vs box inferida do contexto + heuristica de magnitude (50+ -> provavelmente bottle).

### 2.5 Calculo esperado vs realizado
- Por produto/lote/dia: esperado X, realizado Y, % atingimento, bateu sim/nao.
- Tempo real por fase do lote (usa os events com timestamps).

---

## BLOCO 3 -- DASHBOARD DE VERDADE (cliente principal)

**Construido sobre a API de dados do Bloco 0.** E um cliente, nao parte do cerebro.

### 3.1 Stack
- SPA leve (consome a API JSON) ou server-rendered consumindo a camada de dados. Recomendo SPA simples (React) pra interatividade e pra PROVAR o desacoplamento na pratica.
- Design real (nao o preview cru). Usa a skill frontend-design.

### 3.2 As visoes (handoff secao 12)
1. Por pessoa -- timeline + estatisticas (horas, % por fluxo/fase, cowork, pausas)
2. Fluxo A (Producao) -- fases por lote, tempo, esperado vs realizado
3. Fluxo B (P&P) -- etapas, ordens, deadline do correio, pendencias
4. Fluxo C (Suporte) -- downtime, retrabalho, avulsos
5. Producao do dia -- esperado vs realizado por produto/lote
6. Historico por produto -- busca, metas, tempo medio por fase
7. Planejamento / tasks futuras
8. Deadlines -- configuraveis, alertas de aproximacao
9. Chat com a Carolina (Bloco 5)

### 3.3 Controle total do admin (principio 6)
- Editar, adicionar, pausar, comecar, remover qualquer task (passada/presente/futura).
- Tudo via a API de dados (endpoints de escrita, auditados).
- Nada read-only pro admin.

---

## BLOCO 4 -- TASKS FUTURAS, PLANEJAMENTO E NOTIFICACAO

Ver handoff secao 11.

### 4.1 Modelo
- v3.planned_tasks: produto/lote/atividade/data prevista/notificar(sim-nao)/status.

### 4.2 Deteccao de inicio
- Observer cruza o que detecta ao vivo com tasks planejadas. Quando bate -> marca iniciada.

### 4.3 Notificacao opcional
- Se notificar=ON -> avisa o admin quando a task iniciar (DM ou canal admin).

### 4.4 Visao de planejamento
- O que vem, o que esta em curso, o que foi feito.

---

## BLOCO 5 -- CHAT COM A CAROLINA (aprendizado)

Ver handoff secao 10. **Feature nova e central.**

### 5.1 Endpoint conversacional
- Bruno <-> Carolina, com memoria do que foi confirmado.
- A Carolina tem acesso ao estado do dia (timelines, pendencias, padroes) via a API de dados.

### 5.2 Observacoes proativas
- A Carolina traz: esquecimentos (Simone nao passou qtd na 2a impressao), anomalias (lote 3h sem update), padroes (linha parou 4x por label), suspeitas de duplicacao.

### 5.3 Aprendizado
- Bruno confirma/corrige -> vira regra de atencao / llm_corrections.
- O sistema ajusta o que cobra e o que ignora.

---

## BLOCO 6 -- CUTOVER E LIMPEZA (fim do Sprint 2)

### 6.1 Virar active (decisao separada do Bruno)
- Quando o Bruno confiar, Observer mode='active' -> Carolina reage/posta.

### 6.2 Desligar o legado
- Desligar o poller legado (startPolling).
- Migrar/arquivar dados legados relevantes.
- DROP das tabelas legadas obsoletas (com backup).

### 6.3 Auth real
- Trocar PIN por token/JWT na borda da API.

---

## ORDEM DE CONSTRUCAO

```
Bloco 0 (desacoplamento)  <- fundacao, primeiro
   v
Bloco 1 (fases/fluxos)    <- modelo de dados
   v
Bloco 2 (metas)           <- o coracao do valor
   v
Bloco 3 (dashboard)       <- o cliente principal, sobre a API
   v
Bloco 4 (planejamento)    <- tasks futuras
   v
Bloco 5 (chat Carolina)   <- aprendizado
   v
Bloco 6 (cutover)         <- fim, vira active + mata legado
```

Cada bloco: construido por partes, validado pelo Bruno, npm test verde, deploy isolado. Igual ao Sprint 1. Nenhum prompt pro Claude Code sem o Bruno pedir.

---

## PRINCIPIOS QUE GUIAM TODO O SPRINT 2

1. Desacoplamento (motherboard): cerebro nao conhece clientes; API de dados e o contrato.
2. Configuravel > hardcoded: fases, deadlines, ordem -- tudo editavel pelo admin.
3. Nada se perde: todo registro fica; ambiguo vira incerto; admin corrige.
4. Nunca soma cego: duplicacao sinalizada, nao somada.
5. Admin controla tudo: editar/adicionar/pausar/comecar/remover.
6. Shadow -> active: so vira active quando o Bruno confiar.
7. A Carolina aprende com o Bruno: chat de confirmacao ajusta o sistema.
8. 3 fluxos independentes: Producao / P&P / Suporte nao se misturam.

---

**FIM DO PLANO SPRINT 2.**
Versao 1.0 - 21 Mai 2026 - base do Sprint 2.
