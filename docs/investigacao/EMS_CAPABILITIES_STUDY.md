# EMS Capabilities Study — o que dá pra automatizar/puxar do EMS

**Tipo:** pesquisa read-only (nenhum código mudou). Probes reais em prod (chave `EMS_PRODUCTION_API_KEY`) em 2026-06-19.
**Scripts usados:** `scripts/ems-capabilities-probe.js`, `scripts/ems-pipeline-deep.js` (read-only).
**Para:** Bruno decidir os próximos passos. **Não implementei nada.**

---

## 0. TL;DR (resposta rápida pro Bruno)

| Pergunta | Resposta | Evidência |
|---|---|---|
| EMS sabe **QUEM** está em cada parte? | ✅ **SIM** (operador atual por batch + por máquina) | `pipeline...yield_review[].operator = Vitor Leite`; `line.equipment[].operator` |
| EMS sabe **QUANDO começou** cada parte? | ⚠️ **NÃO de forma confiável** | batches só têm `created_at` (criação do lote, semanas atrás); só a **máquina** tem `in_use_since` — e ele **fica preso** (Tablet Machine "in_use" há 3 dias) |
| EMS sabe **duração / quando terminou**? | ❌ **NÃO** | não existe `ended_at`, `duration`, nem histórico — só snapshot do estado atual |
| EMS guarda **histórico** por stage (quem pesou, quem misturou…)? | ❌ **NÃO** | zero campos `history/stage_log/timeline`; nenhum endpoint de histórico (todos 404) |
| EMS **lista batches por stage** (o que tá pronto pra pesar/encapsular)? | ✅ **SIM** | `pipeline` agrupado por stage: `pending_queue`, `formulation.{blended,encapsulating}`, `production_line.{yield_review}` |
| Mapping operador EMS → person do tracker é confiável? | ✅ **SIM** (por `user_id` UUID; nome como fallback) | `/employees` dá `user_id` + `name` |

**Recomendação:** **Modelo B (lista por stage) como base + auto-DETECÇÃO passiva como enriquecimento** — não Modelo A puro (auto-entry cego). Justificativa na seção 6. O EMS é forte em **QUEM/O-QUE** (snapshot), fraco em **QUANDO/DURAÇÃO/HISTÓRICO** — então deixar o operador **confirmar com 1 toque** dá o melhor dos dois (detecção automática + tempo confiável).

---

## 1. Inventário completo dos endpoints

A API EMS expõe **exatamente 6 endpoints** (confirmado em `/overview.endpoints`). **Todos os 26 candidatos testados deram 404** (`/inventory`, `/orders`, `/sales`, `/quality`, `/qc`, `/machines`, `/history`, `/activity-log`, `/stock`, `/low-stock`, `/alerts`, `/demand`, `/shipments`, etc). Não há estoque, vendas, QC nem histórico via API.

| Endpoint | Topo | Conteúdo |
|---|---|---|
| `/overview` | `formulas, products, production, line, employees, endpoints` | contadores agregados |
| `/formulas` | `active[74], pending[0]` | `id, formula_code, name, formula_type, version, units_per_bottle, total_weight_mg, standard_batch_size, approved_at, products` |
| `/pipeline` | `summary, pending_queue, formulation, production_line, bottles_in_production_by_formula` | **estado da produção por stage** (ver §2) |
| `/line` | `running_count, equipment[4]` | máquinas: `id, name, equipment_type, status, running, in_use_since, current_batch, operator` |
| `/products` | `count:101, products[92 c/ imagem]` | `id, name, internal_sku, amazon_sku, amazon_asin, walmart_sku, image_url, variation_type, pack_quantity, formula` |
| `/employees` | `count:8, employees[]` | `user_id (UUID), name, avatar_url, roles[]` |

Todos os payloads têm `generated_at` (UTC) — é **snapshot ao vivo**, recomputado a cada chamada.

---

## 2. PERGUNTA 1 & 2 — rastreio por stage + lista por stage (com evidência)

### `/pipeline` é organizado POR STAGE (descoberta importante)
- `pending_queue` = **array** (fila pré-formulação). Ex.: 5 batches, `status:"pending"`, `operator:null`.
- `formulation` = **objeto** com chaves de sub-stage: `{ blended:[...], encapsulating:[...] }`.
- `production_line` = **objeto** com chaves de sub-stage: `{ yield_review:[...] }`.
- (⚠️ correção: a FASE 4 tratou `formulation`/`production_line` como arrays planas; **são objetos-de-arrays por stage**. O `/lots/available` atual pega `production_line` como array → vazio. Ver §7 Riscos/Dívida.)

Cada batch em qualquer stage:
```json
{
  "id": "8e9bd84d-...", "batch_record_number": "BR-2026-0166",
  "status": "yield_review", "target_qty_bottles": 650, "actual_yield_bottles": null,
  "queue_position": 1,
  "formula": { "formula_code": "FRM-2026-0045", "name": "Lithium Orotate 130mg 200tabs", "units_per_bottle": 200 },
  "product": { "name": "Lithium Orotate 130mg 200tabs", "image_url": "https://m.media-amazon.com/.../61-gw0ryemL.jpg" },
  "operator": { "user_id": "b2c09d34-...", "name": "Vitor Leite", "avatar_url": "..." },
  "created_at": "2026-05-26T16:08:19Z"
}
```

**Rastreio por stage:**
- **QUEM:** ✅ `operator` (com `user_id` + `name` + avatar) está presente nos batches em formulação/linha. `null` na fila pendente (ninguém pegou ainda).
- **QUANDO começou aquela parte:** ❌ **não tem.** O único timestamp é `created_at` = criação do lote (ex.: 26/mai, semanas antes). Não há "started_at do stage atual".
- **QUANDO terminou / duração:** ❌ não existe.
- **Notas / histórico:** ❌ nenhum campo.

**Único "quando" real = `/line.equipment[].in_use_since`** (por máquina, não por stage):
```
NJP1200 (capsule_machine) running=true in_use_since=2026-06-18T21:54Z operator=Bruno Sarmento batch=BR-2026-0223/encapsulating
Tablet Machine (tablet) running=true in_use_since=2026-06-16T17:27Z operator=Bruno Sarmento batch=BR-2026-0213/encapsulating  ← PRESO há ~3 dias
```
→ `in_use_since` é **não confiável pra duração** (fica preso quando esquecem de "parar" a máquina no EMS).

**Lista por stage:** ✅ **SIM.** O `/pipeline` já entrega os batches agrupados pelo stage em que estão (`pending`, `blended`, `encapsulating`, `yield_review`, …), cada um com produto+foto+operador. Isso suporta diretamente a UX "lista o que tá pronto pra pesar/encapsular".

**Snapshot vs histórico (P1.2):** só **snapshot atual**. Pra ter histórico (quem fez cada stage, duração) o **tracker precisa construir** isso por polling+diff — que é justamente o que o worker `ems-activity-sync` (FASE 2, `ems_activity_cache`) já faz a cada 45s. O EMS sozinho não dá histórico.

**Tempo real / latência (P1.3):** `/line` e `/pipeline` refletem o estado atual na hora da chamada (`generated_at`). Nosso worker captura com latência de até ~45s.

---

## 3. Mapping operador EMS → person do tracker

`/employees` (8): `Alan`, `Ana`, `Bruno Sarmento`, `Henrique Monteiro`, `Simone Mauri`, `Thassio`, `Vitor Leite`, + 1 com `name:null`. Cada um com **`user_id` UUID estável**.

- ✅ **Confiável por `user_id`** (chave imutável). Recomendado: guardar `ems_user_id` em `v3.persons` (tabelinha de mapping editável no /admin — já previsto na FASE 3).
- Por nome também funciona hoje (Vitor Leite↔Vitor, Simone Mauri↔Simone, Bruno Sarmento↔Bruno Sarmento, Ana↔Ana), mas é frágil (1 funcionário tem `name:null`; Bruno Camp/Thassio/Henrique/Alan podem divergir).

---

## 4. PERGUNTA 3 — todas as capabilities possíveis (com esforço/risco)

| # | Capability (estilo auto/lista do EMS) | Fonte EMS | Modelo | Esforço | Risco | Status |
|---|---|---|---|---|---|---|
| C1 | **Lista lote+produto por stage** (pesagem/mixing/encapsulação/revisão) no /op | `pipeline.{formulation.*, production_line.*}` | B (lista) | **Baixo** (reusa FASE 4) | Baixo | parcial: FASE 4 já fez p/ linha; falta tratar sub-stages |
| C2 | **Card "Produção EMS ao vivo"** no dashboard (quem/máquina/lote) | `line` + `pipeline` | card | **Feito** (FASE 2) | Baixo (stale in_use_since) | ✅ no ar |
| C3 | **Auto-detecção passiva**: "EMS mostra você na NJP1200 — confirmar?" no /op | `line.equipment[].operator+batch` | A+B combo | Médio | Médio (stale/operador null) | proposto |
| C4 | **Thumbnails de produto** (92 com imagem) | `products.image_url` | enriquecimento | **Feito** (Bug 3) | Baixo | ✅ no ar |
| C5 | **Detalhe de fórmula** (peso, units/bottle, tipo) na confirmação do lote | `formulas` | enriquecimento | Baixo | Baixo | possível |
| C6 | **Avatares dos operadores** em "Equipe agora" | `employees.avatar_url` | enriquecimento | Baixo | Baixo | possível |
| C7 | **Bottles em produção por fórmula** (card dashboard) | `pipeline.bottles_in_production_by_formula` | card | Baixo | Baixo | possível |
| C8 | Estoque / ordens Amazon-Walmart / QC / histórico | — | — | — | — | ❌ **EMS não expõe** (404) |

**Importante:** estoque de ingredientes, demanda de marketplace, QC e histórico **NÃO existem na API** — qualquer feature desses precisaria de OUTRA fonte (não o EMS atual).

---

## 5. PERGUNTA 4 — Modelo A (auto-entry) vs Modelo B (lista)

### Modelo A — Auto-entry (preferido pelo Bruno)
> "EMS começa a rodar → aparece automático na /op do operador, sem ele registrar."

- **Viável parcialmente.** O EMS dá **QUEM** (operator no batch/máquina) e **O-QUÊ** (batch/produto/stage) em tempo real.
- **Problemas sérios pra um auto-entry "cego":**
  1. **Sem `started_at` confiável do stage** → a task auto-criada não sabe quando realmente começou. `in_use_since` da máquina **fica preso** (Tablet Machine 3 dias) → duração fantasma gigante.
  2. **Sem `ended_at`** → o sistema só "fecha" inferindo (máquina parou / batch saiu do stage no próximo poll). Se perde um poll, perde a transição.
  3. **`operator` é `null`** em vários pontos (fila; stages sem máquina como pesagem/separação) → não dá pra atribuir → task fantasma sem dono.
  4. **Duplicação** com registro manual e com o Slack (o problema histórico das "4 entradas pra 1 ação").
- **Veredito:** auto-entry **puro** é arriscado (tasks fantasmas, duração errada, atribuição faltando).

### Modelo B — Lista de opções (estilo Linha de Produção / FASE 4)
> Operador vai iniciar pesagem → sistema lista o que tá pronto pra pesar (do EMS) → clica.

- **Totalmente viável.** O `pipeline` já lista batches por stage com produto+foto+operador.
- **Tempo confiável** (começa quando o operador confirma = `started_at` real). Sem fantasma. Fallback catálogo (REGRA #0).
- **Veredito:** robusto. É a mesma UX que a FASE 4 já entregou pra Linha; estende pros sub-stages de formulação.

### Recomendação: **Combo B + detecção passiva (C3)** — não A puro
1. **Base = Modelo B**: cada parte (pesagem/mixing/encapsulação/revisão) abre a lista dos batches naquele stage do EMS. Operador clica → task com tempo real. Fallback catálogo.
2. **Enriquecimento = auto-DETECÇÃO passiva**: quando o EMS mostra `operator == esse operador` numa máquina/stage, o /op mostra um **card sugestivo** embaixo das tarefas: *"🏭 EMS: você está na NJP1200 (BR-2026-0223, encapsulando) — registrar?"* com **1 toque pra confirmar**. Isso entrega a sensação de "entra sozinho" que o Bruno quer, **sem** os riscos do auto-entry cego: o tempo vira o do toque (não o `in_use_since` preso), e nada é criado sem confirmação (sem fantasma).
3. O `ems_activity_cache` (FASE 2) continua alimentando o **dashboard** com a visão "ao vivo" (read-only, tolera stale).

Ou seja: **o EMS decide O-QUÊ/QUEM (detecção), o operador confirma o QUANDO (1 toque)** — porque o "quando" do EMS não é confiável.

---

## 6. Riscos honestos

1. **`in_use_since` preso** (observado: Tablet Machine "in_use" há 3 dias). Qualquer duração baseada nele é lixo. → não usar pra duração de trabalho; usar tempo do toque/confirmação.
2. **`operator: null`** em fila e provavelmente em stages sem máquina (pesagem/separação) → auto-atribuição falha nesses pontos → Modelo B (operador confirma) cobre.
3. **Sem `ended_at`/histórico** → fim só por inferência (poll+diff). Risco de não fechar uma atividade se o EMS some com ela entre polls.
4. **`formulation`/`production_line` são objetos-por-stage, não arrays** → bug latente: o `/lots/available` da FASE 4 lê `production_line` como array (vazio). Hoje funciona porque cai no `pending_queue`/`formulation` errado também — **precisa de ajuste** pra ler `pl.production_line.<stage>[]`. (Dívida técnica a corrigir quando implementar.)
5. **Mapping por nome frágil** (1 employee `name:null`; nomes podem divergir) → usar `user_id` UUID.
6. **Latência ~45s** (poll do worker) → "auto" não é instantâneo; o card de detecção pode demorar até ~1min pra aparecer.
7. **EMS é só 6 endpoints, snapshot** → nada de estoque/ordens/QC/histórico; não prometer features baseadas nisso.

---

## 7. Próximos passos sugeridos (Bruno decide)

- **Rápido + alto valor:** estender a FASE 4 (Modelo B) pros sub-stages de formulação (pesagem/mixing/encapsulação) lendo `pipeline.formulation.<stage>[]` — e **corrigir** o parsing objeto-por-stage. Esforço baixo.
- **Médio:** card de **detecção passiva** (C3) embaixo das tarefas — "EMS mostra você na máquina X, confirmar?" — entrega a visão do Bruno com segurança.
- **Junto da FASE 3:** tabela de mapping `ems_user_id ↔ person` editável no /admin (robustez de atribuição).
- **Não fazer:** auto-entry cego (cria task sozinho sem confirmação) — risco de fantasma/duração errada dado o que o EMS realmente expõe.

*Fim do estudo. Nenhuma mudança de código, migration ou /op foi feita.*
