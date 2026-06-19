# 📨 Catálogo de mensagens/sugestões possíveis a partir do EMS

> **Status:** LISTA pra aprovação. **Nada aqui é implementado** além do que já
> está no ar (marcado ✅ IMPLEMENTADO). Bruno lê, aprova quais quer, e numa
> próxima passada o Claude Code implementa as aprovadas.
>
> **Base de dados real** (probe `scripts/ems-line-probe.js`, 19/jun, prod):
> - **/line** → 4 equipamentos: `capsule_machine` (NJP1200), `tablet_machine`
>   (Tablet Machine), `blender` (V-Blender), `scale` (Scale #01).
> - **/pipeline** → `pending_queue` (5 lotes, **operator null**); `formulation`
>   = `{blended, encapsulating}` (**todos com operator**); `production_line` =
>   `{yield_review}` (**todos com operator**); `bottles_in_production_by_formula` presente.
> - Quirk confirmado: `Tablet Machine` com `in_use_since` de **3 dias atrás**
>   (preso) — por isso tempo NUNCA sai do `in_use_since`.

---

## 0. Mapeamento máquina → nome amigável (PT) — ✅ IMPLEMENTADO (aprovar nomes)

| EMS `equipment_type` | EMS `name` | Nome amigável (mostrado ao operador) |
|---|---|---|
| `capsule_machine` | NJP1200 | **máquina de cápsula** |
| `tablet_machine` | Tablet Machine | **máquina de tablete** |
| `blender` | V-Blender | **misturador** |
| `scale` | Scale #01 | **balança** |

> Fallback (tipo desconhecido): usa o `name` cru, ou "máquina". **Bruno: confirma
> esses 4 nomes ou ajusta** (ex.: "misturador" vs "máquina de mistura").

---

## 1. Princípios de segurança (do estudo EMS)

| Dado | Confiável? | Uso |
|---|---|---|
| **QUEM** (operator no batch/máquina) | ✅ sim | base da detecção |
| **O-QUÊ** (batch, produto, stage, fórmula) | ✅ sim | texto da mensagem |
| **lista por stage** (o que está em cada etapa) | ✅ sim | lista + sugestão |
| **QUANDO / duração** (`in_use_since`, sem histórico) | ❌ não (preso) | NUNCA usar p/ tempo |
| **término** (batch saiu do stage) | ⚠️ poll+diff | só sugerir, nunca auto-fechar |

**Regra de ouro:** tempo = SEMPRE o toque do operador (ou hora que ele escolher).
Toda detecção é **sugestão de 1 toque**, nunca cria/fecha nada sozinho (REGRA #0).
Linguagem: **"O sistema detectou"** — nunca "EMS", "Carolina", nem modelo técnico.

---

## 2. Catálogo completo

### C1 — Você está numa MÁQUINA  ✅ IMPLEMENTADO (texto novo)
- **Gatilho:** `/line` equipamento `running=true` + `operator == você` + `in_use_since < 24h` (não-preso) + sem task aberta pro mesmo lote.
- **Texto:** *"🏭 O sistema detectou — Você está na **máquina de cápsula**, fazendo **Glutathione**, lote **BR-2026-0223**."* → **[ Registrar ]** → "Quando começou? Agora / Marcar outra hora".
- **Certeza:** QUEM+O-QUÊ ✅. Tempo vem do toque, não do `in_use_since`.
- **Segurança:** ✅ **SEGURO**. (Já no ar.)

### C2 — Você está num STAGE sem máquina (pesando/misturando/encapsulando/revisando)
- **Gatilho:** `/pipeline` `formulation.{blended,encapsulating}` ou `production_line.{yield_review}` com `operator == você`. **Probe confirmou: 4/4 e 8/8 batches TÊM operator** — então é detectável mesmo sem máquina.
- **Texto:** *"🏭 O sistema detectou — Você está **encapsulando** (ou **misturando** / **revisando**) **Folic Acid 400mcg**, lote **BR-2026-0213**."* → **[ Registrar ]** + "Quando começou?".
- **Certeza:** operator presente ✅. Mapa stage→verbo: weighing→pesando, blended/blending→misturando, encapsulating→encapsulando, yield_review→revisando.
- **Segurança:** ✅ **SEGURO** p/ stages COM operator. ⚠️ `pending_queue` tem `operator=null` → **não** entra aqui (ninguém pra atribuir).
- **Esforço:** baixo (relaxar o filtro `machine IS NOT NULL` do card atual pra aceitar stage+operator; o `ems_activity_cache` já guarda esses via worker).

### C3 — Sugestão de "próximo" (fila esperando)
- **Gatilho:** `/pipeline` `pending_queue` (probe: 5 lotes, **operator null**).
- **Texto:** *"Tem **5 lotes** esperando pra entrar em produção. Quer começar um?"* → abre a lista.
- **Certeza:** a fila existe ✅. Mas **não sabe se VOCÊ vai pegar** (sem operator).
- **Segurança:** ⚠️ **ARRISCADO (ruído).** Apareceria igual pra todo mundo. **Recomendação:** NÃO virar card proativo — já existe a **lista opcional** (`/lots/available`, FASE FORM) que cobre isso sob demanda. Talvez um contador discreto na tela de iniciar tarefa ("5 na fila"), sem push.

### C4 — Confirmar término (batch saiu do stage)
- **Gatilho:** um batch que você estava fazendo **some** do stage no poll seguinte (`ems_activity_cache.sync_status` vira `completed`).
- **Texto:** *"O sistema viu que **Glutathione** lote **BR-2026-0223** saiu da **encapsulação**. Você terminou essa tarefa?"* → **[ Sim, finalizar ]** / [ Ainda não ].
- **Certeza:** o batch mudou ⚠️ — mas pode ser **troca de operador**, reclassificação, ou glitch do poll (45s), não término real.
- **Segurança:** ⚠️ **ARRISCADO (poll/diff).** Só como **sugestão de finalizar** (1 toque confirma), **nunca** auto-fecha (respeita o guard da FASE 1: Slack/EMS não fecham task do /op). Se implementar, exige contagem normal no fim (não pula bottles).

### C5 — Lote desconhecido / divergência  ✅ IMPLEMENTADO (via auto-create)
- **Gatilho:** operador registra um lote que não existe no tracker/EMS.
- **Hoje:** auto-cria o lote (REGRA #0) + **avisa o admin** no Slack (lote desconhecido). Não bloqueia.
- **Texto alternativo (se quiser confirmação explícita):** *"O sistema não encontrou o lote **{X}** no EMS. Confirmar mesmo assim?"* — **não recomendado** (adiciona fricção; o auto-create+aviso já cobre).
- **Segurança:** ✅ **SEGURO** (comportamento atual).

### C6 — Detalhe da fórmula no CONFIRM  (= FASE CAP C5, ainda não feito)
- **Gatilho:** ao confirmar um lote (linha/formulação), ler do EMS `formula_code`/peso/`units_per_bottle`/tipo.
- **Texto:** *"Fórmula **FRM-2026-0060** · Plant Sterols 2000mg · cápsula"* (read-only, informativo).
- **Segurança:** ✅ **SEGURO** (dado estático da fórmula).

### C7 — Bottles em produção por fórmula  (= FASE CAP C7, dashboard)
- **Gatilho:** `/pipeline.bottles_in_production_by_formula` (probe traz: Plant Sterols 1500 / 2 lotes, Chromium 1000…).
- **Texto (dashboard, não operador):** *"Plant Sterols 2000mg — **1.500 bottles** em produção (2 lotes)."*
- **Segurança:** ✅ **SEGURO** (número direto do EMS).

### C8 — Avatares dos operadores em "Equipe agora"  (= FASE CAP C6)
- **Gatilho:** `/employees.avatar_url`.
- **Uso:** enriquecimento visual (não é mensagem). Fallback iniciais.
- **Segurança:** ✅ **SEGURO**.

### C9 — Máquina aparece presa (>24h em uso)  — SÓ ADMIN
- **Gatilho:** `/line` `running=true` com `in_use_since` muito antigo (Tablet Machine = 3 dias).
- **Texto (painel admin, NUNCA pro operador):** *"A máquina de tablete aparece em uso desde **16/jun** (>24h) — pode estar travada no EMS."*
- **Segurança:** ⚠️ **ARRISCADO** se mostrado ao operador (diria "você está há 3 dias"). Útil só como **alerta de saúde do EMS** pro admin. O card do operador (C1) já **filtra** esses (>24h não aparecem).

### C10 — Divergência de contagem (informado × EMS)
- **Gatilho:** operador informa X bottles no fim, EMS `actual_yield_bottles = Y` diferente.
- **Texto:** *"Você informou **{X}** bottles, mas o EMS mostra **{Y}** pro lote {batch}. Qual está certo?"*
- **Certeza:** ⚠️ `actual_yield_bottles` vem **null** na maioria dos batches (probe). Sem o dado, não dá pra comparar.
- **Segurança:** ⚠️ **ARRISCADO** hoje (dado quase sempre ausente). Reavaliar se o EMS começar a preencher yield.

### C11 — Colega no mesmo lote (cowork sugerido)
- **Gatilho:** EMS mostra **outro** operador no mesmo batch/máquina que você.
- **Texto:** *"{colega} está no mesmo lote {batch}. Trabalhando juntos?"*
- **Certeza:** ⚠️ o EMS expõe **1 operator por batch/máquina** — não dá multi-operador confiável.
- **Segurança:** ⚠️ **ARRISCADO** (dado insuficiente). O cowork do tracker (JOIN) já cobre isso melhor manualmente.

---

## 3. Resumo de recomendação

| # | Cenário | Segurança | Recomendação |
|---|---|---|---|
| C1 | Detecção em máquina | ✅ | **No ar.** |
| C2 | Detecção por stage (sem máquina) | ✅ | **Vale implementar** (baixo esforço, alto valor — operator existe nos stages). |
| C3 | Sugestão de fila | ⚠️ ruído | Não como push; contador discreto no máximo. |
| C4 | Confirmar término | ⚠️ poll/diff | Só como sugestão de finalizar (1 toque), nunca auto-fecha. |
| C5 | Lote desconhecido | ✅ | **No ar** (auto-create + aviso admin). |
| C6 | Fórmula no confirm | ✅ | FASE CAP C5 — seguro. |
| C7 | Bottles por fórmula | ✅ | FASE CAP C7 — seguro (dashboard). |
| C8 | Avatares | ✅ | FASE CAP C6 — seguro. |
| C9 | Máquina presa >24h | ⚠️ | Só painel admin (saúde do EMS), nunca operador. |
| C10 | Divergência de contagem | ⚠️ dado ausente | Esperar EMS preencher yield. |
| C11 | Colega no mesmo lote | ⚠️ dado insuf. | Cowork manual já cobre. |

**Sugestão de prioridade pra próxima passada:** C2 (stage sem máquina) + C6/C7/C8
(FASE CAP, todos ✅ seguros). C4 só se Bruno quiser, com muito cuidado (sugestão,
nunca fecha sozinho). C3/C9/C10/C11 ficam de fora ou viram ferramenta de admin.
