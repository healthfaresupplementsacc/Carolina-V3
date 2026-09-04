# MASTER SYNC PLAN — Plano mestre de sincronizacao do sistema

Data: 2026-08-21 (probes de producao rodados em 2026-09-03 pelos 5 investigadores, SELECT-only).
Fontes: 5 auditorias de cadeia (DEDUCT, REPLENISH, STOCKPAGE, ONECLICK, TIMELINE), cruzadas entre si.

**A verdade central, sem anestesia: a torre esta construida sobre areia. O armazem fisico nunca foi carregado (0 bins, 0 caixas, 0 movimentos, 0 pesos, 0 etiquetas impressas). Quase tudo que depende de estoque fisico esta construido e deployado, mas rodando em cima de zeros. A Fase 1 deste plano e carregar a base. Nada abaixo dela pode ser confiado antes disso.**

---

## Cruzamentos e conflitos resolvidos (o "voltar ao passo 1")

Antes do plano, os pontos onde os 5 relatorios se tocam, discordam ou se invalidam:

1. **Todos os 4 relatorios de estoque convergem no mesmo zero.** DEDUCT (hop 4/5), REPLENISH (hop 1/3), STOCKPAGE (verbo 1) e ONECLICK (hop 4) mediram independentemente: 0 bins, 0 boxes, 0 stock_movements, 0 pesos unitarios, 0 print_queue. Nao e coincidencia nem bug: e a mesma causa raiz. O Montar estoque (S15.45) foi construido exatamente para isso e nunca rodou. **Resolucao: carga fisica = Fase 1, pre-requisito duro de tudo.**

2. **CONFLITO: ligar o planner agora vs depois da carga.** DEDUCT (gap 7) diz "ligar stock-alerts depois da carga fisica". REPLENISH (gap 1) diz "ligar agora, sem dependencia". REPLENISH investigou o codigo mais fundo: `totalQty = warehouse + marketplace` (`src/workers/stock-alerts.js:47-74`), o worker usa o estoque Veeqo dos marketplaces, que E o numero honesto hoje; tem guarda `velocity_reliable` (>=7 dias) e dedupe 24h/produto. **Resolucao: REPLENISH ganha. Ligar `WORKER_STOCK_ALERTS_ENABLED=true` ja na Fase 0, monitorando ruido nos primeiros dias. A carga fisica so melhora o numero, nao e pre-requisito.**

3. **CONFLITO CRITICO: virar a deducao para live antes da carga = dano permanente.** DEDUCT provou que `deducted_at` e gravado incondicionalmente mesmo com `applied=0` (`src/workers/veeqo-order-sync.js:135-136`) e o slot de idempotencia e consumido. Se virar antes da carga: ~150-220 incidentes/dia + sub-deducao silenciosa PERMANENTE (linhas nunca serao re-deduzidas). **Resolucao: ordem inegociavel = (a) guard do deducted_at (Fase 0), (b) carga fisica (Fase 1), (c) flip para live (Fase 2). Nunca inverter.**

4. **CONFLITO: pagina simples nova vs modo simples do hub.** Bruno pediu "a pagina simples de estoque". STOCKPAGE provou que a pagina dos sonhos ja existe ~80% (o hub `WarehousePage.jsx`) e que criar pagina nova violaria a regra de caminho unico do proprio hub. **Resolucao: "pagina simples" = Modo simples como view padrao do `#estoque` existente, com toggle Modo completo. Nao criar pagina nova.**

5. **GAP que invalida a Fase 1 se nao for corrigido antes: o ajuste inline quebra com 0 locais.** STOCKPAGE achou que TODA edicao de celula prateleira/caixa da 400 hoje (`StockService.js:690` exige bin_id/box_id, `WarehousePage.jsx:1189` nunca manda com 0 bins), e a celula "A organizar" NUNCA salva (bug independente de dados). Se a equipe for fazer o mutirao de carga e a pagina der erro cru em cada clique, a confianca morre no dia 1. **Resolucao: gaps 1-2 do STOCKPAGE entram ANTES ou JUNTO da carga (Fase 1, tarefa 1).**

6. **O drift watch esta gritando lobo.** DEDUCT mediu 25-76 alertas/dia porque ours=0 no catalogo inteiro. Como sinal de confianca, hoje e ruido puro; depois da carga vira o verificador principal do loop. **Resolucao: modo "estoque nao carregado" (1 linha/dia) na Fase 0; volta ao modo por-produto automaticamente quando a carga acontecer.**

7. **Duas definicoes de days_of_stock coexistem** (overview: 7d / available do armazem, hoje 0; planner: 14d / armazem+marketplace). Mesmo nome, numeros diferentes = exatamente a desconfianca que Bruno teme. **Resolucao: ate a carga fisica, a definicao do planner e a honesta; depois da carga, unificar (decisao D-6 do Bruno) ou rotular distinto.**

8. **CONTRADICAO com fatos anteriores: o grid drag/resize do Hoje FOI construido.** TIMELINE provou (codigo + bundle + `v3.user_prefs` com layouts salvos 08-19) que o pedido de 08-19 esta entregue e em uso. Nao construir de novo; contar ao Bruno.

9. **CONTRADICAO: "impressao de etiquetas de envio LIVE" e enganoso.** ONECLICK provou: deployado sim, mas **0 usos em 15 dias** (0 rows em shipping_label_prints, print_queue, print_files; 0/4.247 linhas com printed_at). LIVE-deployado nao e LIVE-operando. Antes de construir preflight/Fase B, responder POR QUE ninguem aperta o botao (hipotese forte: a Rollo esta no .246 e a aba da Central precisa estar aberta la; o fluxo real continua sendo a tela da Veeqo).

10. **Numeros de SKU divergem entre relatorios, conclusao igual.** 489/489 (fato semeado) vs 563/563 (DEDUCT, prod) vs 0 sem mapa em 30d no conjunto vendedor (ONECLICK). O mapa cresceu (familias/kits); esta 100% no que importa. 110 produtos fisicos vs 309 rows ativas em `v3.products`: os 309 incluem variantes/lixo de catalogo; a maquina de merge/SkuChip existe por isso.

11. **P&P do dia vs realidade Veeqo estao derivando** (DEDUCT 7b: 09-02 = 119 digitado vs 147 enviado; 09-03 = 130 vs 219) e nada vigia a diferenca. Comparador diario = quick win.

12. **A classe de erro real dos funcionarios nao e resolvivel no /op.** TIMELINE provou que o loop forgotten-checkout FUNCIONA (18/sem -> 1-2/sem, 52/52 resolvidos) e que o residuo (horas de encapsulamento nao registradas) vem de gente que trabalha SEM tocar o /op. A alavanca e o watchdog admin (no-clockin/no-task -> Carolina), nao mais um card no /op.

13. **P0 fora das cadeias de estoque: o dashboard crasha ao expandir uma pessoa.** TIMELINE confirmou no fonte E no bundle de 1-set: popover do ponto foi parar dentro de `PersonExpansion` com identificadores livres -> ReferenceError -> tela branca (sem ErrorBoundary). O drill de pessoa/dia, feature central de acompanhar funcionarios, esta inutilizavel. Vai na Fase 0, primeiro item.

---

## (a) O ESTADO DA VERDADE

Legenda: SYNCED = construido e operando com dados reais · BUILT-OFF = construido, desligado ou nunca usado · HALF = parte funciona, parte falta · MISSING = nao existe.

| # | Elo da cadeia | Estado | Evidencia |
|---|---|---|---|
| **BASE FISICA** | | | |
| 1 | Estoque fisico carregado (bins/boxes/pesos) | **MISSING (dados)** | 0 bins, 0 boxes, 0 movimentos, 0 pesos, 0 box types (4 probes independentes). Montar estoque (S15.45) deployado, nunca usado |
| 2 | Pagina de estoque do sonho (nome/prateleira/caixa/ajustar/imprimir/pesar) | **HALF** | ~80% e o hub `dashboard-v4/src/pages/WarehousePage.jsx`; falta modo simples, imprimir da linha, pesar na linha; ajuste inline QUEBRA com 0 locais (`StockService.js:690`) e celula unplaced nunca salva |
| 3 | Pesagem -> total (ceil 0.15, taras) | **HALF** | Backend pronto (`src/v3/warehouse/router.js:936`, `weights.js`); sem pesos cadastrados nao computa nada; nao existe no hub |
| **VENDA -> DEDUCAO** | | | |
| 4 | Veeqo shipped -> espelho `pnp_order_lines` | **SYNCED** | `src/workers/veeqo-order-sync.js:107-143`; 10.298 linhas shipped, fresco de hoje; janela fixa 48h (`:153`) e risco em outage |
| 5 | Deducao no envio (`STOCK_DEDUCT_MODE`) | **BUILT-OFF** | `=dry` no Railway; modo capturado no constructor (`:34`), flip exige restart; `deducted_at` 0/10.298 |
| 6 | `StockService.pick` (prateleira->caixa, idempotente) | **BUILT-OFF** | `StockService.js:221-277`; nunca disparou; PERIGO: `deducted_at` gravado mesmo com applied=0 |
| 7 | Ledger `stock_movements` | **BUILT-OFF (vazio)** | 0 rows na historia; append-only pronto (migracao 058) |
| 8 | Hub: total/reservado/disponivel | **HALF** | Logica certa (`StockService.js:826-916`); so o reservado e vivo (98 linhas abertas); disponivel SOBE quando garrafa envia (total=0, reservado cai) |
| 9 | Drift watch (nos vs Veeqo) | **SYNCED mas ruido** | 25-76 produtos/dia divergindo porque ours=0; como sinal, inutil ate a carga |
| 10 | Estorno cancelamento pos-envio | **MISSING (auto)** | `veeqo-order-sync.js:64` recusa shipped->cancelled; comentario `:17-18` promete incidente que NENHUM codigo cria; sem unpick em lugar nenhum |
| 11 | sold_7d/30d/days_of_stock no hub | **SYNCED (calc) / HALF (dado)** | `StockService.js:869-880`; denominador available=0 deixa "Dias" em 0.0/null |
| 12 | P&P do dia vs enviados Veeqo | **MISSING (elo)** | Contagem digitada (`flow-views-repo.js:313-319`) sem cruzamento; drift real 09-02/09-03 |
| **REPOSICAO -> PLANEJAMENTO** | | | |
| 13 | stock-gap Slack (falta pro picklist de hoje) | **SYNCED** | Ligado, disparando diario (48 alertas em audit_log); escopo = so produtos pedidos hoje |
| 14 | needs_restock / restock-list | **BUILT-OFF (dado morto)** | Logica viva, 0 bins com min_qty -> lista vazia desde que nasceu |
| 15 | Cache EMS pipeline + lead time medido | **SYNCED** | 13 batches ativos, 1.089 completos, lead time mediano por produto de 125 batches / 52 produtos; 2 orphans menores |
| 16 | Planner StockAlerts (zonas out/low/plan + "comece a planejar") | **BUILT-OFF (worker) / escondido (UI)** | `WORKER_STOCK_ALERTS_ENABLED` unset; 0 alertas na historia; unica UI = tab do `#inventory` legado escondido |
| 17 | Pagina Planejamento | **MISSING** | `PlaceholderPage` "Em construcao" (`OtherPages.jsx:804-808`) |
| 18 | Lista de fabricacao persistida + qtd sugerida | **MISSING** | O alerta diz "Adicionar a lista de fabricacao" e a lista nao existe; planner diz QUANDO, nunca QUANTO |
| 19 | Metas | **SYNCED (outra coisa)** | Execucao de batches ja decididos; nao recebe nada de velocidade/estoque |
| **IMPRESSAO 1 CLIQUE** | | | |
| 20 | Central: botao imprimir etiquetas de envio | **BUILT-OFF (0 usos em 15 dias)** | `src/op/ws.js:589-698`; 0 rows em todas as tabelas da cadeia |
| 21 | Preview dia/agrupamento/rodape/envelope/dedupe | **SYNCED (codigo)** | `src/v3/shipping-labels/{service,footer,envelope}.js`; tiers de envelope batem com a memoria exatamente |
| 22 | Local no rodape | **HALF** | Codigo pronto; toda etiqueta diz "sem local" (0 bins); walk-order e no-op |
| 23 | Cor da garrafa -> envelope | **HALF (dado)** | 135/309 produtos sem cor; 14 SKUs vendedores sem cor = envelope "?" em 124 linhas/30d; regra de cor mista pendente do Bruno |
| 24 | Checks (merge, duplicado, preco) | **HALF (desconectados)** | Mergeable-alert e dup-detector LIVE mas como Slack da manha/tarde; dup roda DEPOIS do papel sair; botao nao consulta nada; preflight nunca desenhado |
| 25 | Fase B (comprar etiqueta via API) + PrintAgent .246 + SCAN form | **MISSING** | Estudo pronto (`docs/architecture/study/S15-VEEQO-LABEL-API-STUDY.md`), rates testados, zero codigo |
| **ACOMPANHAMENTO DE FUNCIONARIOS** | | | |
| 26 | Expandir pessoa no Timeline (drill dia) | **BUILT-OFF (CRASHA)** | P0: `Timeline.jsx:863-905` (popover em componente errado -> ReferenceError -> tela branca); confirmado no bundle de 1-set; sem ErrorBoundary |
| 27 | Popover do marcador de ponto | **MISSING (regrediu)** | Mesmo bug; clique no ponto nao faz nada |
| 28 | Timeline: pausa inline, cowork, drag, gaps, ponto | **SYNCED** | Tudo verificado; pausa quase sem dados (2 breaks/30d), gap-fill 2 usos na historia |
| 29 | Eixo do dia (eventos fora de 8-18h) | **HALF** | Estende so por batidas tardias; evento apos 18h ou inicio 6h corta (`Timeline.jsx:65` vs `app.js:826`) |
| 30 | /op: fluxo guiado, EMS auto-sugestao, esqueci-de-marcar, forgotten-checkout | **SYNCED** | 2.041 eventos/60d; forgotten-checkout provadamente fechado (18/sem -> 1-2/sem, 52/52) |
| 31 | Trabalho sem NENHUM contato com /op | **MISSING (escalacao)** | Classe real do incidente das horas de encapsulamento; timeline ja marca "bateu ponto e nao iniciou tarefa", ninguem e cobrado |
| 32 | Hoje: grid drag/resize/account-save | **SYNCED (Bruno nao sabe)** | `WidgetGrid.jsx` completo, em uso, layouts salvos 08-19 em `v3.user_prefs` |
| 33 | Hoje: densidade/cadencia | **MISSING** | Unica alavanca real de "caber melhor na tela" nao construida |

---

## (b) O PLANO

Ordenado por dependencia. Cada fase termina com o CHECK DE SINCRONIA (o "voltar ao passo 1"): a prova objetiva de que o elo novo esta falando com todos os vizinhos antes de avancar.

### FASE 0 — Estancar o sangramento (1 semana, tudo tamanho S, paralelo)

Objetivo: consertar o que esta quebrado ou mentindo HOJE, e armar as guardas que tornam as fases seguintes seguras. Nada aqui depende de nada.

| Tarefa | Tamanho | Onde |
|---|---|---|
| 0.1 P0: mover popover de volta pro `Timeline` (crash do expandir pessoa) + passo de QA que clica expand e ponto | S | `Timeline.jsx:863-905`, `qa-dashboard-hoje.js` |
| 0.2 ErrorBoundary em volta do conteudo de pagina | S | `App.jsx`/`Shell.jsx` |
| 0.3 **Guard do deducted_at**: so gravar quando `applied === wanted`, senao marcar `deduct_short` pra retry | S | `veeqo-order-sync.js:124-137` |
| 0.4 Fix da celula "A organizar" (branch unplaced no adjust) | S | `StockService.js:688`, `warehouse/router.js:522` |
| 0.5 Celulas prateleira/caixa com 0 locais: desabilitar com dica "sem local: use Entrada ou cadastre em Locais" (o auto-bin completo fica pra Fase 1) | S | `WarehousePage.jsx:1506` |
| 0.6 Drift watch modo "estoque nao carregado" (1 linha/dia em vez de 25-76 alertas) | S | `stock-drift-alert.js` |
| 0.7 **Ligar o planner**: `WORKER_STOCK_ALERTS_ENABLED=true` (usa estoque marketplace, funciona com armazem vazio; conflito 2 resolvido a favor de ligar ja) | S | Railway env |
| 0.8 Comparador diario P&P digitado vs enviados Veeqo -> admin-orin se delta > N% | S | novo worker pequeno |
| 0.9 Extrair lib compartilhada de match Veeqo (normalizadores duplicados dos 2 workers) | S | novo `src/v3/veeqo/match.js` |
| 0.10 Dup-check dentro do preview de impressao (pega o caso Fabian ANTES do papel) | S | `shipping-labels/service.js` |
| 0.11 Cadastrar cor da garrafa nos 14 SKUs vendedores sem cor (mata ~87% dos envelopes "?") | S | Product Setup (dado) |
| 0.12 Eixo do timeline: estender DAY_END por eventos e DAY_START ate 6h | S | `Timeline.jsx:65` |
| 0.13 Razao pre-preenchida "contagem" no ajuste inline + busca na pagina Locais | S | `warehouse-table.jsx:136`, `LocationsPage.jsx` |
| 0.14 Perguntar por que o botao de etiquetas de envio nunca foi apertado (1 mensagem + observar 1 dia) | S | processo |
| 0.15 Contar ao Bruno que o grid do Hoje (drag/resize/account) ja existe desde 08-19 | S | mensagem |
| 0.16 Limpar error_note velho (1.793 linhas) apos OK do Bruno (D-4) | S | 1 UPDATE |

CHECK DE SINCRONIA da Fase 0: dashboard nao crasha em nenhum clique (QA novo passa); planner mandou o primeiro Slack de zona sem falso alarme grosseiro; drift virou 1 linha; comparador rodou 3 dias e o delta bate com a realidade.

### FASE 1 — A CARGA FISICA + a pagina simples (a fase que desbloqueia tudo)

Objetivo: o armazem real dentro do sistema, e a pagina que a equipe vai usar todo dia sem treinamento. Ate o fim desta fase, "Berberine: 23 na prateleira, 88 na caixa" e verdade na tela.

| Tarefa | Tamanho | Onde |
|---|---|---|
| 1.1 Fix completo do ajuste com 0 locais (auto-bin `code=base_sku` ou rota pra unplaced) — ANTES do mutirao, senao a confianca morre no dia 1 (conflito 5) | M | `warehouse/router.js:522`, `StockService.js:688` |
| 1.2 **Modo simples** como view padrao do `#estoque`: nome + SKU + prateleira + caixa + total, InlineNumber, toggle "Modo completo" (pref `estoque.view`) | M | `WarehousePage.jsx` (nao criar pagina nova, conflito 4) |
| 1.3 Chips de local clicaveis na linha -> etiqueta na fila da estacao com 1 clique | S | `WarehousePage.jsx:1539` + `warehouse-api.js:206` |
| 1.4 Faixa de pesagem na linha: gramas -> `POST /count/compute` -> "≈ N garrafas" -> "Usar como contagem" (com atalho "produto sem peso -> pesar 10 agora") | M | `WarehousePage.jsx` + endpoint existente |
| 1.5 **O MUTIRAO**: carga fisica via Montar estoque (pesos unitarios, taras de caixa, bins, contagem), meta = total ≈ Veeqo por produto. Agenda do Bruno (D-1) | L (trabalho fisico, zero codigo) | operacao |
| 1.6 Thresholds dos ~10 mais vendidos em `v3.stock_thresholds` (valores do Bruno, D-3) | S | INSERTs |
| 1.7 Depois da carga: tirar Montar do nav principal (vira ferramenta de Configuracoes) | S | `Shell.jsx` |

Desbloqueia: Fases 2, 3, o rodape de local da 4, needs_restock, days_of_stock do hub, drift como sinal real.

CHECK DE SINCRONIA: para 10 produtos sorteados, prateleira+caixa na tela == contagem fisica == Veeqo (tolerancia definida); drift watch volta ao modo por-produto e aponta MENOS de 5 divergencias reais; um ajuste inline feito por operador vira proposta em Aprovacoes e por admin aplica na hora; uma etiqueta de local impressa da linha sai na estacao.

### FASE 2 — Ligar a deducao (a primeira garrafa que se deduz sozinha)

Pre-requisitos: 0.3 (guard) + Fase 1 (carga). NUNCA antes (conflito 3).

| Tarefa | Tamanho | Onde |
|---|---|---|
| 2.1 Estorno de cancelamento pos-envio: incidente prometido no comentario + unpick compensatorio `source='veeqo_cancel'` (tambem no twin tiktok-source) | M | `veeqo-order-sync.js:64`, `tiktok-source.js:135` |
| 2.2 Watermark de sync no lugar da janela fixa 48h (outage nao perde envios) | S/M | `veeqo-order-sync.js:153` |
| 2.3 Flip: `STOCK_DEDUCT_MODE=live` + **restart** (modo e capturado no constructor) + conferir boot log `deduct=live` | S | Railway |
| 2.4 Vigiar `data_incidents kind='stock_insufficient_stock'` nos primeiros dias | S | operacao |

CHECK DE SINCRONIA (o teste da garrafa, versao curta): enviar 1 pedido real -> em ate 1 tick: linha shipped + `deducted_at` preenchido + 1 row em `stock_movements` + prateleira do produto cai na tela do hub + drift NAO acusa esse produto. Se qualquer elo falhar, voltar ao passo 1 desta fase.

### FASE 3 — Reposicao vira Planejamento

Pre-requisitos: 0.7 (planner ligado), Fase 1 (numeros reais). Objetivo: o sistema diz o que produzir, quanto, e onde isso mora.

| Tarefa | Tamanho | Onde |
|---|---|---|
| 3.1 Planejamento v1 = tabela do planner na PlanPage (tirar do `#inventory` escondido) | M | `OtherPages.jsx:804`, reusa `/api/v3/data/stock/planner` |
| 3.2 Qtd sugerida: `deficit = ceil(por_dia x (lead+3+7) − (total − reservado) − ems_inflight)` arredondado ao batch historico mediano; primeiro so no texto do alerta (S), depois persistido | S depois M | `stock-alerts.js` |
| 3.3 Lista de fabricacao persistida `v3.production_plan_items` (sugerido -> aprovado -> em producao -> feito; auto-limpa quando batch EMS ativo aparece) | M | migracao + service + PlanPage |
| 3.4 Unificar days_of_stock (decisao D-6) ou rotular os dois | M | `StockService.js:927` vs `stock-alerts.js` |
| 3.5 Consertar 2 orphans do cache EMS (invisiveis pro lead time e dedupe) | S | dados |
| 3.6 Thresholds completos + UI simples se Bruno quiser | S/M | InventorySettingsPage |

CHECK DE SINCRONIA: pegar 1 produto em zona "plan" -> o alerta Slack, a PlanPage e o hub mostram O MESMO numero e a MESMA sugestao; criar o batch no EMS -> o item da lista auto-limpa em 1 ciclo de cache.

### FASE 4 — Impressao 1 clique de verdade (preflight -> agente -> Fase B)

Pre-requisitos: 0.9/0.10/0.14; local no rodape depende da Fase 1.

| Tarefa | Tamanho | Onde |
|---|---|---|
| 4.1 Responder o gap 1 (por que 0 usos) e decidir D-5: adotar Central como esta vs PrintAgent primeiro. Tudo abaixo e decoracao ate isso | S | processo |
| 4.2 Preflight endpoint + confirm UI: 8 checks ordenados (Veeqo ok, dedupe, dup-hoje, mergeable, preco, envelope ?, local, SKU), vermelho bloqueia nomeando, ambar avisa com "seguir assim mesmo". Dia limpo continua 1 clique | M | `print-queue/router.js` + `shipping-labels/preflight.js` + `ws.js` |
| 4.3 HF-PrintAgent no .246 (impressao silenciosa, sem aba, heartbeat) — provavelmente resolve o gap 1 estruturalmente | M | novo agente, licoes do estudo 25/08 |
| 4.4 Fase B piloto: quote -> book -> mark-shipped -> label_content direto no compose existente; canal HealthFare Website, 1 pedido primeiro (U-A..U-D do estudo); mergeable vira gate pre-COMPRA | L (2-3 dias) | `veeqo-api.js` + estudo S15 |
| 4.5 Fase D: SCAN form via API apos a ultima etiqueta do dia + refund 1-clique no freight alert | S-M | cliente da 4.4 |
| 4.6 Regra de envelope cor mista quando Bruno responder D-2 (mexer nas DUAS copias: `envelope.js` + `data/router.js:1109`) | S | codigo trivial, bloqueado em decisao |

CHECK DE SINCRONIA: 1 dia real inteiro impresso pela Central: N etiquetas, 0 duplicadas, rodape com local REAL (fase 1), preflight pegou pelo menos os avisos esperados, `printed_at` carimbado em todas as linhas, e o operador nao abriu a Veeqo nenhuma vez.

### FASE 5 — Acompanhamento de funcionarios, polimento

Sem dependencia das fases de estoque; ordenavel por folga de agenda apos a Fase 0.

| Tarefa | Tamanho |
|---|---|
| 5.1 Escalacao no-clockin/no-task (presente sem contato com /op -> Carolina apos N min, padrao anti-spam do forgotten-checkout que provadamente funciona) — ataca a classe real do incidente das horas | M |
| 5.2 Faixa semanal por pessoa (7 dias: horas, idle, gaps) — a unica view genuinamente faltante | M |
| 5.3 Pausa proeminente no card de tarefa rodando do /op (+ nudge da Carolina em idle com tarefa aberta) | S/M |
| 5.4 Densidade compacto/normal no Hoje (pref `user_prefs`) | M |
| 5.5 Persistir filtros do Hoje como pref | S |
| 5.6 Quick-switch (terminar A + comecar B) no /op | M |
| Descartados como ruido (veredito dos auditores): heatmap de idle, comparar-dois-dias, entrada de tarefa por voz, cadencia de refresh configuravel, NFC/QR (defer ate 5.1 se provar insuficiente) | — |

CHECK DE SINCRONIA: 1 semana sem tela branca; 1 caso real de trabalho-sem-/op cobrado pela Carolina em < N min; Bruno responde "consigo ver a semana da Simone em 1 clique".

---

## (c) QUICK WINS (menos de 1 dia cada, ranqueados por alavancagem)

1. **0.1+0.2** Crash do Timeline + ErrorBoundary (meio dia; devolve o drill de pessoa e blinda o dashboard).
2. **0.3** Guard do deducted_at (a menor mudanca que torna todo o flip-to-live seguro).
3. **0.7** Ligar o planner (1 env var; a camada "produza A/B/C" que Bruno pede JA EXISTE e nunca falou).
4. **0.8** Comparador P&P digitado vs enviado (primeiro sinal de confianca ponta a ponta).
5. **0.11** Cores de garrafa nos 14 SKUs (mata ~87% dos envelopes "?").
6. **0.6** Silenciar drift ate a carga (para de gritar lobo 25-76x/dia).
7. **0.10** Dup-check no preview (~40 linhas; post-mortem das 13h vira captura pre-papel).
8. **0.4+0.5** Fixes do ajuste inline (unplaced + dica de 0 locais).
9. **1.3** Chips de local clicaveis -> imprimir etiqueta em 1 clique (de 5-6 cliques/3 telas para 1).
10. **0.14+0.15** Duas mensagens: por que o botao nunca foi apertado + o grid do Hoje ja existe.
11. **0.12, 0.13, 5.5** Eixo do timeline, razao pre-preenchida + busca em Locais, filtros persistidos.
12. **3.2 (parte S)** Qtd sugerida no texto do alerta do planner (~15 linhas).
13. Documentar em `docs/ARCHITECTURE.md` que `STOCK_DEDUCT_MODE` exige restart.

## (d) DECISOES DO BRUNO (so ele pode decidir)

- **D-1 QUANDO e o mutirao da carga fisica** (data, quem conta, meta de dias). E a decisao que destrava o plano inteiro. Tamanho L de trabalho fisico, zero codigo.
- **D-2 Regra do envelope cor mista** ("3 pretas cabe 1 branca?", aberta desde 08). Codigo e trivial, esta bloqueado so na resposta.
- **D-3 Valores de threshold** (min dias/unidades) pros ~10 mais vendidos.
- **D-4 OK para o UPDATE** de limpeza dos 1.793 error_note velhos.
- **D-5 Estrategia de adocao da impressao**: treinar o fluxo atual da Central (aba no .246) OU construir o HF-PrintAgent primeiro e so entao cobrar adocao. A resposta do "por que 0 usos" informa isso.
- **D-6 Uma definicao de days_of_stock**: a do planner (14d, armazem+marketplace) ou a do hub (7d, so armazem), ou duas com nomes diferentes.
- **D-7 Go do piloto Fase B** (comprar etiqueta via API): qual canal primeiro (sugerido: HealthFare Website), 1 pedido de teste.

## (e) O LOOP DE VERIFICACAO (o teste que prova o sonho)

**O teste da garrafa: 1 garrafa real, acompanhada por TODOS os elos, repetido apos cada fase e depois 1x/semana.**

1. Escolher 1 produto com estoque carregado (pos Fase 1). Anotar: prateleira, caixa, Veeqo.
2. Chega pedido real -> conferir que o hub mostra reservado +1 e o picklist do dia inclui.
3. Imprimir pela Central (pos Fase 4: 1 clique com preflight) -> etiqueta sai com rodape certo: apelido, COR/envelope certo, LOCAL real da prateleira -> `printed_at` carimba na linha.
4. Enviar -> em 1 tick do worker: linha shipped, `deducted_at` preenchido, 1 row em `stock_movements` (pick da prateleira certa), prateleira -1 na tela.
5. Drift watch NAO acusa esse produto no dia seguinte (nos e Veeqo cairam juntos).
6. Comparador diario: total digitado no P&P bate com enviados Veeqo dentro da tolerancia.
7. sold_7d/days_of_stock do produto mexem; se entrar em zona "plan", o alerta do planner E a PlanPage E o hub dizem o mesmo numero e a mesma sugestao de quantidade.
8. Variacao mensal: cancelar 1 pedido apos envio -> incidente criado + unpick devolve a garrafa (pos Fase 2.1).
9. Variacao de gente: no mesmo dia, conferir no Timeline que quem embalou aparece com a tarefa certa, sem gap, e que expandir a pessoa NAO crasha.

Se qualquer passo falhar, esse elo volta a ser o "passo 1" da proxima sessao de trabalho. O sistema so e declarado sincronizado quando o teste da garrafa passa inteiro 2 semanas seguidas sem intervencao manual.

---

Arquivos-chave citados: `src/workers/veeqo-order-sync.js`, `src/v3/services/StockService.js`, `src/v3/wire.js`, `src/workers/stock-drift-alert.js`, `src/workers/stock-alerts.js`, `src/workers/stock-gap-alert.js`, `src/v3/warehouse/router.js`, `src/v3/warehouse/weights.js`, `src/v3/shipping-labels/{service,envelope,footer}.js`, `src/v3/print-queue/router.js`, `src/op/ws.js`, `src/op/app.js`, `dashboard-v4/src/pages/WarehousePage.jsx`, `dashboard-v4/src/components/Timeline.jsx`, `dashboard-v4/src/components/WidgetGrid.jsx`, `dashboard-v4/src/pages/OtherPages.jsx`, `src/v3/data/flow-views-repo.js`, `docs/architecture/study/S15-VEEQO-LABEL-API-STUDY.md`.
