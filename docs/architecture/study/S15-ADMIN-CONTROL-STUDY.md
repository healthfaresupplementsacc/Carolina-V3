# S15 · Estudo: controle do estoque pelo ADMIN (dashboard) · 2026-09-09

Pedido do Bruno (09-09): "let's study our inventory page, ensure it's the perfect system to
track and control our inventory, easy to add, adjust, remove inventory (with approval depending
on user). For now only the admin control page (dashboard), not the kiosk."

Escopo: a seção **Estoque** do dashboard-v4 (hub `#estoque`, Montar estoque, Aprovações, Locais,
Etiquetas, Product Setup, Configurações). O kiosk do operador (`/op/estoque.html`) fica fora,
mas as regras de aprovação tocam nele por tabela.

Base: código lido (WarehousePage 1.981 linhas, StockLoadPage 1.250, warehouse/router, StockService,
StockRequestService, simple-set), banco de produção consultado em 09-09 22:30 NY, screenshots reais
em `img/S15-admin-2026-09-09/` (login admin, 1440x900), MASTER-SYNC-PLAN e as decisões do Bruno
de 08-17/18/22 (memórias warehouse-inventory-model, box-types, sku-parent, shrinkage).

---

## 1. O que existe hoje (fatos, não opinião)

**Construído e no ar desde 18-19/08 (fases 1, 2, 3 + Montar estoque 22/08 + modo simples 04/09):**
- Hub `#estoque` com dois modos. **Simples** (padrão): uma linha por produto, colunas Veeqo ·
  Prateleira · Caixa · A organizar · Confere, célula editável (`simple/set`: quantidade ABSOLUTA por
  escopo, cria prateleira/caixa "de casa" sozinho, idempotente por uuid). **Completo**: 8 KPIs,
  lista "precisa de atenção", tabela com filtros, painel lateral por produto com 7 abas (Locais,
  Pedidos abertos, Movimentos, Separadas, Pendências, Família, Config).
- Verbos do admin no hub: Entrada · Organizar · Mover · Ajustar · Separar · Devolução · Família/SKUs ·
  Importar Veeqo · Juntar SKUs. Todos aplicam **na hora** (porta única `StockService`, ledger
  append-only `v3.stock_movements`, audit por rota).
- Fila de aprovação (`StockRequestService`, kinds take/entrada/count/return_in/issue_release/adjust):
  **só o operador propõe** (kiosk). Página Aprovações + badge no hub.
- Montar estoque: 3 passos (Produtos e pesos → Locais e caixas → Contar e carregar), balança
  híbrida, tipos de caixa com tara aprendida.
- Locais (prateleiras/caixas, wizard em massa), Etiquetas (Code128+QR 4x6), Product Setup,
  Configurações (thresholds).
- Automação: reserva por pedido aberto da Veeqo (já: `reserved = 158`), drift Veeqo vs nosso a cada
  10 min (`WORKER_STOCK_DRIFT_ENABLED=true`), dedução no envio **em dry** (`STOCK_DEDUCT_MODE=dry`).
- RBAC do dashboard: funções `view_stock` / `manage_stock` / `product_setup`; perfis admin (tudo),
  manager (tudo menos bloco admin), operator (sem estoque). Logins reais: **Admin** (admin),
  **Henrique** (manager), Larissa (operator, não vê estoque).

**Estado do banco em 09-09 22:30 NY:**

| Tabela / número | Valor |
|---|---|
| Produtos (kind=bottle, ativos) | **110** (101 com apelido, **0 com peso unitário**) |
| Prateleiras · Caixas · Tipos de caixa · Locais | **0 · 0 · 0 · 0** |
| Movimentos no ledger (desde sempre) | **0** |
| Pedidos de aprovação (desde sempre) | **0** |
| Garrafas na Veeqo (SKU base, só bottle) | **17.413** |
| Produtos "batendo" com a Veeqo | 13 (os que têm 0 dos dois lados) |
| Produtos em drift | 75 |
| Reservado (pedidos abertos Veeqo) · Disponível | 158 · **−158** |

Três semanas depois de pronto, **ninguém entrou um número**. O sistema está inteiro e vazio.

---

## 2. Diagnóstico (6 achados, do mais grave ao menor)

### A1 · O alvo some: a coluna Veeqo fica vazia por minutos ou horas
O desenho inteiro da carga é "conte e digite até bater com a Veeqo". A coluna Veeqo vem de um cache
em memória (`veeqo-cache.js`, SWR 10 min) alimentado por `listSellables()` = 5 páginas de 100 com
**timeout de 20 s**. No Railway a chamada estoura o timeout com frequência (log: `[warehouse] veeqo
cache: Veeqo timeout (20000ms)`); do PC do Bruno a mesma chamada leva 6 s. Enquanto o cache está
vazio o hub mostra "sem Veeqo" nas 110 linhas e "0 garrafas contadas de 0 na Veeqo" (screenshot 1,
tirado 14 min após um deploy; às 22:34 o cache encheu sozinho). Todo deploy/restart repete isso.

Detalhe que resolve: **`v3.veeqo_snapshots` já guarda, a cada 6 h, o estoque por SKU** (487
sellables com `wh.physical`, 147 KB, 8 snapshots retidos). O alvo existe no banco; o hub só não usa.

### A2 · "Aprovação depende do usuário" não existe
Hoje há um único interruptor: `manage_stock`. Quem tem, aplica tudo na hora (entrada, ajuste pra
baixo, separar, devolução, contagem); quem não tem, não vê a página. Henrique (manager) tem o
mesmo poder que o Admin sobre o estoque. Só o operador do kiosk cai na fila. Não há **Desfazer**:
um erro de digitação em "Ajustar" é corrigido com outro ajuste, e o histórico fica com dois
movimentos sem ligação entre si.

### A3 · Faltam dois verbos do jeito que o Bruno pensa (adicionar · ajustar · remover)
- **Remover / Saída** não existe na página do admin. Sair sem venda (amostra, uso interno, extra num
  pedido cuja etiqueta já saiu, descarte, transferência) hoje só cabe em "Ajustar" com número
  negativo, que é um verbo de correção de contagem, não de saída. É exatamente o buraco do
  shrinkage (memória inventory-shrinkage-control, camada 1: "botão fácil de saída").
- **Entrada da produção** é manual. O modelo do Bruno (passo 1) diz: lote fecha com total → entra no
  armazém. O total do lote já existe no tracker (`production_counts`); não vira entrada.

### A4 · Muitas portas e muito ruído enquanto está vazio
Seção com 7 páginas (+2 antigas escondidas); hub com 7 botões no topo (Modo, Entrada, Juntar SKUs,
Importar da Veeqo, Aprovações, Locais, Etiquetas). O modo completo com estoque zero mostra 110 itens
"ZERADO", "Disponível −158" e "APPL-3200 negativo" (screenshot 2): alarmes verdadeiros no papel,
inúteis antes da carga. "Montar estoque" tem 3 passos e o passo 1 pede peso de 110 produtos, sendo
que o modo simples já carrega sem peso nem tipo de caixa (screenshot 3).

### A5 · Nomes e catálogo
Linhas como "10,573mg NAD Supplement 60 capsules" e "[125 Test Strips] Feminine pH Checker" são
`kind=bottle` com título cru da Veeqo: poluem a lista do mutirão. O `kind` (bottle/plan/medication/
supply/service/other) existe desde a migration 078; precisa de uma passada nesses 10-15 casos.

### A6 · O que já está certo e não deve mudar
Porta única de escrita (StockService), ledger append-only + audit, reserva automática por pedido
aberto, drift contínuo com alerta (nunca sobrescreve), SKU pai = unidade física, dedução em dry até
a carga (guard F0 do MASTER-SYNC-PLAN), modo simples idempotente que cria locais sozinho.

---

## 3. O que "perfeito" significa aqui (princípios que a proposta segue)

1. **Uma porta.** Uma página governa o estoque; o resto é gaveta, passo ou histórico.
2. **Três verbos na cara: Entrada · Ajustar · Saída.** Os físicos (Mover, Organizar, Separar) ficam
   em "mais".
3. **O alvo sempre visível.** A coluna Veeqo nunca fica vazia; quando é de snapshot, diz a idade.
4. **Cada número com quem, quando, por quê e origem.** Já existe no ledger; falta aparecer.
5. **Para o dono, Desfazer vale mais que aprovar.** Aprovação é pra quem não é dono do número.
6. **Nunca bloquear (RULE #0).** Proposta pendente é registrada e visível; recusar não apaga nada.
7. **A Veeqo confirma, não manda** (até a carga; depois o nosso sistema passa a comandar a Veeqo,
   decisão round 3).

---

## 4. Proposta

### 4.0 · Consertar o alvo (bug, pequeno, destrava o mutirão)
- No boot, **aquecer o cache com o snapshot mais novo** de `v3.veeqo_snapshots` (147 KB, 1 query).
- Quando `listSellables()` vier, **gravar um snapshot** (já é o formato) e trocar o cache.
- Timeout do refresh de fundo: 20 s → 60 s (é background SWR, nada espera por ele).
- Coluna Veeqo com selo de idade: "Veeqo · 4h" / "Veeqo · agora". Nunca "sem Veeqo" quando há snapshot.
Tamanho S. Arquivos: `veeqo-cache.js`, `warehouse/router.js` (checked_at + age), `WarehousePage.jsx` (selo).

### 4.1 · Política por usuário (a matriz)
Regra proposta: **quem reduz o total ou corrige contagem sem ser o dono, propõe. Quem é dono, faz
e pode desfazer.** Mover entre prateleira e caixa nunca precisa de aprovação (o total não muda).

| Verbo | Admin (owner) | Manager | Operador (kiosk, já é assim) |
|---|---|---|---|
| Entrada (garrafas novas) | direto | direto | proposta |
| Organizar / Mover prateleira↔caixa | direto | direto | direto |
| Ajustar **pra cima** (achou mais) | direto | direto | proposta (count) |
| Ajustar **pra baixo** (achou menos) | direto, motivo obrigatório, Desfazer 24h | **proposta** | proposta (count) |
| **Saída** (amostra, uso interno, extra em pedido, transferência) | direto, motivo obrigatório, Desfazer 24h | **proposta** | proposta (take) |
| Separar (danificada / etiqueta) | direto | direto (sai do vendável, não some) | direto |
| Descartar separada | direto | **proposta** | proposta |
| Devolução (volta ao estoque) | direto | **proposta** | proposta |
| Entrada da produção (4.5) | aprova com 1 clique | aprova com 1 clique | n/a |

Implementação: `StockRequestService` já tem os kinds; a rota do dashboard passa a olhar o perfil
do login (`role` em `v3.app_logins`) e, para manager nos verbos marcados, cria a proposta em vez de
aplicar. Quem aprova: qualquer admin; manager nunca aprova a própria proposta. Aviso: badge no hub +
uma linha no digest diário do admin-orin (admin-orin não é lixeira; nada de 1 msg por proposta).

### 4.2 · Os três verbos + Desfazer
- **Entrada**: como hoje (destino = A organizar ou local), mais "veio de": produção (lote), Veeqo
  (import), compra/transferência, outro.
- **Ajustar**: uma tela só, "o sistema diz X, você contou Y", motivo obrigatório quando Y < X.
- **Saída** (novo): quantidade + motivo fixo (amostra · uso interno · extra no pedido #N · transferência
  · descarte) + observação. Vira movimento `take` com motivo; se for manager, proposta.
- **Desfazer** (novo): em cada linha de Movimentos, até 24 h, gera o movimento inverso com
  `reverses_movement_id`; nunca apaga. É o "approval" do dono: rápido, auditado, reversível.

### 4.3 · Uma porta só
- O hub é a página. **Montar estoque vira um passo-a-passo dentro do hub** enquanto a carga não
  terminou (barra: "13/110 batendo · 0/17.413 garrafas · 0 com peso"), e some quando terminar.
- Estado **"não carregado"** no modo completo: enquanto `total_bottles = 0`, esconde os 110 "ZERADO"
  e mostra um único bloco "Estoque ainda não carregado: comece pelo modo simples" com o CTA.
- Aprovações = gaveta com badge no hub (a página fica como histórico).
- Topo do hub: 3 verbos + busca + "mais" (Importar Veeqo, Juntar SKUs, Locais, Etiquetas).

### 4.4 · Histórico legível
Aba Movimentos já existe; passa a mostrar por linha: quem (login ou operador), quando, verbo, motivo,
origem (kiosk / dashboard / Veeqo / produção), pendente/aprovado/desfeito, e o botão Desfazer.

### 4.5 · Entrada da produção automática (o passo 1 do modelo do Bruno)
Lote da linha fecha com total (`production_counts`) → cria proposta "entrada de produção: 480 ×
Berberine, lote BR-2026-0431" → admin aprova com 1 clique (ou auto-aprova, se o Bruno quiser) →
entra em **A organizar** com lote. Reaproveita a fila que já existe; zero verbo novo.

### 4.6 · Catálogo
Passada nos ~15 produtos com título cru / kind errado (test strips, NAD, planos) antes do mutirão,
para a lista do modo simples ter só garrafa da linha.

---

## 5. O mutirão em números (D-1 do MASTER-SYNC-PLAN)
110 produtos · ~100 com estoque na Veeqo · **17.413 garrafas** · 18 produtos com 500+ (esses
valem pesar; o resto conta na mão). Com o modo simples (digitar prateleira e caixa por linha, locais
criados sozinhos) e o alvo sempre na tela (4.0), é **2 pessoas × 2 tardes**. Pré-requisito real:
zero (peso e tipo de caixa são opcionais; só aceleram os 18 grandes).

---

## 6. Ordem sugerida

| # | Item | Tamanho | Depende de |
|---|---|---|---|
| 0 | 4.0 Alvo Veeqo (snapshot no boot, 60 s, selo de idade) | S | nada |
| 1 | 4.6 Catálogo (kind/título dos ~15) | S | nada (dados) |
| 2 | 4.3 Estado "não carregado" + Montar dentro do hub + gaveta de Aprovações | M | 0 |
| 3 | 4.2 Saída + Desfazer + Ajustar unificado | M | decisão 4.1 |
| 4 | 4.1 Política por usuário (manager → proposta) | M | decisão 4.1 |
| 5 | O mutirão (físico) | L, zero código | 0, 1, D-1 |
| 6 | 4.5 Entrada da produção → fila | M | 5 |
| 7 | Dedução live (F2 do plano) | S | 5 + guard F0 |

## 7. Decisões do Bruno (respondidas em 09-09 23:00)

- **D-A** Permissões são por PESSOA, em Usuários & Acessos, com níveis; **o sistema nunca chama
  ninguém de manager/supervisor/gestão**. A matriz perfil × função de hoje vira modelo inicial;
  cada login ganha funções individuais numa seção "Controle de estoque" (ver §8).
- **D-B** Admin que reduz: motivo obrigatório + Desfazer 24 h. Confirmado.
- **D-D** Lote fechado: quem tiver a função "Receber a produção" recebe notificação no dashboard;
  clica, cai em Pendências, diz quantos ficam no armazém, confirma → entrada em A organizar.
- **Páginas sob Estoque**: "estão meio sem sentido"; cada uma precisa de uma função certa (ver §9).
- **Sem código em quantidade por enquanto.** Este documento é o plano.
- Ainda abertas: D-1 (data do mutirão), motivos fixos de Saída, auto-aprovar recebimento quando o
  receptor é o próprio Admin, envelopes/suprimentos vão para Impressão ou P&P.

## 8. Modelo de permissões: funções "Controle de estoque" (por pessoa)

Cumulativas, ligadas por login em Usuários & Acessos. Rótulos dizem o que a pessoa faz.

| Função | Libera | Hoje |
|---|---|---|
| Ver estoque | hub, números, histórico | `view_stock` |
| Organizar | mover prateleira↔caixa, organizar, separar (total não muda) | parte de `manage_stock` |
| Propor | entrada/saída/ajuste viram proposta | só kiosk |
| Mudar o total | entrada/saída/ajuste direto, motivo obrigatório + Desfazer 24 h | `manage_stock` |
| Aprovar | decide propostas dos outros (nunca a própria) | implícito |
| Receber a produção | avisado quando o lote fecha; decide quanto fica no armazém | não existe |
| Configurar | prateleiras/caixas, etiquetas, produtos, limiares | `product_setup` + parte de `manage_stock` |

Técnica: `v3.app_functions` ganha as chaves (`stock_view`, `stock_organize`, `stock_propose`,
`stock_change`, `stock_approve`, `stock_receive_production`, `stock_setup`); nova tabela
`v3.login_functions (login_id, function_key, granted)` sobrepõe o perfil; `hasFunction(login, k)`
passa a somar perfil + overrides; UsersPage ganha a seção por login. Rotas do warehouse trocam
`'write'` por a função exata do verbo; `stock_propose` sem `stock_change` → `StockRequestService.propose`.

Notificação por função: `v3.notifications` ganha `audience` (`{functions:[...]}` ou `{login_ids:[...]}`)
e `link` (hash do dashboard); o sino filtra pelas funções do login; clique abre `#estoque-pendencias?req=ID`.

## 9. Cada página sob Estoque: função certa

| Página hoje | Veredito |
|---|---|
| Estoque (hub) | **A página.** 3 verbos (Entrada · Ajustar · Saída), alvo Veeqo com idade, Desfazer, pendências em gaveta. "Mais": Mover, Organizar, Separar, Importar Veeqo, Juntar SKUs. |
| Montar estoque | Vira **assistente de carga dentro do hub** enquanto carga < 100%; some depois. Peso/tipo de caixa opcionais (só os 18 grandes). Sai do menu. |
| Aprovações | Vira **Pendências**: propostas + recebimentos da produção + histórico (decisões e desfazeres). Destino das notificações. |
| Locais | Fica como **Prateleiras e caixas**, no grupo Configurar. |
| Etiquetas | **Sai do menu**; continua como ação de Prateleiras e caixas e de Pendências. |
| Product Setup | Fica como **Produtos**; absorve tipo, título limpo, SKU pai/filhos, peso, mínimo. |
| Configurações | **Some**: envelopes/suprimentos → Impressão/P&P; mínimo por produto → Produtos. |
| Ver estoque / Estoque detalhado (antigos) | Aposentar (#55). |

Menu resultante: **Estoque · Pendências · Produtos · Prateleiras e caixas** (+ subgrupo P&P). 7 → 4.

## 10. Ordem de execução (quando liberar)

| # | Item | Tamanho |
|---|---|---|
| 0 | Alvo Veeqo (snapshot no boot, 60 s, selo de idade) | S |
| 1 | Catálogo (~15 produtos) | S |
| 2 | Funções por pessoa + notificação por função | M |
| 3 | Hub: não carregado, Montar dentro, Pendências em gaveta, menu 4 itens | M |
| 4 | Saída + Ajustar unificado + Desfazer + Propor→proposta | M |
| 5 | Recebimento da produção | M |
| 6 | Mutirão (físico) | L |
| 7 | Dedução ao vivo | S |

Cópia narrativa no Obsidian: "Estoque — Controle pelo admin (estudo 09-09)".

## Execução: Fase C no ar (2026-09-10, commit 262aef8)

Permissões por PESSOA (migration 089 + `src/v3/rbac/router.js`): níveis Ver / Organizar / Propor / Mudar o total / Aprovar / Receber a produção / Configurar ajustados por login na página Usuários & Acessos, por cima do perfil. Quem só propõe: entrada, saída, transferência e contagem viram proposta (`{proposed:true}`), nada muda; quem aprova é avisado por notificação com destinatário; ninguém aprova a própria (403 `self_approval`). Nenhum rótulo de manager/supervisor/gestão. Kiosk intocado; zero movimentos. Faltam D · mutirão · E · F · G.
