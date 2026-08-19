# S15.29 · PLANNED · Mobile admin no iPhone: inventário e impressão inteiros do celular

Bruno 2026-08-19: *"página pro admin do dashboard só pra celular, super melhorada, dá pra usar o sistema de inventário todo e impressão todo do iPhone; já prepara as coisas do backend pra ligar depois"*.

Este documento é PREPARAÇÃO. Nada aqui foi construído. O que já existe está marcado `exists`; o que falta está marcado `PLANNED` com rota, auth e payload prontos pra ligar depois. ID estável: **S15.29**.

Regras em vigor: StockService = único escritor de quantidade · sem linha nova em `src/routes/op.js` / `src/op/app.js` / `src/v3/data/router.js` · toda rota nova → ARCHITECTURE.md + mapa + process-registry no mesmo dia · PT-BR com acento, sem em dash · STYLE-KIT.

---

## (a) Como o admin do dashboard autentica hoje, e como o celular reusa isso

**Não existe sessão nem token de admin.** O que existe é um PIN enviado em toda chamada.

| Peça | Onde | O que faz |
| --- | --- | --- |
| Header `x-admin-pin` (ou `?pin=`) | `src/v3/data/auth.js:60` | única credencial aceita |
| `makeAuthMiddleware({db})` | `src/v3/data/auth.js:56` | valida na borda de `/api/v3/data/*` e de `/api/v3/warehouse/*` (`warehouse/router.js:145`) |
| `resolveLogin(db, pin)` | `src/v3/data/auth.js:16` | PIN → `v3.app_logins` JOIN `app_roles` JOIN `role_functions` → `{id, name, role, rank, functions[]}`; cache em memória de 10 s |
| Fallback de emergência | `auth.js:37` | `ADMIN_PIN` do env (default `510510`) → `functions:['*']`, pra nunca trancar o Bruno pra fora quando o banco cai |
| `hasFunction(login, 'manage_stock')` | `auth.js:45` | gate por função; `'*'` vale pra tudo |
| Guarda do PIN no cliente | `dashboard-v4/src/adapters/from-api.js:14` | `sessionStorage['v3pin']`, lido por `getPin()` e mandado no header por `warehouse-api.js:17` |

**Consequências pro celular, que precisam ser ditas antes de alguém construir:**

1. **Duração da "sessão" = a aba.** `sessionStorage` morre quando o Safari descarta a aba. No desktop isso é aceitável; no iPhone, com a aba indo pra segundo plano o tempo todo, significa redigitar o PIN o dia inteiro. **Decisão pro celular: `localStorage` com expiração própria** (carimbo `v3pin_at`, validade 12 h, apagado no logout). O backend não muda: continua sendo o mesmo header em toda chamada.
2. **Não há revogação.** Um PIN vazado vale até alguém desativar o login em `v3.app_logins`. Guardar PIN num celular é mais arriscado que num PC do armazém. **Aceito por ora** (o mesmo PIN já roda em todos os kiosks), com uma ressalva registrada: se o celular sair do prédio, `S15.30` (token de dispositivo com expiração e revogação por login) vira pré-requisito, não melhoria.
3. **O celular reusa tudo sem backend novo.** Mesmo header, mesmo RBAC, mesmo envelope `{data}` / `{error:{code,message}}`. Uma página em `/m/` é apenas outro cliente do `/api/v3/warehouse/*`.
4. **CORS não entra na conta**: a página é servida pelo mesmo host (estático em `src/m/`, como `/print` e `/scan`).

---

## (b) Endpoints que a página do celular precisa

`exists` = pronto, serve o celular como está · `needs change` = existe mas o formato ou o volume atrapalha no telefone · `missing` = não existe.

### Inventário · `/api/v3/warehouse/*` (auth `x-admin-pin`, leitura `view_stock`, escrita `manage_stock`)

| Tela usa | Rota | Estado |
| --- | --- | --- |
| Hub / visão geral | `GET /overview` | **exists** · já traz `products[]`, `kpis`, `attention[]`, `pending_summary{count, oldest_age_min}` (08-19) e por produto `sold_7d`/`sold_30d`/`days_of_stock` (08-19). **needs change no volume**: manda a linha inteira de todo produto (bins, boxes, skus). No 4G isso é o payload mais pesado do app → ver `mobile/bootstrap` em (c) |
| Ficha do produto | `GET /product/:id` | **exists** · Row + pedidos abertos + 100 movimentos + separadas + propostas. **needs change**: os 100 movimentos são scroll infinito no celular; a tela mobile deve pedir e mostrar 10 (parâmetro `?limit=` PLANNED) |
| Entrada | `POST /product/:id/entrada` | **exists** |
| Organizar | `POST /product/:id/place` | **exists** |
| Mover | `POST /product/:id/move` | **exists** |
| Ajustar | `POST /product/:id/adjust` | **exists** (motivo obrigatório) |
| Separar | `POST /product/:id/separate` | **exists** |
| Resolver separada | `POST /issues/:id/resolve` | **exists** |
| Fila de aprovação | `GET /requests?status=pending\|decided` | **exists** · já traz `age_min`, `bin_code`, `box_number`, `proposed_by` |
| Aprovar / recusar | `POST /requests/:id/approve` · `POST /requests/:id/reject` | **exists** · é a ação #1 do celular (Bruno aprova andando pelo armazém) |
| Locais | `GET /locations` · `POST /locations/bin` · `POST /locations/box` · `POST /locations/bin/:id/deactivate` | **exists** |
| Locais em lote | `POST /locations/bins/bulk` | **exists** (08-19) · cadastro de corredor inteiro; no celular é o caso raro, mas serve |
| Pesos e taras | `GET /weights` · `POST /weights/product/:id` · `POST /weights/tare` · `POST /weights/bin/:id` · `POST /weights/box/:id` | **exists** |
| Peso vira contagem | `POST /count/compute` | **exists** · só calcula, não escreve |
| Etiquetas | `GET /labels?bins=&boxes=` · `POST /locations/box/:id/label-printed` | **exists** (dados) · **needs change** pra imprimir DO celular: o iPhone não tem impressora; hoje quem desenha e imprime é o dashboard no PC → ver `print/submit` em (c) |
| Importar da Veeqo | `POST /import-veeqo` | **exists** |
| Drift | `GET /drift` | **exists** |
| Família de SKUs | `GET /family/:id` · `POST /family/:id/attach` · `POST /family/detach` · `POST /family/merge` | **exists** · tarefa de mesa, fica FORA do celular por decisão de escopo |
| Ler código com a câmera | (não existe) | **missing** pro admin. O `resolve` de hoje (`GET /api/v3/op/scan/resolve`) exige sessão de OPERADOR (`op.js:327`), não PIN de admin → ver `mobile/scan/resolve` em (c) |

### Impressão · o que existe hoje

| Peça | Onde | Estado pro celular |
| --- | --- | --- |
| Estação física de labels (.28) | `POST /api/print-event` (`op.js:414`), `POST /api/print-progress` (`:580`), `POST /api/print-watchdog` (`:557`), `POST /api/printer-status` (`:687`) · auth `X-Print-Token` | **exists** · é o PC **falando** com o tracker, não o contrário. O celular não chama nada disso |
| Quem está na estação | `POST /api/v3/op/print-login` (`op.js:260`), `POST /api/v3/op/print-heartbeat` (`:343`) · sessão do kiosk | **exists** · irrelevante pro celular |
| Página "Impressão" do dashboard | `GET /api/v3/data/printers` (`data/router.js:2060`) · PIN | **exists** · estado das impressoras, spooler ao vivo, jobs do dia, incidentes. Serve o celular como está (só leitura) |
| Fluxo ao vivo | `GET /api/v3/data/print-stream` (SSE, `data/router.js:1741`) | **exists** · SSE funciona no Safari; conexão longa em 4G cai, então a tela mobile precisa de reconexão e de um fallback de refresh |
| Página estática da estação | `/print` (`wire.js:163`) + `src/print/print.js` | **exists** · é o kiosk do .28, não uma tela de admin |
| Etiquetas de bin/caixa | `GET /api/v3/warehouse/labels` + render Code128/QR no cliente (`dashboard-v4` + `src/op/vendor/`) | **exists** · o desenho é client-side; **falta o caminho "manda pra impressora do armazém"** quando quem pede está no celular |
| Mandar imprimir a partir do celular | (não existe) | **missing** → `print/submit` em (c) |
| Etiqueta de envio (shipping label) | (não existe) | **missing por completo**. Hoje não existe rota nossa que gere/imprima shipping label; o rodapé por cor de garrafa está na Fase 2 do memory `shipping-label-footer`. **Fora do escopo do S15.29**; o celular só ganha isso quando a Fase 2 existir |

---

## (c) Adições mínimas de backend (todas PLANNED · não construir agora)

Quatro coisas. Nada além disso é necessário pra "usar o inventário todo do iPhone".

### 1. `GET /api/v3/warehouse/mobile/bootstrap` · PLANNED
Uma chamada abre o app. Hoje seriam três (`overview` + `requests` + `locations`), e a primeira delas é gorda.

- **Auth**: `x-admin-pin`, `view_stock` (a tela decide o que esconder por `manage_stock`).
- **Query**: `?full=1` traz a lista completa de produtos (senão vem só o que precisa de atenção).
- **Resposta**:
```
{data:{
  kpis, attention[], pending_summary:{count, oldest_age_min},
  products:[{product_id, nickname, total, available, days_of_stock, status[]}],  // 6 campos, não a Row inteira
  requests:[{id, kind, qty, product, proposed_by, age_min, bin_code, box_number}],  // só pending, teto 50
  locations:{bins:[{id, bin_code, product_id}], boxes:[{id, box_number, product_id}]},  // só o que preenche um seletor
  me:{name, role, functions[]},
  generated_at
}}
```
- **Implementação**: `src/v3/warehouse/mobile.js` (módulo novo), montado pelo `router.js` com o mesmo `route('get', ...)`. Reusa `stock.overview()`, `requests.list({status:'pending'})` e `locations.list()`, **sem SQL novo**, só projeção. Uma Row completa continua vindo do `/product/:id` quando o dedo abre o produto.
- **Por que não é só um `?fields=`**: o corte é diferente em três recursos ao mesmo tempo. Um endpoint com contrato próprio é mais honesto que três query strings.

### 2. `GET /api/v3/warehouse/mobile/scan/resolve?barcode=` · PLANNED
Ler o código com a câmera do iPhone e cair na ficha certa.

- **Auth**: `x-admin-pin`, `view_stock`. É a única razão da rota existir: `op-warehouse.resolveBarcode` já resolve tudo, mas a rota de hoje está atrás da sessão de operador.
- **Resposta**: idêntica à do operador: `{data:{kind:'bin'|'box'|'product'|'unknown', bin?|box?|product?, raw?}}`.
- **Implementação**: `createOpWarehouse({db}).resolveBarcode(barcode)` chamado direto do módulo `mobile.js`. **Zero lógica duplicada**; se a ordem de resolução mudar, muda nos dois de uma vez.
- **Câmera**: `BarcodeDetector` no Safari 17+, fallback pro ZXing já vendorizado em `src/scan/vendor/zxing.min.js`. Digitar à mão sempre disponível (REGRA #0).

### 3. `POST /api/v3/warehouse/mobile/print/submit` · PLANNED
"Imprime a etiqueta desta caixa" apertado no celular, papel saindo no armazém.

- **Auth**: `x-admin-pin`, `manage_stock`.
- **Payload**: `{kind:'bin'|'box', ids:[int], printer?:'labels-28'}`.
- **Resposta**: `{data:{queued:int, job_id, labels:[...]}}` (os mesmos `labels[]` do `GET /labels`, pra tela poder mostrar o que foi mandado).
- **Como imprime de verdade**: o iPhone não fala com a impressora. O caminho é uma FILA que o PC .28 puxa, no mesmo desenho do `print-event` (o .28 sempre foi quem inicia a conversa):
  - tabela `v3.print_queue` (migration PLANNED): `id, kind, payload jsonb, requested_by_person_id, status 'queued'|'taken'|'done'|'error', created_at, taken_at, done_at, error_note`;
  - `GET /api/print-queue` + `POST /api/print-queue/:id/done`, ambos com `X-Print-Token` (o mesmo segredo do `print-event`, mesma borda, nenhum conceito de auth novo);
  - o agente do .28 faz poll a cada poucos segundos, desenha o Code128/QR e imprime.
- **Decisão explícita**: a fila é a única forma sem abrir porta de entrada no PC do armazém. Qualquer coisa que exija o servidor ALCANÇAR o .28 (SSH, agente escutando) é rede nova pra manter e um caminho novo pra quebrar.
- **Carimbo**: ao concluir um `kind:'box'`, o `POST /locations/box/:id/label-printed` que já existe é chamado pelo handler do `done`.

### 4. `GET /api/v3/warehouse/mobile/printers` · PLANNED (opcional)
Recorte de bolso do `GET /api/v3/data/printers`: por impressora, `{printer, status_label, error_label, jobs_today, incident?}`. Só existe pra evitar baixar a página inteira de impressão no 4G. Se `bootstrap` já estiver enxuto, esta pode nascer depois.

**Nada disso escreve quantidade.** `bootstrap`, `scan/resolve` e `printers` são leitura; `print/submit` escreve fila de impressão. Toda mudança de estoque do celular continua passando pelas rotas que já existem, que passam pelo StockService.

---

## (d) IA da página e ponto de montagem

**Montagem reservada**: `/m/` estático (`src/m/index.html` + `src/m/m.js`), montado no `wire.js` ao lado de `/print` e `/scan`. Mesma escolha do `/scan`: página de celular não precisa de build, e um bundle React de dashboard num 4G do armazém é um começo lento a cada vez. **Não** é uma rota `#m` do dashboard-v4, porque o app inteiro viria junto no download.

Seis telas, uma tarefa cada:

| # | Tela | O que faz | Chama |
| --- | --- | --- | --- |
| 1 | **Entrar** | PIN, 12 h em `localStorage`, nome e cargo na tela | qualquer GET (o 401 é a validação) |
| 2 | **Hoje** | Fila pendente no topo com a idade da mais velha, depois "precisa de atenção", depois os KPIs. É a home porque é o que faz Bruno pegar o celular | `mobile/bootstrap` |
| 3 | **Aprovar** | Cartão por proposta: quem, o quê, quanto, onde, há quanto tempo, o `meta` da pesagem quando existe. Dois botões grandes | `requests/:id/approve` · `.../reject` |
| 4 | **Produto** | Busca ou câmera → ficha: números, prateleiras e caixas, últimos 10 movimentos; ações Entrada · Organizar · Mover · Ajustar · Separar em modal de 2 passos (confirmação explícita: um toque errado no bolso não pode mexer no estoque) | `product/:id` · `mobile/scan/resolve` · os POSTs que já existem |
| 5 | **Ler código** | Câmera de tela cheia → resolve → cai na tela 4 (produto), no bin ou na caixa. Digitar sempre disponível | `mobile/scan/resolve` |
| 6 | **Imprimir** | Escolhe bin ou caixa, vê a prévia da etiqueta, manda pra fila; estado das impressoras embaixo | `labels` · `mobile/print/submit` · `mobile/printers` |

Fora do celular por decisão: família de SKUs, cadastro de locais em lote, importar da Veeqo, calibração de peso. São tarefas de mesa; enfiá-las aqui só engordaria o app.

STYLE-KIT direto: fundo dot-grid, títulos DM Serif Display com uma palavra em itálico verde, micro-rótulos DM Mono, cartões de 18 px, botões pílula navy, chips tonais. Alvos de toque de 44 px, tudo com uma mão, sem hover em lugar nenhum.

---

## Ordem de construção quando o Bruno mandar

1. `src/m/` com as telas 1-3 contra o backend de HOJE (`overview` + `requests` já bastam pra aprovar do celular). Isso já entrega a ação mais usada, sem uma linha de backend nova.
2. `mobile/bootstrap` + `mobile/scan/resolve` (módulo `src/v3/warehouse/mobile.js`, testes em `src/__tests__/warehouse-mobile.test.js`) → telas 4 e 5.
3. `v3.print_queue` + `print/submit` + agente do .28 → tela 6.

Cada passo: ARCHITECTURE.md + mapa (`S15.29`) + process-registry (se nascer um poller) no mesmo dia.
