# S03 · Linha do tempo operacional — estudo de redesenho (2026-09-10)

Pedido do Bruno (09-10): *"nos precisamos reajustar o timeline, agora está muito difícil de entender... aquele monte de cores, os botões às vezes ficam muito grandes e o texto se corta, overlapping... editar quando entram errado é difícil... 'Novo registro' devia ficar na área da timeline e ser simples como o kiosk... o corte do correio nem precisava estar ali todo dia... investigate how other systems do it properly, professionally, so that we don't have to rework it again."*

Este documento é o estudo. A execução (protótipo + implementação) vem depois dele e referencia as regras daqui pelo número (R1..R14).

---

## 1. Veredito em uma frase

A timeline atual desenha **cada evento do banco como um bloco cheio de cor e texto**, e por isso quebra em três lugares: (a) o **modelo** trata "tarefa que a pessoa faz com a mão" e "processo/máquina pelo qual ela responde" como a mesma coisa, então metade do dia vira "SIMULTÂNEO" rosa; (b) o **desenho** põe 3 linhas de texto + chips dentro de blocos que muitas vezes têm 30 px de largura; (c) a **edição** vive num formulário genérico longe do gesto (botão no topo da página, 9 campos). Sistemas profissionais resolvem os três com regras simples que estão na §4.

## 2. O que existe hoje (código)

| Peça | Onde | O que faz |
|---|---|---|
| Componente | `dashboard-v4/src/components/Timeline.jsx` (939 linhas) | eixo de horas, uma row por operador, blocos absolutos por minuto, drag (mover/redimensionar/juntar), sub-lanes por sobreposição, pausa inline, marcadores de ponto, tab do correio, gap zones clicáveis, expansão por pessoa |
| Estilo | `dashboard-v4/src/timeline.css` | `.tl-block` 54 px de altura, gradiente cheio, 3 linhas (`bk-fn`, `bk-pr`, `bk-time`), min-width 28–30 px, raio 10 px |
| Dados | `adapters/adapt-to-hfdata.cjs` → `events[]` | `op`, `activity` (slug), `started_min/ended_min`, `cowork`, `_is_background`, `_cowork_group_id`, `_total_paused_seconds` |
| Fonte | `GET /api/v3/data/timeline?date=` + `/attendance?date=` | eventos por pessoa; batidas (`markers[]`) |
| Criar | `App.jsx newEvent()` → `SidePanel` modo edit | botão "Novo registro" no **topbar**; abre painel com 9 campos: operador (select), atividade (select com 40 opções), produto (select), início (12:00 fixo), fim, quantidade, unidade, cowork (chips), descrição |
| Preencher gap | `CommandCenter.jsx` `onGapClick` → `FloatingPopover` | só 5 "motivos" + nota; não permite escolher atividade real |
| Catálogo | `v3.activity_types` | 44 tipos ativos; 6 `is_background` (formulation, mixing, encapsulation, separating, weighing); 3 fluxos (production/pnp/support) + `null` |

Regras já decididas pelo Bruno que a nova versão **mantém**: pausa na mesma lane (08-20); drag entre lanes bloqueado, troca de pessoa só pelo painel (E5); "ao vivo" nunca ganha fim por drag; DAY_END estica pra caber saídas de noite (07-23); saída do relógio = "saiu HH:MM", não idle; "bateu o ponto e não iniciou tarefa" em vermelho (07-23).

## 3. Diagnóstico com o dia real (09-09, 56 eventos, 4 pessoas)

Li o dia inteiro no banco (`timeline?date=2026-09-09`). Os problemas que o Bruno vê têm causa identificável:

**D1 · "Simultâneo" é quase sempre falso.** Dos 11 blocos rosa do dia, 9 são `Linha de Produção` + `Impressão de Labels` (Caroline 12:07, 13:28, 14:50, 15:34, 16:45; Larissa 11:22) ou `Empacotamento` + `Impressão de Labels`. A impressora roda sozinha; a pessoa só a acompanha. `label_printing` (id 44) está cadastrado como tarefa de mão (`is_background=false`) quando na prática é processo paralelo, igual a `encapsulation`. O rosa está dizendo "esta pessoa faz duas coisas ao mesmo tempo" quando a verdade é "esta pessoa cuida de uma máquina enquanto faz outra coisa".

**D2 · Eventos de 0 minuto viram blocos de 28 px.** 4344 (15:27→15:27), 4351 (16:07→16:07), 4356 (17:29→17:29) no dia do Bruno S.; são reinícios do kiosk. Cada um ganha um bloco mínimo com texto cortado ("Re…"). Isto é o "texto se corta" que o Bruno descreve.

**D3 · Duplicatas exatas ocupam lane.** 4339 e 4340 (Vitor, encapsulation 14:42→15:27) são o mesmo registro duas vezes; 4325/4326/4329 (Bruno S., encapsulation 12:16/12:16/12:22) idem. Cada cópia empurra a row pra baixo (sub-lane nova). A timeline não deve "corrigir" o banco, mas deve **agrupar visualmente** o que é idêntico (R9) e apontar o duplicado pra quem edita.

**D4 · Cores demais com significado de menos.** Hoje há: 3 cores de fluxo (navy/teal/roxo) com gradiente, rosa "simultâneo", âmbar de pausa, verde de check-in, cinza de check-out, azul de almoço no relógio, vermelho de saída sem volta, laranja do correio, verde "agora", hachura de gap. **Onze** cores para um widget cuja pergunta é uma só: *o que cada pessoa está fazendo agora e o que fez hoje.* A cor devia responder a isso e nada mais.

**D5 · Texto dentro do bloco não escala.** O bloco carrega nome da atividade + produto + duração + chips de cowork + selo simultâneo. Um bloco de 30 min a 140 px/h tem 70 px: cabem 6 caracteres. O bloco de 5 min tem 12 px. Regra da indústria (§4): label só quando cabe; senão nada, e a informação vai pro hover/painel.

**D6 · O ponto compete com as tarefas.** As batidas são pílulas verdes/cinzas *em cima* das tabs de background, na mesma faixa vertical. Em dia com background (Bruno S., Vitor) o "Check-in: 11:16 AM" cobre a tab "Pesagem". A batida é um **limite** do dia da pessoa, não um evento; deve ser desenhada como limite (borda da área "no trabalho"), não como bloco.

**D7 · O corte do correio é uma linha de ruído diária.** Uma row inteira ("Notif.") com uma tab laranja às 13:00 todo dia. O Bruno já sabe. O correio já vive no card P&P do dia. Sai da timeline (R12).

**D8 · Criar registro está longe do gesto e pede demais.** O botão fica no topbar (ao lado da data), abre um painel que começa com o **primeiro operador da lista** e **12:00** fixo, com select de 44 atividades sem agrupamento. O kiosk faz o mesmo em 3 toques (pessoa já sabida → atividade agrupada por fluxo → "agora" ou "esqueci"). O admin precisa do equivalente: pessoa do dia → atividade em grade → início/fim já preenchidos pelo contexto (clique numa hora vazia = início ali; fim = próximo evento ou agora) → quem estava junto.

**D9 · Editar erro é caçar.** Pra trocar a pessoa de um evento errado: clicar no bloco (às vezes 12 px), abrir painel, Editar, select. Pra estender um fim: pegar a borda de 6 px. Não há atalho pra "juntar estes dois", "este era de fulano", "apagar os três de 0 min".

## 4. Como sistemas profissionais fazem (pesquisa 09-10)

(Fontes e tabela comparativa completa: §7. Aqui vai o que importa pra nós.)

**R1 · Uma lane primária por pessoa, sempre.** Deputy, When I Work, Homebase, Toggl, Clockify, Google Calendar (dia): a linha da pessoa mostra **uma** coisa por vez em altura cheia. Concorrência real é exceção e vira (a) coluna dividida dentro do mesmo bloco (calendário) ou (b) trilho fino acima/abaixo (Gantt, Grafana state timeline). Nunca 3 lanes de 54 px empilhadas.

**R2 · Processo paralelo = trilho fino (rail), não bloco.** Grafana "State timeline" e traces (Datadog/Honeycomb) desenham estados longos como faixas de 6–10 px com o rótulo **fora** ou só no hover. Encapsulação/pesagem/impressão de labels são estados de máquina que a pessoa acompanha: viram um rail de 8 px em cima da lane, com o nome só quando a faixa tem > 90 px.

**R3 · Label só quando cabe, senão nada.** Regra do Google Calendar e de todo Gantt sério (dhtmlx, Bryntum, Frappe): abaixo de 28 px o bloco fica **mudo** (só cor + borda); 28–60 px um código de 3 letras; 60–110 px o nome curto; acima, nome + produto e duração. O texto nunca é cortado no meio da palavra com "…" em 3 linhas; o hover/painel carrega o resto.

**R4 · Blocos baixos, densidade alta.** Toggl/Clockify: 24–32 px por entrada; Google Calendar: 24 px por 30 min. Nossos 54 px + 6 de gap + 20 de tab + 28 de topo = 114 px por pessoa *antes* de qualquer sobreposição. Alvo: row de 56 px (rail 8 + lane 36 + folgas), expandível.

**R5 · Fundo neutro, cor como borda/faixa.** Linear, Asana, Bryntum "light": bloco com fundo claro da categoria (10–15 % de tinta) e **borda esquerda de 3 px** na cor cheia; texto em tinta escura, não branco sobre gradiente. Contraste sempre ≥ 4.5:1, e a categoria continua legível em daltonismo porque a borda + ícone repetem a informação.

**R6 · No máximo 3–4 matizes categóricos + 1 semântico.** Toda a literatura de visualização (Few, Munzner, ColorBrewer qualitativo) para em 4 cores categóricas legíveis. Nós temos 3 fluxos: **Produção / P&P / Suporte** ficam. Tudo o mais (pausa, almoço, saiu, sem registro) é **neutro** (cinza com textura). Vermelho/âmbar ficam reservados pra "precisa de ação" (bateu o ponto e não iniciou; saída sem volta; duplicado).

**R7 · "Agora" é uma linha só, com selo no eixo.** Igual ao que já temos, só que sem o círculo verde por row: uma linha de 2 px atravessando, selo "AGORA 1:26 PM" no eixo, blocos ao vivo com borda direita aberta (sem raio) e um ponto pulsante.

**R8 · Limites do turno como sombra, não como pílula.** Deputy/When I Work desenham o turno como área; o que está fora do turno é cinza mais escuro. Check-in/check-out viram a **borda da área clara** da pessoa (antes do check-in e depois do check-out a lane fica sombreada). Almoço do relógio = faixa neutra hachurada. Pílula de texto só no hover, e um triângulo de 6 px no eixo da row marca a batida.

**R9 · Agrupar o idêntico, apontar o suspeito.** Gantt e traces colapsam eventos iguais consecutivos. Eventos com mesmo slug, mesma pessoa e sobreposição ≥ 90 % viram **um** bloco com contador "×2" e marca de atenção; eventos de < 2 min viram um **tique** de 3 px (não um bloco), com contador no painel da pessoa.

**R10 · Cowork = um bloco compartilhado, ligado entre rows.** Google Calendar duplica o evento em cada convidado; Deputy mostra o turno em cada pessoa com o mesmo id. Mantemos um bloco por pessoa (é o que o banco tem: um evento por participante, `cowork_group_id`), mas com **hover que acende o grupo inteiro** e uma barra vertical fina ligando as rows quando o grupo está visível. Chips "LB/CB" dentro do bloco somem; vão pro hover e pro painel.

**R11 · Criar pelo gesto, com padrões inteligentes.** Google Calendar / Toggl: clique (ou arraste) em espaço vazio na row da pessoa cria o registro **ali**, com popover de 3 campos: atividade (grade, agrupada por fluxo, recentes primeiro), início/fim já preenchidos (início = onde clicou, arredondado a 5 min; fim = próximo evento ou agora), quem estava junto. "Mais opções" abre o painel completo. O botão "Novo registro" desce pro cabeçalho da timeline e faz o mesmo popover com a pessoa a escolher primeiro (lista das pessoas do dia + "outra pessoa…" pra cadastro rápido).

**R12 · Só o que é do dia da pessoa entra na timeline.** Deadlines, notificações e metas ficam nos cards. O correio sai da timeline; se um dia for preciso, vira um tique no eixo (não uma row).

**R13 · Densidade com dois modos, não zoom infinito.** Toggl/Calendar: "compacto" e "confortável". Zoom de pixel por hora fica (já existe), mas o padrão passa a ser 110 px/h com o dia 8h–18h cabendo em ~1100 px, e "confortável" = 160 px/h.

**R14 · Ações de correção a um clique do bloco.** Seleção mostra uma **barra de ações** flutuante: mover pra outra pessoa (lista), juntar com o anterior/próximo, dividir aqui, apagar, marcar como duplicado. Multi-seleção com Shift pra "apagar os três de 0 min". Drag continua pra horário; a barra cobre o resto.

## 5. O modelo novo (o que muda de conceito)

1. **Duas camadas por pessoa:** *tarefa* (mão) e *processo* (máquina/lote que ela acompanha). Só a tarefa tem altura cheia. Processo é rail. A classificação já existe (`is_background`); precisa corrigir `label_printing` (→ background) e revisar `order_printing`.
2. **Estado da pessoa deriva das camadas + relógio:** fora do turno · no trabalho sem registro (gap) · em tarefa · em pausa/almoço · saiu. Cada estado tem UM desenho.
3. **Cor = fluxo (3) + neutro + atenção.** Nada mais.
4. **Texto tem 3 níveis por largura** (R3). O painel/hover é onde a informação completa mora.
5. **Criar/editar acontece no lugar** (R11/R14). O painel completo continua existindo pra "mais opções".

## 6. O que fica fora deste redesenho

- O kiosk `/op` (Bruno: "não mexer for now, we will at the end").
- O modelo de dados dos eventos (um evento por participante, `cowork_group_id`) e o backend de correções (PATCH/merge/split já existem em `/api/v3/data/events`).
- Pausa inline (`timeline-pause.cjs`): a lógica fica; só o desenho muda.

## 7. Pesquisa: produtos comparados (09-10)

Pesquisa feita em documentação oficial (Google, Toggl, Clockify, Connecteam, When I Work, Jira, Linear, Grafana, Datadog, Honeycomb, Bryntum, FullCalendar, DHTMLX) e literatura (Wilke, Okabe-Ito, WebAIM/WCAG, A List Apart, Carbon). O que se repete em todos:

| Padrão | Quem faz | O que a gente tira |
|---|---|---|
| Nome da linha nunca dentro da barra | Jira, Linear, Honeycomb, Datadog (coluna fixa à esquerda) | coluna da pessoa fixa; o bloco só carrega a tarefa |
| Label some quando não cabe; hover carrega o resto | Grafana `Show values: Auto`, flame graphs, Connecteam "Minimized" | R3, escada por largura (abaixo) |
| Hachura/opacidade/tracejado = estado; matiz = categoria | When I Work (listras = não publicado), Datadog (tracejado = inferido) | R6: pausa/almoço/fora do turno = neutro hachurado |
| Fundo claro + texto escuro (+ barra colorida à esquerda) | Google "Classic", Bryntum light | R5; branco sobre cor saturada falha WCAG em 5 das 6 cores Okabe-Ito |
| Altura da linha fixa; sobreposição empacota dentro (`pack`), não cresce a linha (`stack`) | Bryntum `eventLayout`, algoritmo do Google Agenda ("calendar puzzle") | R1; cluster → lanes só dentro do cluster; teto 2–3 lanes, depois "+N" |
| Mínimos: 15 px de altura, 30 px "curto", 30 px de largura | FullCalendar `eventMinHeight/ShortHeight/MinWidth` | R3/R9: < 2 min vira tique, não bloco |
| "Agora" = uma linha em todas as linhas + ponto na régua; passado esmaecido | Google (vermelho), Clockify (azul), Toggl (roxo), Jira (laranja) | R7; correio = tique na régua só sob toggle |
| Batidas = envelope do turno, não blocos | Deputy, Hubstaff, Connecteam ("scheduled vs actual") | R8 |
| Dois modos de densidade | Google (Responsive/Comfortable/Compact), Connecteam (Minimized), Carbon 24/32/48 | R13 |
| Criar onde o dado mora: clique/arraste no vazio → popover mínimo | Google (Shift+C, arrasto), Toggl (clique preenche início=fim, `M` manual, "8a"), Clockify (admin escolhe a pessoa e clica no calendário dela; reatribui clicando no nome), Connecteam ("+" no hover da célula) | R11; "+" na ponta da faixa = "esqueci de marcar" em um clique |
| Grupo = bloco repetido em cada pessoa, irmãos acendem no hover; sem linhas cruzando | Google (convidados), Deputy (turno selecionado escuro, relacionados claros) | R10 |
| ≤ 5 matizes categóricos; cor nunca é o único canal | Wilke, Okabe & Ito | R6: 3 fluxos + ícone/borda |
| Zebra nas linhas ajuda e agrada | A List Apart (2 estudos) | zebra sutil por pessoa |

Escada de rótulo recomendada (régua ~1,8 px/min, 8h–18h em ~1100 px): ≥ 110 px nome completo + duração · 60–110 px nome curto · 28–60 px código de 3 letras · 12–28 px só cor · < 12 px desenha 12 px mas mantém as bordas reais pro clique. Fonte mínima 11 px pra qualquer coisa que se leia (Apple HIG; Stéphanie Walter, apps densos).

Algoritmo de sobreposição (por pessoa): ordena por início; agrupa em clusters por sobreposição transitiva; dentro do cluster, first-fit em lanes; altura da lane = (altura da faixa − folgas) / nº de lanes; acima do teto, um bloco só com "+N". Um cruzamento às 10:00 não encolhe o resto do dia.

Fontes principais: support.google.com/calendar/answer/15619910 e /72143 · support.toggl.com (calendar view, manual mode) · clockify.me/help (calendar view, add time for others, overlapping entries) · help.connecteam.com (viewing options, creating shifts) · help.wheniwork.com (scheduler reference) · help.deputy.com (area color coding, clocked vs approved) · grafana.com/docs (state timeline) · docs.datadoghq.com (trace view) · docs.honeycomb.io (trace waterfall) · brendangregg.com/flamegraphs · bryntum.com (SchedulerEventRendering `eventLayout`) · fullcalendar.io/docs (eventMinHeight, eventShortHeight, eventMinWidth) · github.com/taterbase/calendar-puzzle · clauswilke.com/dataviz/color-pitfalls · jfly.uni-koeln.de/color · webaim.org/articles/contrast · alistapart.com (zebra striping) · carbondesignsystem.com (data table sizes).

## 8. Protótipo e plano de execução

**Protótipo interativo** (dia real 09-09, 56 registros, sem gravar nada): https://claude.ai/code/artifact/090c0cea-0168-4828-a0c3-b83ef747c1e7 — fonte em `docs/architecture/study/img/linha-do-tempo-proto.html`. Ele aplica R1–R14: faixa única por pessoa, trilho pra máquina/lote, 3 cores, escada de rótulo, batidas como envelope, tiques pra < 2 min, "×N" pra duplicados, correio fora, popover de registro no clique/"+" da faixa, barra de correção no bloco, hover de grupo, compacto/confortável, simulação de "agora".

**Decisões que dependem do Bruno antes de codar:**
1. `label_printing` (Impressão de Labels) passa a `is_background=true` (trilho)? O protótipo assume que sim. Mesma pergunta pra `order_printing` (hoje fica como tarefa de mão; a impressora de ordens é rápida, então provavelmente fica).
2. Nome curto por atividade: campo novo `short_name` em `v3.activity_types` (migration) ou mapa no front? Recomendo o campo.
3. "Outra pessoa…" no registro rápido cria pessoa com nome + cargo (sem PIN/relógio) — ok?

**Fases (depois do OK):**
- **T1 · Desenho** (só `Timeline.jsx` + `timeline.css`, sem tocar API): camadas trilho/tarefa, escada de rótulo, cores, envelope do ponto, tiques, colapso de duplicados, correio fora, compacto/confortável. Testes de layout puros (funções `layoutRow`, `labelLevel`, `collapseDupes` em `.cjs` testável como `timeline-pause.cjs`).
- **T2 · Registrar e corrigir no lugar:** popover de registro (clique no vazio, "+" da faixa, botão no cabeçalho da timeline; o do topbar sai), barra de ações no bloco (mover pessoa, juntar, dividir, duplicado, apagar), Delete/N/Esc. Reusa `POST/PATCH/merge/split` que já existem.
- **T3 · Dados:** migration com `short_name` + `label_printing` background; cadastro rápido de pessoa (`POST /api/adminpanel/persons` já existe; só o atalho).
- Kiosk `/op` não muda.

