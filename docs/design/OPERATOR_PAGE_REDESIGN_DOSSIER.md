# Operator Page (/op/) — Dossiê Completo para Redesign

> **Para:** instância Claude focada em design (sem acesso ao repositório).
> **De:** Claude Code (implementador), a pedido do Bruno (owner HealthFare).
> **Data:** 15 jun 2026 · **Estado documentado:** produção, commit `c69ae51` (SW `hf-op-v3`).
> **Princípio deste doc:** descreve o que **existe hoje**, não o ideal. Auto-contido.

Screenshots reais (produção, viewport 420×900, Vitor) em [`screenshots/`](screenshots/):
`01-login` · `02-home` · `03-grupos` · `04-tasks-limpeza` · `05-confirma` · `06-confirma-picker` · `07-almoco-confirma` · `08-clockout`.

### ⚠️ Correções de premissa (vs o brief original)
- A fila offline usa **localStorage**, NÃO IndexedDB.
- Há **36** task types ativos (não 32).
- A máquina de estados real tem **8 estados** (não os ~13 idealizados); quantidade, voz, retroactive e forgotten-cascade são **inline/overlay**, não estados formais.
- Stack: **vanilla JS** (sem framework, sem build) — `app.js` é um IIFE único + uma máquina de estados pura (UMD) + autocomplete local. Zero dependência de runtime no front.

---

# SEÇÃO 1 — VISÃO GERAL DO PRODUTO

## 1.1 O que é a /op/
Página **touch-first** para operadores de uma fábrica de suplementos (HealthFare, Fort Lauderdale/FL). Substitui o input antigo via Slack: o operador registra **o que está fazendo, em que lote, com quem, e por quanto tempo** — gerando `events` estruturados no Postgres (schema `v3`), sem LLM no caminho.

- **64 supplements** no catálogo (autocomplete local, zero API), **36 task types**, **4 operadores**.
- **PWA** (instalável, service worker, fila offline em localStorage).
- Servida em `…/op/`. Usada em **tablet/celular na fábrica**; admins acessam pelo PC.
- Backend: Node/Express + Postgres (Railway). Auth por **PIN de 4 dígitos** → sessão (token em memória + header `X-Session-Token`).

## 1.2 Personas (4 operadores)
| Operador | PIN | Perfil | Tasks típicas | Slack próprio? |
|---|---|---|---|---|
| **Vitor** | •••• | Principal, mais letrado | linha de produção, formulação, encapsulação, limpeza, FNSKU. Também posta em nome do Bruno Sarmento (sufixo `_Bruno`) | sim |
| **Simone** | •••• | Packaging/Orders | impressão de ordens, 2ª impressão, etiquetagem, label change | sim |
| **Ana** | •••• | Suporte | conserto de label, ordens, limpeza | **não** (usava conta "Production Line" compartilhada) |
| **Bruno Sarmento** | •••• | Especial — **isento de bottle count** | formulação, máquina de cápsulas/tablets, material handling | **não** |

> ⚠️ **PINs redigidos de propósito.** São credenciais reais (4 dígitos por operador) e este doc vai pro repositório — não colocamos os valores aqui. Pro redesign basta saber que o login é um PIN numérico de 4 dígitos por operador; Bruno tem os valores fora do repo.

## 1.3 Contexto de uso real (restrições de campo)
- Tablets/celulares **pessoais**, possivelmente molhados/sujos; mãos com **luva**.
- Iluminação variável (perto de janela vs interior) → **alto contraste obrigatório**.
- Turnos de **9–10h**; o mesmo device pode passar de mão em mão (botão "Trocar").
- Idioma: **pt-BR** primário (es/en ocasional só na voz).
- Internet **oscila** → fila offline + network-first.
- Operadores com **pouca leitura** → ícone + pouca palavra, sem jargão.

---

# SEÇÃO 2 — MÁQUINA DE ESTADOS (real)

Definida em `src/op/state-machine.js` (módulo **puro**, UMD, testado isolado). `transition(state, event, ctx, payload) → { state, draft }`, sem efeitos colaterais. O `app.js` chama `dispatch()` e re-renderiza.

`draft = { group, type, supplement, batch, cowork[], note }`

| Estado | Tela | Renderizado por | Eventos → próximo estado |
|---|---|---|---|
| `LOGGED_OUT` | Teclado PIN | `renderPin`/`buildKeypad` | `LOGIN_OK`→`IDLE` |
| `IDLE` | Home: minhas tasks + tasks da equipe + "Iniciar Tarefa" + Nota/Voz | `renderIdle` | `START_NEW`→`PICK_GROUP` · `OPEN_CLOCK_OUT`→`CLOCK_OUT` |
| `PICK_GROUP` | **Modal**: 6 grupos + quick-actions | `renderPickGroup` | `PICK_GROUP`→`PICK_TYPE` · `BACK`→`IDLE` |
| `PICK_TYPE` | **Modal**: tasks do grupo | `renderPickType` | `PICK_TYPE`→(`PICK_SUPPLEMENT` se `requires_product`, senão `CONFIRM`) · `BACK`→`PICK_GROUP` |
| `PICK_SUPPLEMENT` | **Modal**: autocomplete supplement | `renderPickSupplement` | `PICK_SUPPLEMENT`→`PICK_BATCH` · `BACK`→`PICK_TYPE` |
| `PICK_BATCH` | **Modal**: lote 4 dígitos + recentes | `renderPickBatch` | `PICK_BATCH`/`SKIP_BATCH`→`CONFIRM` · `BACK`→`PICK_SUPPLEMENT` |
| `CONFIRM` | **Modal "Confirma?"** (a tela central — ver §3.7) | `renderConfirm` | `CONFIRM_OK`→`IDLE` · `BACK`→`PICK_BATCH`/`PICK_TYPE` |
| `CLOCK_OUT` | **Modal**: bottle counts pendentes (regra P5) | `renderClockOut` | `CLOCK_OUT_DONE`→`LOGGED_OUT` · `BACK`→`IDLE` |

**Globais (qualquer estado):** `AUTO_TIMEOUT`/`LOGOUT`→`LOGGED_OUT`; `CANCEL`→`IDLE`.

**O que NÃO é estado formal (é inline/overlay dentro de uma tela):**
- **Quantidade** (`order_printing`/`order_printing_2`): input dentro de `CONFIRM`.
- **Retroactive** ("⏰ Quando começou?" + picker + "Já terminou?"): tudo dentro de `CONFIRM` (variáveis locais, sem estado).
- **Voz**: modal/linha dentro de `CONFIRM` e da tela de finalização.
- **Finalizar task** (`finishTask`): modal disparado a partir do card em `IDLE` (não é um estado; a task "rodando" vive na lista "Minhas tarefas" do `IDLE`).
- **Forgotten-checkout cascade**: **overlay** (`.fc-overlay`) disparado após `LOGIN_OK`, fora da máquina.

**Transições — validação e API (resumo; contrato completo em §8):**
- `LOGIN_OK`: `POST /api/v3/op/auth/login {pin}` → `{session_token, person, auto_logoff_seconds, forgotten_check_prompts[]}`. Erro `invalid_pin`→401, `too_many_attempts`→429 (5/min/IP).
- `CONFIRM_OK` (start agora): `POST /api/v3/op/event/start`. (retroativo): `POST /api/v3/op/event/retroactive`. Valida nota/quantidade no cliente e no servidor.
- `CLOCK_OUT_DONE`: `POST /api/v3/op/clock-out` (regra P5: último operador não-isento não pode sair com contagem em aberto sem marcar "Não sei").

---

# SEÇÃO 3 — INVENTÁRIO DE TELAS / COMPONENTES

> Header (visível logado, `#hdr`): `👤 <nome>` · `⏱ <timer auto-logoff>` · `● <conn>` · `📱 Instalar` (se disponível) · `Sair (fim do dia)` (warn) · `Trocar`. **Pain point observado:** em viewport estreito o header **quebra/corta** ("Sair (fim de", "Instalar" cortado) — ver `05-confirma.png`.

### 3.1 PIN entry (`LOGGED_OUT`) — `01-login.png`
Título "HealthFare / Linha de Produção", `pin-dots` (· · · ·, vira ●), `pin-error`, **keypad 3×4** (1-9, ⌫, 0, ✓). Botões `min-height:76px, font 30px`. Auto-submit ao 4º dígito.

### 3.2 Home (`IDLE`) — `02-home.png`
`➕ Iniciar Tarefa` (verde, grande) · `h2 "📋 Minhas tarefas"` (cards de tasks ativas do operador, com `✔ Finalizar`) · `h2 "👥 Tasks da equipe agora"` (cards de outros operadores com `🤝 Entrar` = cowork-B) · `📝 Nota / 🎤 Voz`.

### 3.3 Grupos (`PICK_GROUP`, modal) — `03-grupos.png`
Grid 2-col `grid2`: 6 grupos (🏭 Linha · 🧪 Formulação · 🧹 Limpeza/Suporte · 📦 Embalagem/Ordens · 🚚 Envio · ⋯ Outros) + quick-action 🍽️ Almoço (verde, pula direto pra `CONFIRM`). Footer: `✕ Cancelar`.

### 3.4 Tasks do grupo (`PICK_TYPE`, modal) — `04-tasks-limpeza.png`
Grid 2-col de botões `btn-big` (um por task). O "✏️ Outro (…)" de cada grupo usa `.btn-outro` (âmbar claro). Footer: `← Voltar` · `✕ Cancelar`.

### 3.5 Supplement (`PICK_SUPPLEMENT`, modal)
Input texto + `list-pick` (autocomplete local, substring normalizada + ranking por uso recente — `searchSupplements`, top 20). Sem chamada de API.

### 3.6 Lote (`PICK_BATCH`, modal)
Input `tel` 4 dígitos (`"0190"` → resolve `BR-2026-0190`). Recentes destacados (`DATA.recent_batches`, últimos 40). Pode pular (`SKIP_BATCH`).

### 3.7 ⭐ CONFIRM — "Confirma?" (modal) — `05-confirma.png`, `06-confirma-picker.png`, `07-almoco-confirma.png`
**A tela central.** Ordem (de cima pra baixo):
1. **Card da task** (`card mine`, borda verde): ícone + nome (ex.: 🧹 Limpeza).
2. **⏰ Quando começou?** — dois botões `grid2`: **`▶️ Agora`** (default, verde) | **`🕐 Esqueci de marcar`**. Ao escolher "Esqueci": aparece **picker inline** (`06-confirma-picker.png`): `[hora 1-12 ▼] [min :00..:55 ▼] [AM/PM toggle]` + status ao vivo (`✅ 11:30 AM` verde / `⛔ Não pode ser no futuro` vermelho). Válido → o botão muda para **"▶ COMEÇAR ÀS 11:30AM"**.
3. **👥 Tem alguém junto?** — checkboxes `chk` por operador (cowork-A; 🟢 online / ⚪ offline / "em <task>").
4. **🔢 Quantas ordens vai imprimir?** — só `order_printing`/`order_printing_2` (input numérico, obrigatório 1-9999).
5. **📝 Nota** (opcional ou **OBRIGATÓRIO**) — textarea + **🎤** (voz) + dropdown idioma (Português/Español/English).
6. **Footer:** `← Voltar` · `✕ Cancelar` · **`▶ COMEÇAR`** (verde).
**Após COMEÇAR com horário custom:** modal **"Já terminou?"** → `[Sim — escolher hora de fim]` (outro picker) | `[Não — ainda fazendo]` → grava.

### 3.8 Task rodando
Não é tela: o card aparece em "Minhas tarefas" no `IDLE` com `✔ Finalizar`.

### 3.9 Finalizar (`finishTask`, modal)
Se slug é `production_line`/`encapsulation`: input "Quantos bottles?" (opcional). Textarea nota final + 🎤. `✔ Finalizar` (vermelho).

### 3.10 Voz (modal/linha `voice-row`)
Botão `.mic` (76×58). Gravando: `.mic.rec` vermelho pulsante + cronômetro. Web Speech (transcrição ao vivo) + MediaRecorder (áudio). Auto-stop 60s. Preview + **Salvar/Descartar**. Salvar → `POST /voice/upload` (base64) → transcrição preenche a nota.

### 3.11 Clock-out (`CLOCK_OUT`, modal) — `08-clockout.png`
Lista produções do dia sem contagem (`missing-row`). Por linha: input bottles ou checkbox "Não sei". Regra **P5**: o **último** operador não-isento **não pode** sair com buraco sem marcar "Não sei". Bruno Sarmento (`count_exempt`) e não-últimos podem pular.

### 3.12 Forgotten-checkout cascade (overlay `.fc-overlay`)
Após login, se um colega passou do `expected_end_time` e está ocioso >15min: card "Fulano ainda está trabalhando?" `[✅ Sim]` / `[❌ Não, fazer checkout dela]`.

---

# SEÇÃO 4 — DESIGN TOKENS (do `style.css` atual)

**Cores**
| Token | Hex | Uso |
|---|---|---|
| Fundo app | `#f2f5f7` | body |
| Texto principal | `#14323f` | corpo + header bg |
| Verde primário | `#0e7a4e` | COMEÇAR/Finalizar/ações positivas, theme-color |
| Vermelho | `#b3261e` | destrutivo, gravação, erro |
| Âmbar/warn | `#b35c00` | "Sair fim do dia" |
| Âmbar catch-all | `#fff7e6` bg / `#d99100` borda / `#8a5a00` texto | botões "Outro" (`.btn-outro`) |
| Azul-escuro neutro | `#2c505f` | botões pequenos, h2 |
| Borda padrão | `#c8d6dc` | inputs, cards, botões |
| Texto secundário | `#4b6a77` | `.sub`, `.muted` |

**Tipografia:** system stack (`-apple-system, "Segoe UI", Roboto, Arial`). Base `19px`; h1 `34px`; h2 `20px`; `.btn-big` `23px`; keypad `30px`; pin-dots `48px`.

**Touch targets:** `.btn-big` ≥68px (grid2 ≥86px), keypad 76px, inputs ≥58px, `.btn-sm` ≥44px, checkbox 30px. **Padrão: alvos ≥44px, na prática ≥60px.**

**Raio:** botões 14px · keypad/cards 16px · modal 18px (top) · inputs 12px. **Sombra:** `.btn-big` `0 2px 4px rgba(0,0,0,.06)`. **Animações:** `:active` `scale(.985)`; `@keyframes pulse` (mic gravando). **Modal:** sobe de baixo (`align-items:flex-end`, raio só no topo) — padrão bottom-sheet. **Sem breakpoints** (mobile-first, `max-width:720px` central). CSS completo em §13.2.

---

# SEÇÃO 5 — REGRAS POR TASK TYPE (36 ativos)

`requires_product=batch` → exige supplement+lote. `nota`: ✅=obrigatória. `qtd`: order count obrigatório. `bg`=is_background (roda em paralelo). Cowork: permitido em **todos**. `grupo` vem do array `GROUPS` (UI, por slug) — **não** da coluna `category`.

| slug | nome | grupo UI | category | flow | batch | nota | qtd | bg |
|---|---|---|---|---|---|---|---|---|
| production_line | Linha de Produção | Linha | production_phase | production | ✅ | – | – | – |
| review | Revisão | Linha | production_phase | production | ✅ | – | – | – |
| counting | Contagem | Linha | production_phase | production | ✅ | – | – | – |
| line_changeover | Troca de Linha (Setup) | Linha | production_phase | production | – | – | – | – |
| production_line_other | ✏️ Outro (Linha) | Linha | support | support | – | ✅ | – | – |
| formulation | Formulação | Formulação | production_phase | production | ✅ | – | – | ✅ |
| mixing | Mistura | Formulação | production_phase | production | ✅ | – | – | ✅ |
| encapsulation | Cápsulas / Tablets | Formulação | production_phase | production | ✅ | – | – | ✅ |
| material_handling | Preparo de material | Formulação | support | support | – | – | – | – |
| formulation_other | ✏️ Outro (Formulação) | Formulação | support | support | – | ✅ | – | – |
| cleaning | Limpeza | Limpeza/Suporte | support | support | – | – | – | – |
| repair | Conserto de máquina | Limpeza/Suporte | support | support | – | – | – | – |
| facility_maintenance | Manutenção | Limpeza/Suporte | support | support | – | – | – | – |
| organization | Organização | Limpeza/Suporte | support | support | – | – | – | – |
| machine_downtime | Máquina parada | Limpeza/Suporte | support | support | – | – | – | – |
| label_change | 🏷️ Troca de label | Limpeza/Suporte | support | support | – | ✅ | – | – |
| label_repair | 🔧 Conserto de label | Limpeza/Suporte | support | support | – | ✅ | – | – |
| cleaning_other | ✏️ Outro (Limpeza/Suporte) | Limpeza/Suporte | support | support | – | ✅ | – | – |
| orders | Ordens (P&P) | Embalagem | pnp_phase | pnp | – | – | – | – |
| order_printing | Impressão de Ordens | Embalagem | pnp_phase | pnp | – | ✅ | ✅ | – |
| order_printing_2 | 2ª Impressão de Ordens | Embalagem | pnp_phase | pnp | – | ✅ | ✅ | – |
| labeling | Colar labels | Embalagem | pnp_phase | pnp | ✅ | – | – | – |
| packaging | Empacotamento | Embalagem | pnp_phase | pnp | ✅ | – | – | – |
| marketplace_prep | Trocar label / marketplace (FNSKU) | Embalagem | production_phase | production | ✅ | – | – | – |
| packaging_other | ✏️ Outro (Embalagem) | Embalagem | support | support | – | ✅ | – | – |
| shipping | Envio (cliente) | Envio | pnp_phase | pnp | ✅ | – | – | – |
| dc_shipment | Envio DC (FBA/WFS) | Envio | production_phase | production | – | – | – | – |
| clinic_shipment | Envio Clínica | Envio | support | support | – | – | – | – |
| box_closing | Fechar caixas | Envio | pnp_phase | pnp | – | – | – | – |
| shipping_other | ✏️ Outro (Envio) | Envio | support | support | – | ✅ | – | – |
| special_task | ✨ Algo Especial | Outros | support | support | – | ✅ | – | – |
| break | Pausa | Outros | meta | support | – | ✅ | – | – |
| meeting | Reunião | Outros | support | support | – | ✅ | – | – |
| training | Treinamento | Outros | support | support | – | ✅ | – | – |
| lunch | Almoço | (quick-action) | meta | support | – | – | – | – |
| end_of_day | Fim de Expediente | (sistema) | meta | support | – | – | – | – |

**`NOTE_REQUIRED` (13):** break, order_printing, order_printing_2, special_task, meeting, training, production_line_other, formulation_other, cleaning_other, packaging_other, shipping_other, label_change, label_repair.
**`ORDERS_REQUIRED` (2):** order_printing, order_printing_2.
**GROUPS / QUICK:** array completo em §13.7.

---

# SEÇÃO 6 — USER JOURNEYS

**6.1 Início do dia (Vitor 8h):** liga máquinas → login PIN → `Iniciar Tarefa` → grupo → task → CONFIRM ("Agora") → COMEÇAR.
**6.2 Almoço:** quick-action 🍽️ Almoço → CONFIRM (sem cowork, sem nota) → COMEÇAR → volta, card em "Minhas tarefas" → ✔ Finalizar.
**6.3 Produção em batch:** Linha → production_line → supplement → lote (ou novo) → cowork → nota → COMEÇAR → trabalha → ✔ Finalizar → bottle count → confirma.
**6.4 Esqueci de marcar (caso Ana):** login → task normal → em CONFIRM toggle `🕐 Esqueci de marcar` → picker 11:30 AM → "▶ COMEÇAR ÀS 11:30AM" → "Já terminou?" (Sim→hora fim / Não) → grava. **Só hoje**; dias anteriores = admin (via `/admin/`).
**6.5 Cowork (Vitor+Ana):** Vitor inicia com Ana marcada → 1 event + cowork_with → Ana vê em "Tasks da equipe" → 🤝 Entrar.
**6.6 Voz:** 🎤 → permissão mic → cronômetro + transcript → stop/60s → preview → Salvar → upload → transcrição vira nota.
**6.7 Forgotten cascade:** A faz logout → sistema detecta B atrasado+ocioso → overlay "B ainda trabalha?" → Não → B deslogado, admin alertado no #admin-orin, Carolina DM no dia seguinte.
**6.8 Clock-out P5:** "Sair (fim do dia)" → lista produções → contagens / "Não sei" → último não-isento não pula → confirma → logout.

---

# SEÇÃO 7 — PWA & RESTRIÇÕES TÉCNICAS

- **Service Worker** (`sw.js`, §13.4): cache `hf-op-v3`; **network-first** no shell (online sempre pega código novo; cache só offline) — *corrige* o cache-first anterior que servia versão velha; API sempre rede.
- **Manifest** (§13.5): standalone, portrait, theme `#0e7a4e`, bg `#14323f`, ícone SVG maskable.
- **Storage:** **localStorage** = fila offline (`hf_op_offline_queue`) + flag de install-prompt; **cookie/header** = `X-Session-Token` (sessão em memória JS, perde no reload → re-login). **Não usa IndexedDB.**
- **Fila offline** (`offline-queue.js`, §13 código real): guarda POSTs (event/note) que falharam por rede; reenvia ao voltar online. Voz **não** entra na fila (grande demais).
- **i18n:** UI só pt-BR; voz pt-BR/es-ES/en-US (Web Speech API). Sem framework de i18n.
- **Acessibilidade:** alto contraste + alvos grandes; `aria-label` esparsos; sem suporte a screen reader testado. Sem `lang` por elemento.
- **Performance:** front é estático puro (HTML+CSS+JS+`fuse-data.js`), sem bundler; payload pequeno. Sem métricas Lighthouse formais.

---

# SEÇÃO 8 — CONTRATO DE API (endpoints usados pelo front)

Todos sob gate `Authorization: Bearer <OPERATOR_PAGE_TOKEN>` (token público da página, em `config.js`); identidade real = `X-Session-Token` (do login). Rate-limit por IP/sessão onde indicado.

| Método | Path | Auth | Body | Resposta / notas |
|---|---|---|---|---|
| POST | `/api/v3/op/auth/login` | page token | `{pin}` | `{session_token, person, auto_logoff_seconds, forgotten_check_prompts[]}` · 401 `invalid_pin` · 429 `too_many_attempts` (5/min/IP) |
| POST | `/api/v3/op/auth/logout` | session | `{reason?}` | `{ok}` |
| POST | `/api/v3/op/auth/heartbeat` | session | — | `{ok, person_id}` · mantém sessão viva (~20/min) |
| POST | `/api/v3/op/event/start` | session | `{activity_slug, batch_number?, cowork_with[], note?, orders_printed?}` | `{ok, event}` · 400 `note_required`/`orders_printed_required`/`unknown_activity_slug`/`unknown_batch` |
| POST | `/api/v3/op/event/retroactive` | session | start + `{started_at(ISO), ended_at?(ISO)}` | igual ao start; valida **mesmo dia EDT**, não-futuro, fim>início; `source=operator_page_retroactive` |
| POST | `/api/v3/op/event/:id/end` | session | `{bottles?, note?}` | `{ok}` · fecha event |
| GET | `/api/v3/op/active-operators` | session | — | lista p/ cowork + "tasks da equipe" |
| POST | `/api/v3/op/voice/upload` | session | base64 `{audio, transcript, language, duration_seconds, event_id?}` | `{id, transcript, duration_seconds}` · ≤5MB, 20/h/sessão |
| GET | `/api/v3/op/voice/:id/play` | session/admin | — | stream áudio |
| DELETE | `/api/v3/op/voice/:id` | dono/admin | — | soft-delete |
| POST | `/api/v3/op/forgotten-checkout/resolve` | session | `{person_id, still_working, discovered_via}` | mantém ou faz cascade-logout |
| POST | `/api/v3/op/clock-out` | session | `{counts[], unknown_event_ids[]}` | `{ok, closed_events[], ...}` · 422 `counts_required_last_operator` |
| GET | `/op/fuse-data.js` | público (estático) | — | `window.HF_DATA = {groups, quick, supplements[], recent_batches[]}` |
| GET | `/op/config.js` | público | — | `window.HF_OP_CONFIG = {pageToken}` |

> Nota: existe `GET /api/v3/op/activity-types`? **Não** — o catálogo chega via `fuse-data.js` (gerado por `build-fuse-data.js`). O endpoint de catálogo (`/api/adminpanel/activity-types`) é só do admin.

---

# SEÇÃO 9 — ASSETS VISUAIS

**Screenshots reais** (produção, Vitor, viewport 420×900) em [`screenshots/`](screenshots/): `01-login`, `02-home`, `03-grupos`, `04-tasks-limpeza`, `05-confirma`, `06-confirma-picker`, `07-almoco-confirma`, `08-clockout`. Capturados via Puppeteer navegando os menus (sem COMEÇAR → sem events; logout limpo ao fim).

**Não screenshotados** (descritos em §3 / ASCII abaixo): supplement/batch picker, voz (precisa de mic), finalizar, forgotten-overlay.

```
PIN (01-login)                         CONFIRM "Confirma?" (05/06)
┌───────────────────────────┐         ┌───────────────────────────┐
│   HealthFare               │         │ Confirma?                  │
│   Linha de Produção        │         │ ┌───────────────────────┐  │
│        · · · ·             │         │ │ 🧹 Limpeza            │  │
│   ┌─────┬─────┬─────┐      │         │ └───────────────────────┘  │
│   │  1  │  2  │  3  │      │         │ ⏰ Quando começou?         │
│   │  4  │  5  │  6  │      │         │ [▶️ Agora] [🕐 Esqueci…]   │
│   │  7  │  8  │  9  │      │         │   (Esqueci → [h▼][min▼][AM])│
│   │  ⌫  │  0  │  ✓  │      │         │ 👥 Tem alguém junto?       │
│   └─────┴─────┴─────┘      │         │  ☐ Ana 🟢  ☐ Simone        │
└───────────────────────────┘         │ 📝 Nota (opcional)  🎤 [PT]│
                                       │ [← Voltar][✕][▶ COMEÇAR]   │
                                       └───────────────────────────┘
```

**Branding:** verde `#0e7a4e` + azul-escuro `#14323f`; ícone `src/op/icon.svg` (logo HealthFare). Emojis como iconografia (sem icon library).

---

# SEÇÃO 10 — PAIN POINTS & BUGS CONHECIDOS

1. **Header lotado/quebrando** em viewport estreito (nome+timer+conn+Instalar+Sair+Trocar não cabem; texto corta — ver `05-confirma.png`). 🔴 prioridade de redesign.
2. **Cache PWA** — o SW antigo (cache-first) servia versão velha; corrigido p/ network-first + `hf-op-v3`, mas aparelhos que abriram antes precisam de **1 reload**. (raiz já resolvida; o aprendizado: sempre bumpar versão).
3. **Retroactive levou 3 iterações** até achar o lugar certo (lista de tasks → por-task → **dentro do CONFIRM**). Sinaliza que "onde colocar ação secundária" não é óbvio no layout atual.
4. **Conta compartilhada** "Production Line" (Ana + Bruno Sarmento sem Slack próprio) — atribuição depende de sufixo `_Bruno`; frágil.
5. **Quick-action Almoço** pula direto pro CONFIRM (sem passar por grupo) — UX inconsistente com o resto; pode confundir.
6. **Home pode encher** (Iniciar + Minhas tasks + Tasks da equipe + Nota) — hierarquia visual fraca quando há muita coisa ativa.
7. **Sessão em memória** — reload/troca de aba derruba a sessão (re-login). Some com o progresso de um draft em andamento.
8. **Voz depende de Web Speech API** — falha silenciosa em browsers sem suporte; sem fallback (Whisper é TODO).
9. **Modal bottom-sheet único** reusado pra tudo (grupos, tasks, picker, confirm, clock-out) — profundidade de navegação fica só no "Voltar".

---

# SEÇÃO 11 — PRINCÍPIOS DE DESIGN (do produto atual)

1. **Touch-first:** alvos ≥44px (na prática ≥60px), espaçamento generoso, sem estado hover-only.
2. **Carga cognitiva mínima:** 1 ação principal por tela, texto curto em pt-BR simples, sem inglês/jargão.
3. **Forgiving:** Voltar e Cancelar sempre presentes; confirmação em ações destrutivas/de fim.
4. **Feedback imediato:** `:active scale`, toasts, loading states, erros com mensagem específica (mapeados, nunca "erro").
5. **Cores semáforo:** verde=positivo (COMEÇAR/Finalizar) · vermelho=destrutivo/gravação/erro · azul-cinza=neutro · âmbar=catch-all "Outro".
6. **Iconografia por emoji** (universal, sem dependência externa).

---

# SEÇÃO 12 — O QUE O REDESIGN PRECISA RESOLVER (brief curto — Bruno + design preenchem)

- Header mais enxuto (resolver corte/quebra; agrupar ações secundárias).
- Home mais limpa / hierarquia quando há tasks ativas + equipe.
- Navegação entre grupos mais fluida (hoje tudo é um bottom-sheet com "Voltar").
- Retroactive ainda mais natural (já está no CONFIRM; refinar affordance do toggle).
- Voz mais discreta; cowork mais visual; status de produção do dia mais visível.
- Persistir sessão/draft (sobreviver reload).
- Install-prompt sutil.

---

# SEÇÃO 13 — ANEXOS TÉCNICOS (código real)

> Arquivos reproduzidos byte-a-byte do repositório (estado do commit `c69ae51`).

## 13.1 — src/op/app.js
```javascript
'use strict';
/* HEALTHFARE Operator Page — app principal (vanilla JS).
   Identidade real = PIN→sessão. pageToken só habilita a API.
   Estados/transições: state-machine.js. Dados estáticos: fuse-data.js. */
(function () {
  const CFG = window.HF_OP_CONFIG || { pageToken: '' };
  const DATA = window.HF_DATA || { supplements: [], groups: [], recent_batches: [] };
  const SM = window.HFStateMachine;

  let state = SM.INITIAL;
  let draft = SM.emptyDraft();
  let session = null;            // { token, person:{id,display_name,count_exempt}, auto_logoff_seconds }
  let pinBuf = '';
  let myTasks = [];
  let team = [];
  let logoffLeft = null;
  let timers = { hb: null, logoff: null, poll: null };
  let voiceLang = 'pt-BR';

  // ── helpers ──────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms || 2600);
  }
  // Fase F — POST de event/note pode ser enfileirado offline (fluxo online intocado).
  const Q = window.HFOfflineQueue;
  const queueable = (path) => /\/api\/v3\/op\/(event|note)/.test(path);
  async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const h = { Authorization: 'Bearer ' + CFG.pageToken, ...headers };
    if (session) h['X-Session-Token'] = session.token;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    // offline + enfileirável → guarda e segue (sincroniza quando voltar)
    if (Q && method === 'POST' && queueable(path) && typeof navigator !== 'undefined' && navigator.onLine === false) {
      Q.enqueue({ path, body, sessionToken: session && session.token });
      updateConn();
      return { queued: true };
    }
    let r;
    try {
      r = await fetch(path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (netErr) {
      if (Q && method === 'POST' && queueable(path)) { Q.enqueue({ path, body, sessionToken: session && session.token }); updateConn(); return { queued: true }; }
      throw netErr;
    }
    let j = null; try { j = await r.json(); } catch (_) { /* vazio */ }
    if (r.status === 401 && session && path.indexOf('/auth/login') < 0) { endSession(); throw new Error('Sessão expirou — entra de novo'); }
    if (!r.ok) { const e = new Error((j && (j.detail || j.error)) || ('HTTP ' + r.status)); e.status = r.status; e.body = j; throw e; }
    return j;
  }

  // ── conectividade + sync (Fase F) ───────────────────────────
  function updateConn() {
    const ind = $('conn'); if (!ind) return;
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    const pending = Q ? Q.size() : 0;
    ind.textContent = online ? (pending ? '🟢 ' + pending + ' p/ sincronizar' : '🟢') : ('🔴 offline' + (pending ? ' (' + pending + ')' : ''));
  }
  async function syncQueue() {
    if (!Q || !Q.size()) { updateConn(); return; }
    const res = await Q.flush(async (path, { body, sessionToken }) => {
      const r = await fetch(path, { method: 'POST', headers: { Authorization: 'Bearer ' + CFG.pageToken, 'X-Session-Token': sessionToken || '', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok && r.status !== 409) throw new Error('retry'); // 409 (já fechado) conta como entregue
    });
    if (res.sent) toast('✅ ' + res.sent + ' registro(s) sincronizado(s)');
    updateConn();
    if (state === 'IDLE') refreshIdle().catch(() => {});
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { updateConn(); syncQueue(); });
    window.addEventListener('offline', updateConn);
  }
  function dispatch(event, payload) {
    const r = SM.transition(state, event, { draft }, payload);
    state = r.state; draft = r.draft; render();
  }

  // ── sessão / timers ──────────────────────────────────────────
  function startTimers() {
    stopTimers();
    timers.hb = setInterval(() => { if (session) api('/api/v3/op/auth/heartbeat', { method: 'POST' }).catch(() => {}); }, 5000);
    timers.poll = setInterval(() => { if (state === 'IDLE') refreshIdle().catch(() => {}); }, 12000);
    if (session && session.auto_logoff_seconds != null) {
      logoffLeft = session.auto_logoff_seconds;
      timers.logoff = setInterval(() => {
        logoffLeft -= 1; renderHeaderTimer();
        if (logoffLeft <= 0) doLogout('auto_timeout');
      }, 1000);
    } else { logoffLeft = null; renderHeaderTimer(); }
  }
  function stopTimers() { Object.keys(timers).forEach((k) => { clearInterval(timers[k]); timers[k] = null; }); }
  function resetLogoff() { if (session && session.auto_logoff_seconds != null) { logoffLeft = session.auto_logoff_seconds; renderHeaderTimer(); } }
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((evt) => document.addEventListener(evt, resetLogoff, { passive: true }));

  function endSession() { session = null; stopTimers(); dispatch('LOGOUT'); }
  async function doLogout(reason) {
    const s = session;
    try { if (s) await api('/api/v3/op/auth/logout', { method: 'POST', body: { reason: reason === 'auto_timeout' ? 'auto_timeout' : 'manual' } }); } catch (_) {}
    endSession();
    if (reason === 'auto_timeout') toast('⏱ Saiu automático (sem atividade)');
  }

  // ── LOGIN ────────────────────────────────────────────────────
  function buildKeypad() {
    const kp = $('keypad'); kp.innerHTML = '';
    ['1','2','3','4','5','6','7','8','9','⌫','0','✓'].forEach((k) => {
      const b = el('button', null, k);
      b.onclick = () => {
        if (k === '⌫') pinBuf = pinBuf.slice(0, -1);
        else if (k === '✓') { if (pinBuf.length === 4) submitPin(); }
        else if (pinBuf.length < 4) pinBuf += k;
        renderPin();
        if (pinBuf.length === 4 && k !== '✓') submitPin();
      };
      kp.appendChild(b);
    });
  }
  function renderPin() {
    $('pin-dots').textContent = (pinBuf.replace(/./g, '●') + '····').slice(0, 4).split('').join(' ');
  }
  async function submitPin() {
    const pin = pinBuf; pinBuf = ''; renderPin();
    try {
      const r = await api('/api/v3/op/auth/login', { method: 'POST', body: { pin } });
      session = { token: r.session_token, person: r.person, auto_logoff_seconds: r.auto_logoff_seconds };
      $('pin-error').textContent = '';
      dispatch('LOGIN_OK');
      startTimers();
      refreshIdle().catch(() => {});
      // Fase 4 — colegas que passaram do horário e seguem logados
      if (r.forgotten_check_prompts && r.forgotten_check_prompts.length) {
        showForgottenPrompts(r.forgotten_check_prompts.slice(), 'login');
      }
    } catch (e) {
      $('pin-error').textContent = e.status === 429 ? 'Muitas tentativas — espera 1 min' : 'PIN errado';
    }
  }

  // ── Fase 4: pergunta sobre colegas que talvez esqueceram o checkout ──
  function showForgottenPrompts(queue, via) {
    if (!queue.length) return;
    const p = queue.shift();
    const ov = el('div', 'fc-overlay');
    const card = el('div', 'fc-card');
    card.appendChild(el('div', 'fc-q', p.prompt_text));
    const meta = [p.last_activity_at ? 'última atividade ' + p.last_activity_at : null, p.expected_end_time ? 'saída prevista ' + p.expected_end_time : null].filter(Boolean).join(' · ');
    if (meta) card.appendChild(el('div', 'fc-meta', meta));
    const resolve = async (stillWorking) => {
      try { await api('/api/v3/op/forgotten-checkout/resolve', { method: 'POST', body: { person_id: p.person_id, still_working: stillWorking, discovered_via: via } }); }
      catch (e) { toast('❌ ' + e.message); }
      ov.remove();
      showForgottenPrompts(queue, via); // próximo
    };
    const yes = el('button', 'btn-big btn-primary', '✅ Sim, ainda está trabalhando');
    yes.onclick = () => resolve(true);
    const no = el('button', 'btn-big', '❌ Não, fazer checkout dela');
    no.onclick = () => { if (window.confirm(`Tem certeza? ${p.person_name} será deslogada automaticamente.`)) resolve(false); };
    card.appendChild(yes); card.appendChild(no);
    ov.appendChild(card);
    document.body.appendChild(ov);
  }

  // ── IDLE data ────────────────────────────────────────────────
  async function refreshIdle() {
    if (!session) return;
    const [mine, ops] = await Promise.all([
      api('/api/v3/architect/person/' + session.person.id + '/today', { headers: { 'X-Operator-Id': String(session.person.id) } }),
      api('/api/v3/op/active-operators'),
    ]);
    myTasks = (mine.events || []).filter((e) => !e.ended_at);
    team = ops.operators || [];
    if (state === 'IDLE') renderIdle();
  }

  // ── render raiz ──────────────────────────────────────────────
  function render() {
    $('view-login').classList.toggle('hidden', state !== 'LOGGED_OUT');
    $('view-idle').classList.toggle('hidden', state !== 'IDLE');
    $('hdr').classList.toggle('hidden', state === 'LOGGED_OUT');
    const inModal = ['PICK_GROUP', 'PICK_TYPE', 'PICK_SUPPLEMENT', 'PICK_BATCH', 'CONFIRM', 'CLOCK_OUT'].includes(state);
    $('modal').classList.toggle('hidden', !inModal);
    if (session) $('hdr-user').textContent = '👤 ' + session.person.display_name;
    renderHeaderTimer();
    if (state === 'IDLE') renderIdle();
    if (state === 'PICK_GROUP') renderPickGroup();
    if (state === 'PICK_TYPE') renderPickType();
    if (state === 'PICK_SUPPLEMENT') renderPickSupplement();
    if (state === 'PICK_BATCH') renderPickBatch();
    if (state === 'CONFIRM') renderConfirm();
    // CLOCK_OUT renderiza no fluxo próprio (openClockOut)
  }
  function renderHeaderTimer() {
    $('hdr-timer').textContent = (session && logoffLeft != null) ? ('logoff em ' + logoffLeft + 's') : '';
  }

  function fmtDur(startIso) {
    const m = Math.max(0, Math.floor((Date.now() - Date.parse(startIso)) / 60000));
    return m >= 60 ? Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') : m + 'min';
  }

  function renderIdle() {
    const my = $('my-tasks'); my.innerHTML = '';
    if (!myTasks.length) my.appendChild(el('div', 'muted', 'Nenhuma tarefa aberta.'));
    myTasks.forEach((t) => {
      const c = el('div', 'card mine');
      const g = el('div', 'grow');
      g.appendChild(el('div', 'title', labelOf(t.slug)));
      g.appendChild(el('div', 'sub', (t.batch_number ? t.batch_number + ' · ' : '') + 'há ' + fmtDur(t.started_at)));
      c.appendChild(g);
      const b = el('button', 'btn-danger', '✔ Finalizar');
      b.onclick = () => finishTask(t);
      c.appendChild(b);
      my.appendChild(c);
    });
    const tt = $('team-tasks'); tt.innerHTML = '';
    const others = team.filter((o) => o.id !== session.person.id && o.current_event_id);
    if (!others.length) tt.appendChild(el('div', 'muted', 'Ninguém com tarefa aberta agora.'));
    others.forEach((o) => {
      const c = el('div', 'card');
      const g = el('div', 'grow');
      g.appendChild(el('div', 'title', o.display_name + (o.online ? ' 🟢' : '')));
      g.appendChild(el('div', 'sub', labelOf(o.current_slug) + (o.current_batch ? ' · ' + o.current_batch : '') + ' · há ' + fmtDur(o.current_started_at)));
      c.appendChild(g);
      const inCw = Array.isArray(o.current_cowork) && o.current_cowork.includes(session.person.id);
      const b = el('button', inCw ? 'btn-sm' : 'btn-primary', inCw ? 'Já junto' : '🤝 Entrar');
      if (!inCw) b.onclick = () => joinTask(o);
      c.appendChild(b);
      tt.appendChild(c);
    });
  }
  function labelOf(slug) {
    for (const q of DATA.quick || []) {
      if (q.slug === slug) return q.icon + ' ' + q.label;
    }
    for (const grp of DATA.groups || []) {
      const t = (grp.types || []).find((x) => x.slug === slug);
      if (t) return grp.icon + ' ' + t.label;
    }
    return slug || '—';
  }

  // ── modal helpers ───────────────────────────────────────────
  function modal(title, bodyEl, footButtons) {
    $('modal-title').textContent = title;
    const mb = $('modal-body'); mb.innerHTML = ''; mb.appendChild(bodyEl);
    const mf = $('modal-foot'); mf.innerHTML = '';
    (footButtons || []).forEach((b) => mf.appendChild(b));
  }
  const backBtn = () => { const b = el('button', 'btn-sm', '← Voltar'); b.onclick = () => dispatch('BACK'); return b; };
  const cancelBtn = () => { const b = el('button', 'btn-sm', '✕ Cancelar'); b.onclick = () => dispatch('CANCEL'); return b; };

  // ── fluxo start ─────────────────────────────────────────────
  function renderPickGroup() {
    const grid = el('div', 'grid2');
    (DATA.groups || []).forEach((g) => {
      const b = el('button', 'btn-big', g.icon + '<br>' + g.label);
      b.onclick = () => dispatch('PICK_GROUP', g);
      grid.appendChild(b);
    });
    // quick actions (ex.: Almoço) — pulam a escolha de grupo
    (DATA.quick || []).forEach((q) => {
      const b = el('button', 'btn-big btn-primary', q.icon + '<br>' + q.label);
      b.onclick = () => {
        dispatch('PICK_GROUP', { key: 'quick', icon: q.icon, label: q.label, types: [q] });
        dispatch('PICK_TYPE', q);
      };
      grid.appendChild(b);
    });
    modal('O que vai fazer?', grid, [cancelBtn()]);
  }
  // ── time picker inline (Bruno's design) — hora 1-12 / min / AM-PM ──
  function todayIso(h12, min, ampm) {
    let h = h12 % 12; if (ampm === 'PM') h += 12;
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate(), h, min, 0, 0).toISOString();
  }
  function fmtIsoTime(iso) {
    const d = new Date(iso); let h = d.getHours(); const m = d.getMinutes();
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }
  // container, onValid(iso), onClear(), opts{minIso}. Validação ao vivo.
  function buildTimePicker(container, onValid, onClear, opts) {
    const minIso = opts && opts.minIso;
    const opt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; };
    const hSel = el('select', 'tp-h'); hSel.appendChild(opt('', 'h'));
    for (let i = 1; i <= 12; i++) hSel.appendChild(opt(String(i), String(i)));
    const mSel = el('select', 'tp-m');
    ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'].forEach((m) => mSel.appendChild(opt(m, ':' + m)));
    let ampm = (new Date()).getHours() >= 12 ? 'PM' : 'AM';
    const apBtn = el('button', 'tp-ap', ampm); apBtn.type = 'button';
    apBtn.onclick = () => { ampm = ampm === 'AM' ? 'PM' : 'AM'; apBtn.textContent = ampm; validate(); };
    const status = el('div', 'tp-status');
    function validate() {
      if (!hSel.value) { status.textContent = ''; status.className = 'tp-status'; onClear(); return; }
      const iso = todayIso(parseInt(hSel.value, 10), parseInt(mSel.value, 10), ampm);
      if (new Date(iso).getTime() > Date.now()) {
        status.textContent = '⛔ Não pode ser no futuro'; status.className = 'tp-status bad'; onClear();
      } else if (minIso && new Date(iso).getTime() <= new Date(minIso).getTime()) {
        status.textContent = '⛔ Tem que ser depois do início'; status.className = 'tp-status bad'; onClear();
      } else {
        status.textContent = '✅ ' + fmtIsoTime(iso); status.className = 'tp-status ok'; onValid(iso);
      }
    }
    hSel.onchange = validate; mSel.onchange = validate;
    const row = el('div', 'tp-row');
    row.appendChild(hSel); row.appendChild(mSel); row.appendChild(apBtn);
    container.appendChild(row); container.appendChild(status);
  }

  function renderPickType() {
    const grid = el('div', 'grid2');
    ((draft.group && draft.group.types) || []).forEach((t) => {
      // "Outro (…)" de cada grupo (e o catch-all especial) ganham destaque visual
      const isOther = /_other$/.test(t.slug) || t.slug === 'special_task';
      const b = el('button', 'btn-big' + (isOther ? ' btn-outro' : ''), t.label);
      b.onclick = () => dispatch('PICK_TYPE', t);
      grid.appendChild(b);
    });
    modal((draft.group ? draft.group.icon + ' ' + draft.group.label : ''), grid, [backBtn(), cancelBtn()]);
  }
  function renderPickSupplement() {
    const box = el('div');
    const inp = el('input'); inp.type = 'text'; inp.placeholder = 'Nome do suplemento…'; inp.autocomplete = 'off';
    const list = el('div', 'list-pick');
    const draw = () => {
      list.innerHTML = '';
      SM.searchSupplements(DATA.supplements, inp.value).forEach((p) => {
        const b = el('button', null, p.canonical_name);
        b.onclick = () => dispatch('PICK_SUPPLEMENT', p);
        list.appendChild(b);
      });
    };
    inp.oninput = draw;
    box.appendChild(inp); box.appendChild(list); draw();
    modal('Qual suplemento?', box, [backBtn(), cancelBtn()]);
    setTimeout(() => inp.focus(), 50);
  }
  function renderPickBatch() {
    const box = el('div');
    const inp = el('input'); inp.type = 'tel'; inp.placeholder = 'Lote — 4 números (ex: 0190)'; inp.maxLength = 12;
    box.appendChild(inp);
    const recents = (DATA.recent_batches || []).filter((b) => !draft.supplement || b.product_id === draft.supplement.id).slice(0, 6);
    if (recents.length) {
      box.appendChild(el('h2', null, 'Recentes:'));
      const list = el('div', 'list-pick');
      recents.forEach((b) => {
        const bt = el('button', null, b.batch_number);
        bt.onclick = () => dispatch('PICK_BATCH', { batch_number: b.batch_number });
        list.appendChild(bt);
      });
      box.appendChild(list);
    }
    const ok = el('button', 'btn-primary', 'OK');
    ok.onclick = () => { if (inp.value.trim()) dispatch('PICK_BATCH', { batch_number: inp.value.trim() }); };
    const skip = el('button', 'btn-sm', 'Sem lote');
    skip.onclick = () => dispatch('SKIP_BATCH');
    modal('Qual lote?', box, [backBtn(), skip, ok]);
    setTimeout(() => inp.focus(), 50);
  }

  // voice note row (Web Speech API; pt-BR default, es-ES / en-US fallback manual)
  function voiceRow(textarea) {
    const row = el('div', 'voice-row');
    const mic = el('button', 'mic', '🎤');
    const lang = el('select', 'voice-lang');
    [['pt-BR', 'Português'], ['es-ES', 'Español'], ['en-US', 'English']].forEach(([v, l]) => {
      const o = el('option', null, l); o.value = v; lang.appendChild(o);
    });
    lang.value = voiceLang;
    lang.onchange = () => { voiceLang = lang.value; };
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    // Sem suporte (Firefox/Brave/iOS antigo): botão CLICÁVEL com explicação —
    // disabled silencioso parece "quebrado" (bug reportado 12/jun).
    const VOICE_ERR = {
      'not-allowed': '🎤 Permissão negada — toca no cadeado 🔒 da barra e libera o Microfone',
      'service-not-allowed': '🎤 Voz bloqueada pelo navegador — libera o microfone nas configurações',
      'audio-capture': '🎤 Nenhum microfone encontrado neste aparelho',
      network: '🎤 Sem conexão com o serviço de voz — verifica a internet',
      'no-speech': '🎤 Não ouvi nada — tenta de novo falando mais perto',
      aborted: null, // stop manual, sem aviso
    };
    const timerEl = el('span', 'rec-timer');
    let rec = null;          // SpeechRecognition (transcrição)
    let recorder = null;     // MediaRecorder (áudio)
    let stream = null; let chunks = []; let startMs = 0; let timerInt = null; let autoStop = null;

    function stopAll() {
      try { if (rec) rec.stop(); } catch (_) {}
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
      clearInterval(timerInt); clearTimeout(autoStop);
      mic.classList.remove('rec'); timerEl.textContent = '';
    }
    function startSpeech() {
      if (!SR) return;
      try {
        rec = new SR(); rec.lang = voiceLang; rec.continuous = true; rec.interimResults = true;
        const baseText = textarea.value;
        rec.onresult = (ev) => { let t = ''; for (const r of ev.results) t += r[0].transcript; textarea.value = (baseText ? baseText + ' ' : '') + t; };
        rec.onend = () => { rec = null; };
        rec.onerror = (ev) => { rec = null; const m = Object.prototype.hasOwnProperty.call(VOICE_ERR, ev.error) ? VOICE_ERR[ev.error] : null; if (m) toast(m, 4500); };
        rec.start();
      } catch (_) { rec = null; }
    }
    async function onStop() {
      const mime = (recorder && recorder.mimeType) || 'audio/webm';
      const blob = new Blob(chunks, { type: mime });
      const dur = Math.round((Date.now() - startMs) / 1000);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      recorder = null;
      if (!blob.size) return;
      // pergunta salvar
      const ok = window.confirm('Salvar essa gravação de voz? (' + dur + 's)\nO texto já foi pra nota.');
      if (!ok) return;
      try {
        const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(blob); });
        await api('/api/v3/op/voice/upload', { method: 'POST', body: {
          audio_base64: b64, audio_mime: mime.split(';')[0],
          transcript: textarea.value || null, language: voiceLang, duration_seconds: dur,
        } });
        toast('✅ Voz salva (' + dur + 's)');
      } catch (e) {
        toast('⚠️ Áudio não salvo (' + (e.message || 'rede') + ') — mas o texto ficou na nota');
      }
    }
    mic.onclick = async () => {
      if (rec || recorder) { stopAll(); return; }
      startSpeech();
      const hasRec = (typeof navigator !== 'undefined' && navigator.mediaDevices && window.MediaRecorder);
      if (!hasRec) {
        if (!SR) toast('🎤 Este navegador não grava — usa o Chrome ou Edge (ou digita)');
        else { mic.classList.add('rec'); } // só transcrição
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new MediaRecorder(stream); chunks = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onstop = onStop;
        recorder.start(); startMs = Date.now();
        mic.classList.add('rec');
        timerInt = setInterval(() => { timerEl.textContent = '🔴 ' + Math.round((Date.now() - startMs) / 1000) + 's'; }, 500);
        autoStop = setTimeout(stopAll, 60000); // limite 60s
      } catch (e) {
        mic.classList.remove('rec'); recorder = null;
        const m = e && e.name === 'NotAllowedError' ? VOICE_ERR['not-allowed'] : ('🎤 microfone: ' + (e && e.name || 'erro'));
        toast(m || '🎤 erro', 4500);
      }
    };
    row.appendChild(mic); row.appendChild(lang); row.appendChild(timerEl);
    return row;
  }

  function renderConfirm() {
    const box = el('div');
    let startedOverride = null; // ISO se "Esqueci de marcar" com hora válida; null = Agora
    const lines = [
      labelOf(draft.type && draft.type.slug),
      draft.supplement ? '📦 ' + draft.supplement.canonical_name : null,
      draft.batch ? '🔢 Lote ' + draft.batch.batch_number : null,
    ].filter(Boolean);
    box.appendChild(el('div', 'card mine', '<div class="grow"><div class="title">' + lines.join('</div><div class="sub">') + '</div></div>'));

    // ⏰ Quando começou? (ENTRE o card e o cowork) — Agora (default) | Esqueci
    box.appendChild(el('h2', null, '⏰ Quando começou?'));
    const modeRow = el('div', 'grid2');
    const bNow = el('button', 'btn-big btn-primary', '▶️ Agora');
    const bForgot = el('button', 'btn-big', '🕐 Esqueci de marcar');
    const picker = el('div', 'inline-picker hidden');
    let pickerBuilt = false;
    const refreshGo = () => { go.textContent = startedOverride ? ('▶ COMEÇAR ÀS ' + fmtIsoTime(startedOverride).toUpperCase()) : '▶ COMEÇAR'; };
    const setMode = (forgot) => {
      bNow.classList.toggle('btn-primary', !forgot);
      bForgot.classList.toggle('btn-primary', forgot);
      if (forgot) {
        if (!pickerBuilt) { pickerBuilt = true; buildTimePicker(picker, (iso) => { startedOverride = iso; refreshGo(); }, () => { startedOverride = null; refreshGo(); }); }
        picker.classList.remove('hidden');
      } else { picker.classList.add('hidden'); startedOverride = null; refreshGo(); }
    };
    bNow.onclick = () => setMode(false);
    bForgot.onclick = () => setMode(true);
    modeRow.appendChild(bNow); modeRow.appendChild(bForgot);
    box.appendChild(modeRow); box.appendChild(picker);

    // cowork
    box.appendChild(el('h2', null, '👥 Tem alguém junto?'));
    const cwBox = el('div');
    team.filter((o) => o.id !== session.person.id).forEach((o) => {
      const l = el('label', 'chk');
      const c = el('input'); c.type = 'checkbox'; c.value = o.id;
      c.checked = draft.cowork.includes(o.id);
      c.onchange = () => { draft.cowork = c.checked ? [...draft.cowork, o.id] : draft.cowork.filter((x) => x !== o.id); };
      l.appendChild(c);
      l.appendChild(el('span', null, o.display_name + (o.online ? ' 🟢' : ' ⚪') + (o.current_slug ? ' (em ' + labelOf(o.current_slug) + ')' : '')));
      cwBox.appendChild(l);
    });
    box.appendChild(cwBox);
    // quantidade de ordens (order_printing*) — obrigatória
    const ordersRequired = !!(draft.type && draft.type.orders_required);
    let ordersInput = null;
    if (ordersRequired) {
      box.appendChild(el('h2', null, '🔢 Quantas ordens vai imprimir?'));
      ordersInput = el('input'); ordersInput.type = 'number'; ordersInput.min = '1'; ordersInput.placeholder = 'ex: 206';
      ordersInput.oninput = () => { draft.orders_printed = ordersInput.value; };
      box.appendChild(ordersInput);
    }
    // nota + voz
    const noteRequired = !!(draft.type && draft.type.note_required);
    box.appendChild(el('h2', null, noteRequired ? '📝 Motivo (OBRIGATÓRIO)' : '📝 Nota (opcional)'));
    const ta = el('textarea');
    ta.placeholder = noteRequired ? 'Conta o que está fazendo (obrigatório) — ou usa o 🎤' : 'Escreve ou usa o microfone…';
    ta.value = draft.note || '';
    ta.oninput = () => { draft.note = ta.value; };
    box.appendChild(ta);
    box.appendChild(voiceRow(ta));

    const baseBody = () => ({
      activity_slug: draft.type.slug,
      batch_number: draft.batch ? draft.batch.batch_number : null,
      cowork_with: draft.cowork,
      note: ta.value.trim() || null,
      orders_printed: ordersRequired ? parseInt(ordersInput.value, 10) : undefined,
    });
    async function doSubmit(endedOverride) {
      try {
        if (startedOverride) {
          await api('/api/v3/op/event/retroactive', { method: 'POST', body: Object.assign(baseBody(), { started_at: startedOverride, ended_at: endedOverride || null }) });
          toast('✅ Task adicionada (' + fmtIsoTime(startedOverride) + ')');
        } else {
          await api('/api/v3/op/event/start', { method: 'POST', body: baseBody() });
          toast('✅ Tarefa iniciada!');
        }
        dispatch('CONFIRM_OK');
        refreshIdle().catch(() => {});
      } catch (e) {
        const M = { started_at_future: 'Hora no futuro', started_at_not_today: 'Só dá pra hoje (dias anteriores: fala com o admin)', ended_at_invalid: 'Hora de fim inválida', note_required: 'Precisa de nota', orders_printed_required: 'Precisa da quantidade' };
        toast('❌ ' + (M[e.message] || e.message));
        throw e;
      }
    }
    // "Já terminou?" — só quando started_at customizado (design: pergunta APÓS COMEÇAR)
    function askFinished() {
      const b = el('div');
      b.appendChild(el('div', 'card mine', '<div class="title">' + labelOf(draft.type.slug) + ' · começou ' + fmtIsoTime(startedOverride) + '</div>'));
      b.appendChild(el('h2', null, '✔ Já terminou essa task?'));
      const endPick = el('div', 'inline-picker hidden');
      let endedOverride = null; let built = false; let mode = 'no';
      const row = el('div', 'grid2');
      const yes = el('button', 'btn-big', 'Sim — escolher hora de fim');
      const no = el('button', 'btn-big btn-primary', 'Não — ainda fazendo');
      yes.onclick = () => { mode = 'yes'; if (!built) { built = true; buildTimePicker(endPick, (iso) => { endedOverride = iso; }, () => { endedOverride = null; }, { minIso: startedOverride }); } endPick.classList.remove('hidden'); yes.classList.add('btn-primary'); no.classList.remove('btn-primary'); };
      no.onclick = () => { mode = 'no'; endedOverride = null; endPick.classList.add('hidden'); no.classList.add('btn-primary'); yes.classList.remove('btn-primary'); };
      row.appendChild(yes); row.appendChild(no);
      b.appendChild(row); b.appendChild(endPick);
      const confirm = el('button', 'btn-primary', '✔ Adicionar');
      confirm.onclick = async () => {
        if (mode === 'yes' && !endedOverride) { toast('Escolhe a hora de fim (ou marca "ainda fazendo")'); return; }
        confirm.disabled = true;
        try { await doSubmit(endedOverride); } catch (_) { confirm.disabled = false; }
      };
      const back = el('button', 'btn-sm', '← Voltar'); back.onclick = () => renderConfirm();
      modal('Já terminou?', b, [back, confirm]);
    }

    const go = el('button', 'btn-primary', '▶ COMEÇAR');
    go.onclick = async () => {
      if (noteRequired && !ta.value.trim()) { toast('📝 Conta o que está acontecendo (ou usa 🎤) antes de começar'); ta.focus(); return; }
      const ordersN = ordersInput ? parseInt(ordersInput.value, 10) : null;
      if (ordersRequired && (!Number.isFinite(ordersN) || ordersN <= 0)) { toast('🔢 Informe quantas ordens (número maior que 0)'); if (ordersInput) ordersInput.focus(); return; }
      if (startedOverride) { askFinished(); return; } // pergunta "já terminou?" antes de inserir
      go.disabled = true;
      try { await doSubmit(null); } catch (_) { go.disabled = false; }
    };
    modal('Confirma?', box, [backBtn(), cancelBtn(), go]);
  }

  // ── finalizar / join / nota ─────────────────────────────────
  function finishTask(t) {
    const needsCount = ['production_line', 'encapsulation'].includes(t.slug);
    const box = el('div');
    let inp = null;
    if (needsCount) {
      box.appendChild(el('div', null, 'Quantos bottles saíram? (pode deixar vazio)'));
      inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.placeholder = 'ex: 746';
      box.appendChild(inp);
    }
    const ta = el('textarea'); ta.placeholder = 'Nota final (opcional)';
    box.appendChild(ta); box.appendChild(voiceRow(ta));
    const ok = el('button', 'btn-danger', '✔ Finalizar');
    ok.onclick = async () => {
      ok.disabled = true;
      try {
        await api('/api/v3/op/event/' + t.id + '/end', { method: 'POST', body: {
          bottles: inp && inp.value ? parseInt(inp.value, 10) : null,
          note: ta.value.trim() || null,
        } });
        toast('✅ Finalizada!');
        $('modal').classList.add('hidden');
        refreshIdle().catch(() => {});
      } catch (e) { ok.disabled = false; toast('❌ ' + e.message); }
    };
    const close = el('button', 'btn-sm', '✕');
    close.onclick = () => $('modal').classList.add('hidden');
    modal('Finalizar: ' + labelOf(t.slug), box, [close, ok]);
    $('modal').classList.remove('hidden');
  }

  function joinTask(o) {
    const box = el('div', null, 'Você quer entrar na tarefa de <b>' + o.display_name + '</b>?<br><span class="muted">' + labelOf(o.current_slug) + (o.current_batch ? ' · ' + o.current_batch : '') + '</span>');
    const ok = el('button', 'btn-primary', '🤝 Entrar');
    ok.onclick = async () => {
      ok.disabled = true;
      try {
        await api('/api/v3/op/event/' + o.current_event_id + '/join', { method: 'POST', body: {} });
        toast('✅ Você entrou!');
        $('modal').classList.add('hidden');
        refreshIdle().catch(() => {});
      } catch (e) { ok.disabled = false; toast('❌ ' + e.message); }
    };
    const close = el('button', 'btn-sm', '✕');
    close.onclick = () => $('modal').classList.add('hidden');
    modal('Entrar junto?', box, [close, ok]);
    $('modal').classList.remove('hidden');
  }

  function openNote() {
    const box = el('div');
    const ta = el('textarea'); ta.placeholder = 'Fala ou escreve a nota…';
    box.appendChild(ta); box.appendChild(voiceRow(ta));
    const ok = el('button', 'btn-primary', '💾 Salvar');
    ok.onclick = async () => {
      if (!ta.value.trim()) return;
      ok.disabled = true;
      try {
        await api('/api/v3/op/note', { method: 'POST', body: { text: ta.value.trim() } });
        toast('✅ Nota salva');
        $('modal').classList.add('hidden');
      } catch (e) { ok.disabled = false; toast('❌ ' + e.message); }
    };
    const close = el('button', 'btn-sm', '✕');
    close.onclick = () => $('modal').classList.add('hidden');
    modal('📝 Nota', box, [close, ok]);
    $('modal').classList.remove('hidden');
  }

  // ── clock-out (P5) ──────────────────────────────────────────
  async function openClockOut() {
    let info;
    try { info = await api('/api/v3/op/missing-bottle-counts'); }
    catch (e) { toast('❌ ' + e.message); return; }
    dispatch('OPEN_CLOCK_OUT');
    renderClockOut(info);
  }
  function renderClockOut(info) {
    const box = el('div');
    const rows = [];
    if (!info.missing.length) {
      box.appendChild(el('div', null, '✅ Todas as produções de hoje têm contagem.<br>Pode sair tranquilo.'));
    } else {
      box.appendChild(el('div', null, '📊 Antes de sair — produções de hoje <b>sem contagem</b>:'));
      info.missing.forEach((m) => {
        const r = el('div', 'missing-row');
        r.appendChild(el('div', 'title', (m.product || '?') + ' ' + (m.batch_number || '') + ' <span class="muted">(' + m.display_name + ', terminou ' + m.finalized_at_edt + ')</span>'));
        const inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.placeholder = 'Quantos bottles?';
        const l = el('label', 'chk');
        const c = el('input'); c.type = 'checkbox';
        l.appendChild(c); l.appendChild(el('span', null, '🤷 Não sei'));
        c.onchange = () => { inp.disabled = c.checked; if (c.checked) inp.value = ''; };
        r.appendChild(inp); r.appendChild(l);
        rows.push({ m, inp, chk: c });
        box.appendChild(r);
      });
      if (info.is_last_operator && !info.can_skip) {
        box.appendChild(el('div', 'muted', '⚠️ Você é o último a sair: preenche os números ou marca "Não sei".'));
      }
    }
    const out = el('button', 'btn-warn', '🚪 Confirmar e sair');
    out.onclick = async () => {
      const counts = []; const unknown = [];
      let incomplete = false;
      rows.forEach(({ m, inp, chk }) => {
        if (chk.checked) unknown.push(m.event_id);
        else if (inp.value !== '' && parseInt(inp.value, 10) >= 0) counts.push({ event_id: m.event_id, bottles: parseInt(inp.value, 10) });
        else incomplete = true;
      });
      if (incomplete && info.is_last_operator && !info.can_skip) { toast('Preenche tudo ou marca "Não sei"'); return; }
      out.disabled = true;
      try {
        await api('/api/v3/op/clock-out', { method: 'POST', body: { counts, unknown_event_ids: unknown } });
        session = null; stopTimers();
        dispatch('CLOCK_OUT_DONE');
        toast('👋 Até amanhã!');
      } catch (e) {
        out.disabled = false;
        if (e.status === 422 && e.body && e.body.missing) { renderClockOut({ ...e.body, is_last_operator: true, can_skip: false, missing: e.body.missing }); }
        else toast('❌ ' + e.message);
      }
    };
    const foot = [backBtn(), out];
    if (info.can_skip && info.missing.length) {
      const skip = el('button', 'btn-sm', 'Pular e sair');
      skip.onclick = async () => {
        skip.disabled = true;
        try {
          await api('/api/v3/op/clock-out', { method: 'POST', body: { counts: [], unknown_event_ids: [] } });
          session = null; stopTimers();
          dispatch('CLOCK_OUT_DONE');
          toast('👋 Até amanhã!');
        } catch (e) { skip.disabled = false; toast('❌ ' + e.message); }
      };
      foot.splice(1, 0, skip);
    }
    modal('🚪 Fim do dia', box, foot);
  }

  // ── bindings ────────────────────────────────────────────────
  $('btn-new').onclick = () => dispatch('START_NEW');
  $('btn-note').onclick = openNote;
  $('btn-clockout').onclick = openClockOut;
  $('btn-switch').onclick = () => doLogout('manual');

  // ── PWA: service worker + add-to-home (Fase F) ──────────────
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/op/sw.js').catch(() => {});
  }
  let _installPrompt = null;
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); _installPrompt = e;
      const b = $('btn-install'); if (b && !sessionStorage.getItem('hf_install_dismissed')) b.classList.remove('hidden');
    });
  }
  if ($('btn-install')) {
    $('btn-install').onclick = async () => {
      $('btn-install').classList.add('hidden');
      sessionStorage.setItem('hf_install_dismissed', '1');
      if (_installPrompt) { _installPrompt.prompt(); _installPrompt = null; }
    };
  }

  buildKeypad(); renderPin(); render(); updateConn();
  if (typeof navigator !== 'undefined' && navigator.onLine !== false) syncQueue();
}());
```

## 13.2 — src/op/style.css
```css
/* HEALTHFARE Operator Page — touch-first: alvos ≥60px, fontes ≥18px,
   alto contraste. Operadores com pouca leitura: ícone + pouca palavra. */
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
html, body { height: 100%; }
body {
  font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  font-size: 19px; background: #f2f5f7; color: #14323f;
}
.hidden { display: none !important; }

header {
  position: sticky; top: 0; z-index: 50;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  background: #14323f; color: #fff; padding: 12px 14px; font-size: 18px;
}
header .timer { font-variant-numeric: tabular-nums; opacity: .85; }
.hdr-actions { display: flex; gap: 8px; }

main { max-width: 720px; margin: 0 auto; padding: 16px 14px 40px; }
.view h1 { text-align: center; margin: 28px 0 18px; font-size: 34px; line-height: 1.15; }
.view h1 small { font-size: 20px; font-weight: 400; color: #4b6a77; }
h2 { font-size: 20px; margin: 22px 0 10px; color: #2c505f; }

/* ── botões ── */
button { font: inherit; cursor: pointer; border: 0; border-radius: 14px; }
.btn-big {
  display: block; width: 100%; min-height: 68px; margin: 10px 0;
  font-size: 23px; font-weight: 600; background: #fff; color: #14323f;
  border: 2px solid #c8d6dc; box-shadow: 0 2px 4px rgba(0,0,0,.06);
}
.btn-big:active { transform: scale(.985); }
.btn-primary { background: #0e7a4e; border-color: #0e7a4e; color: #fff; }
.btn-danger  { background: #b3261e; border-color: #b3261e; color: #fff; }
.btn-warn    { background: #b35c00; border-color: #b35c00; color: #fff; }
/* "Outro (…)" de cada grupo — destaque âmbar, fundo claro p/ não competir
   com os tipos normais mas chamar atenção como atalho de catch-all */
.btn-outro   { background: #fff7e6; border-color: #d99100; color: #8a5a00; }
/* Fase 4 — overlay de "colega esqueceu o checkout?" */
.fc-overlay { position: fixed; inset: 0; background: rgba(15,23,42,.6); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 16px; }
.fc-card { background: #fff; border-radius: 16px; padding: 20px; max-width: 460px; width: 100%; }
.fc-q { font-size: 21px; font-weight: 600; margin-bottom: 8px; }
.fc-meta { font-size: 14px; color: #64748b; margin-bottom: 16px; }
/* time picker inline por task (retroactive unificado) */
.type-wrap { margin: 0 0 10px; }
.type-wrap .btn-big { margin: 0; }
.forgot-link { display: block; width: 100%; margin: 2px 0 0; padding: 4px 0; border: 0; background: transparent; color: #94a3b8; font-size: 13px; cursor: pointer; text-align: left; }
.forgot-link:hover { color: #475569; }
.inline-picker { padding: 8px 0 4px; }
.inline-picker.hidden { display: none; }
.tp-row { display: flex; gap: 8px; align-items: center; }
.tp-row select { padding: 8px; font-size: 18px; flex: 1; }
.tp-ap { padding: 8px 14px; font-size: 18px; font-weight: 700; background: #2c505f; color: #fff; border: 0; border-radius: 8px; min-width: 64px; }
.tp-status { font-size: 14px; margin-top: 4px; min-height: 18px; }
.tp-status.bad { color: #b3261e; font-weight: 600; }
.tp-status.ok { color: #0e7a4e; font-weight: 600; }
.btn-sm { min-height: 44px; padding: 8px 14px; font-size: 16px; background: #2c505f; color: #fff; }

/* ── teclado PIN ── */
.pin-dots { text-align: center; font-size: 48px; letter-spacing: 18px; margin: 8px 0 4px; min-height: 60px; }
.pin-error { text-align: center; color: #b3261e; min-height: 28px; font-weight: 600; }
.keypad {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
  max-width: 360px; margin: 8px auto;
}
.keypad button {
  min-height: 76px; font-size: 30px; font-weight: 700;
  background: #fff; border: 2px solid #c8d6dc; border-radius: 16px;
}
.keypad button:active { background: #dcebf1; }

/* ── cards de task ── */
.cards { display: flex; flex-direction: column; gap: 10px; }
.card {
  background: #fff; border: 2px solid #c8d6dc; border-radius: 14px;
  padding: 14px; display: flex; align-items: center; gap: 12px;
}
.card .grow { flex: 1; min-width: 0; }
.card .title { font-weight: 700; font-size: 20px; }
.card .sub { color: #4b6a77; font-size: 16px; margin-top: 2px; }
.card button { min-height: 56px; padding: 0 18px; font-size: 18px; font-weight: 700; }
.card.mine { border-color: #0e7a4e; }

/* ── modal ── */
.modal {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(10, 30, 40, .55); display: flex; align-items: flex-end; justify-content: center;
}
.modal-box {
  background: #f2f5f7; width: 100%; max-width: 720px; max-height: 92vh;
  border-radius: 18px 18px 0 0; padding: 18px 16px 26px; overflow-y: auto;
}
.modal-title { font-size: 23px; font-weight: 800; margin-bottom: 14px; }
.modal-foot { display: flex; gap: 10px; margin-top: 16px; }
.modal-foot button { flex: 1; min-height: 60px; font-size: 20px; font-weight: 700; }

.grid2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.grid2 .btn-big { margin: 0; min-height: 86px; font-size: 21px; }

input[type="text"], input[type="number"], input[type="tel"], textarea {
  width: 100%; min-height: 58px; font-size: 21px; padding: 10px 14px;
  border: 2px solid #c8d6dc; border-radius: 12px; background: #fff;
}
textarea { min-height: 90px; }
.list-pick { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.list-pick button { text-align: left; padding: 14px; min-height: 60px; font-size: 20px; background:#fff; border:2px solid #c8d6dc; }

.chk { display: flex; align-items: center; gap: 12px; min-height: 56px; font-size: 20px; padding: 6px 4px; }
.chk input { width: 30px; height: 30px; }

.voice-row { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
.voice-row .mic { min-width: 76px; min-height: 58px; font-size: 26px; background: #fff; border: 2px solid #c8d6dc; }
.voice-row .mic.rec { background: #b3261e; color: #fff; border-color: #b3261e; animation: pulse 1s infinite; }
.voice-lang { min-height: 44px; font-size: 15px; background:#e3edf1; border:1px solid #c8d6dc; padding: 4px 10px; }
@keyframes pulse { 50% { opacity: .6; } }

.toast {
  position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%);
  background: #14323f; color: #fff; padding: 14px 22px; border-radius: 12px;
  font-size: 19px; z-index: 200; max-width: 92vw; text-align: center;
}
.muted { color: #4b6a77; font-size: 16px; }
.missing-row { background: #fff; border: 2px solid #c8d6dc; border-radius: 12px; padding: 12px; margin-bottom: 10px; }
.missing-row .title { font-weight: 700; font-size: 19px; }
.missing-row input { margin-top: 8px; }
```

## 13.3 — src/op/index.html
```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>HealthFare — Produção</title>
  <link rel="stylesheet" href="style.css">
  <link rel="manifest" href="/op/manifest.json">
  <meta name="theme-color" content="#0e7a4e">
  <link rel="apple-touch-icon" href="/op/icon.svg">
</head>
<body>
  <!-- header sticky (só logado) -->
  <header id="hdr" class="hidden">
    <span id="hdr-user">👤 —</span>
    <span id="hdr-timer" class="timer"></span>
    <span id="conn" class="timer" title="conexão"></span>
    <span class="hdr-actions">
      <button id="btn-install" class="btn-sm hidden">📱 Instalar</button>
      <button id="btn-clockout" class="btn-sm btn-warn">Sair (fim do dia)</button>
      <button id="btn-switch" class="btn-sm">Trocar</button>
    </span>
  </header>

  <main id="main">
    <!-- LOGIN -->
    <section id="view-login" class="view">
      <h1>HealthFare<br><small>Linha de Produção</small></h1>
      <div id="pin-dots" class="pin-dots">····</div>
      <div id="pin-error" class="pin-error"></div>
      <div class="keypad" id="keypad"></div>
    </section>

    <!-- IDLE -->
    <section id="view-idle" class="view hidden">
      <button id="btn-new" class="btn-big btn-primary">➕ Iniciar Tarefa</button>
      <h2>📋 Minhas tarefas</h2>
      <div id="my-tasks" class="cards"></div>
      <h2>👥 Tasks da equipe agora</h2>
      <div id="team-tasks" class="cards"></div>
      <button id="btn-note" class="btn-big">📝 Nota / 🎤 Voz</button>
    </section>
  </main>

  <!-- modal genérico -->
  <div id="modal" class="modal hidden">
    <div class="modal-box">
      <div id="modal-title" class="modal-title"></div>
      <div id="modal-body" class="modal-body"></div>
      <div id="modal-foot" class="modal-foot"></div>
    </div>
  </div>

  <div id="toast" class="toast hidden"></div>

  <script src="config.js"></script>
  <script src="fuse-data.js"></script>
  <script src="state-machine.js"></script>
  <script src="offline-queue.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

## 13.4 — src/op/sw.js
```javascript
'use strict';
/* HEALTHFARE Operator Page — Service Worker (Fase F; rev. network-first).
   - Shell estático: NETWORK-FIRST (online sempre pega o código novo; cai pro
     cache só offline). Antes era cache-first, o que servia app.js velho pra
     sempre — operadores não viam updates. Bump de CACHE invalida o antigo.
   - API: network-first sem cache (dados frescos).
   - POST offline: tratado no app (offline-queue.js). */
const CACHE = 'hf-op-v3';
const SHELL = [
  '/op/', '/op/index.html', '/op/style.css', '/op/app.js',
  '/op/state-machine.js', '/op/fuse-data.js', '/op/offline-queue.js',
  '/op/config.js', '/op/manifest.json', '/op/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.filter(Boolean))).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // POSTs vão direto pra rede (queue é no app)
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) {
    // network-first: tenta rede, sem cache de API (dados sempre frescos)
    e.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  // estáticos: NETWORK-FIRST (atualiza o cache) → cache → index.html (offline)
  e.respondWith(
    fetch(req).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return resp;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/op/index.html')))
  );
});
```

## 13.5 — src/op/manifest.json
```json
{
  "name": "HealthFare — Linha de Produção",
  "short_name": "HF Linha",
  "start_url": "/op/",
  "scope": "/op/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#14323f",
  "theme_color": "#0e7a4e",
  "lang": "pt-BR",
  "icons": [
    { "src": "/op/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable" }
  ]
}
```

## 13.7 — state-machine.js (máquina pura)
```javascript
'use strict';
/**
 * HEALTHFARE — Operator Page: máquina de estados PURA da UI.
 * UMD: usada pelo app.js no browser E testada no jest (node).
 *
 * Estados:
 *   LOGGED_OUT       teclado PIN
 *   IDLE             minhas tasks + tasks da equipe + iniciar nova
 *   PICK_GROUP       modal: grupos de atividade
 *   PICK_TYPE        modal: tipos do grupo
 *   PICK_SUPPLEMENT  autocomplete (só se type.requires_product)
 *   PICK_BATCH       lote (4 dígitos ou recentes)
 *   CONFIRM          resumo + cowork A + nota/voz
 *   CLOCK_OUT        modal bottle counts (P5)
 *
 * transition(state, event, payload) → { state, draft } — sem efeitos.
 * draft = { group, type, supplement, batch, cowork, note }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HFStateMachine = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const INITIAL = 'LOGGED_OUT';
  const emptyDraft = () => ({ group: null, type: null, supplement: null, batch: null, cowork: [], note: '' });

  /**
   * @param {string} state   estado atual
   * @param {string} event   LOGIN_OK | LOGOUT | AUTO_TIMEOUT | START_NEW |
   *                         PICK_GROUP | PICK_TYPE | PICK_SUPPLEMENT |
   *                         PICK_BATCH | SKIP_BATCH | BACK | CANCEL |
   *                         CONFIRM_OK | OPEN_CLOCK_OUT | CLOCK_OUT_DONE
   * @param {object} ctx     { draft } (imutável — retorna novo)
   * @param {*} payload
   */
  function transition(state, event, ctx, payload) {
    const draft = (ctx && ctx.draft) ? ctx.draft : emptyDraft();

    // globais: qualquer estado
    if (event === 'AUTO_TIMEOUT' || event === 'LOGOUT') return { state: 'LOGGED_OUT', draft: emptyDraft() };
    if (event === 'CANCEL' && state !== 'LOGGED_OUT') return { state: 'IDLE', draft: emptyDraft() };

    switch (state) {
      case 'LOGGED_OUT':
        if (event === 'LOGIN_OK') return { state: 'IDLE', draft: emptyDraft() };
        break;

      case 'IDLE':
        if (event === 'START_NEW') return { state: 'PICK_GROUP', draft: emptyDraft() };
        if (event === 'OPEN_CLOCK_OUT') return { state: 'CLOCK_OUT', draft };
        break;

      case 'PICK_GROUP':
        if (event === 'PICK_GROUP') return { state: 'PICK_TYPE', draft: { ...draft, group: payload } };
        if (event === 'BACK') return { state: 'IDLE', draft: emptyDraft() };
        break;

      case 'PICK_TYPE':
        if (event === 'PICK_TYPE') {
          const next = payload && payload.requires_product ? 'PICK_SUPPLEMENT' : 'CONFIRM';
          return { state: next, draft: { ...draft, type: payload } };
        }
        if (event === 'BACK') return { state: 'PICK_GROUP', draft: { ...draft, group: null } };
        break;

      case 'PICK_SUPPLEMENT':
        if (event === 'PICK_SUPPLEMENT') return { state: 'PICK_BATCH', draft: { ...draft, supplement: payload } };
        if (event === 'BACK') return { state: 'PICK_TYPE', draft: { ...draft, type: null } };
        break;

      case 'PICK_BATCH':
        if (event === 'PICK_BATCH') return { state: 'CONFIRM', draft: { ...draft, batch: payload } };
        if (event === 'SKIP_BATCH') return { state: 'CONFIRM', draft: { ...draft, batch: null } };
        if (event === 'BACK') return { state: 'PICK_SUPPLEMENT', draft: { ...draft, supplement: null } };
        break;

      case 'CONFIRM':
        if (event === 'CONFIRM_OK') return { state: 'IDLE', draft: emptyDraft() };
        if (event === 'BACK') {
          if (draft.type && draft.type.requires_product) return { state: 'PICK_BATCH', draft: { ...draft, batch: null } };
          return { state: 'PICK_TYPE', draft: { ...draft, type: null } };
        }
        break;

      case 'CLOCK_OUT':
        if (event === 'CLOCK_OUT_DONE') return { state: 'LOGGED_OUT', draft: emptyDraft() };
        if (event === 'BACK') return { state: 'IDLE', draft };
        break;

      default:
        break;
    }
    return { state, draft }; // evento irrelevante: não muda nada
  }

  /** Normaliza pra busca: minúsculo, sem acento. */
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  /**
   * Autocomplete local de supplements (substitui Fuse.js — npm indisponível;
   * substring com normalização + ranking por uso recente cobre o caso).
   * @param {Array} list  [{id, canonical_name, aliases[], last_used_at}]
   * @param {string} query
   * @returns top 20
   */
  function searchSupplements(list, query) {
    const q = norm(query).trim();
    const scored = [];
    for (const p of list || []) {
      const name = norm(p.canonical_name);
      const aliases = (p.aliases || []).map(norm);
      let score = -1;
      if (!q) score = 0;
      else if (name.startsWith(q)) score = 3;
      else if (name.includes(q)) score = 2;
      else if (aliases.some((a) => a.startsWith(q))) score = 2;
      else if (aliases.some((a) => a.includes(q))) score = 1;
      if (score >= 0) scored.push({ p, score, used: p.last_used_at ? Date.parse(p.last_used_at) : 0 });
    }
    scored.sort((a, b) => (b.score - a.score) || (b.used - a.used) || norm(a.p.canonical_name).localeCompare(norm(b.p.canonical_name)));
    return scored.slice(0, 20).map((x) => x.p);
  }

  return { INITIAL, transition, emptyDraft, searchSupplements, norm };
}));
```

## 13.8 — offline-queue.js (fila offline, localStorage)
```javascript
'use strict';
/* HEALTHFARE Operator Page — fila offline (Fase F). UMD (browser + jest).
   Guarda POSTs que falharam por estar offline em localStorage; reenvia
   quando a internet volta. Mantém o fluxo ONLINE byte-a-byte igual (só
   entra em ação quando navigator.onLine é false OU o fetch lança rede).

   Itens: { id, path, body, sessionToken, ts }. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HFOfflineQueue = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const KEY = 'hf_op_offline_queue';
  // storage injetável (testes passam um fake); no browser usa localStorage
  function store() {
    try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (_) { return null; }
  }
  function read(st) {
    const s = st || store(); if (!s) return [];
    try { return JSON.parse(s.getItem(KEY) || '[]'); } catch (_) { return []; }
  }
  function write(items, st) {
    const s = st || store(); if (!s) return;
    try { s.setItem(KEY, JSON.stringify(items)); } catch (_) {}
  }
  function enqueue(item, st) {
    const items = read(st);
    items.push({ ...item, id: (item.id || (Date.now() + '-' + items.length)), ts: item.ts || Date.now() });
    write(items, st);
    return items.length;
  }
  function size(st) { return read(st).length; }
  function clear(st) { write([], st); }

  /**
   * Reenvia a fila. doFetch(path, {body, sessionToken}) → Promise resolve/reject.
   * Para no primeiro erro (provável ainda-offline) pra preservar ordem.
   * @returns {Promise<{sent:number, remaining:number}>}
   */
  async function flush(doFetch, st) {
    let items = read(st);
    let sent = 0;
    while (items.length) {
      const it = items[0];
      try {
        await doFetch(it.path, { body: it.body, sessionToken: it.sessionToken });
        items = items.slice(1);
        write(items, st);
        sent += 1;
      } catch (_) {
        break; // ainda offline / erro — tenta de novo depois
      }
    }
    return { sent, remaining: items.length };
  }

  return { KEY, read, write, enqueue, size, clear, flush };
}));
```

## 13.9 — GROUPS / QUICK / NOTE_REQUIRED / ORDERS_REQUIRED (build-fuse-data.js)
```javascript
// grupos de UI: slug real → (grupo, label de exibição)
// Cada grupo termina com um "✏️ Outro (…)" — task type livre, nota
// obrigatória (migration 024). O grupo "outros" já tem o catch-all
// special_task, então não recebe outro.
const GROUPS = [
  { key: 'linha', icon: '🏭', label: 'Linha de Produção', items: [
    ['production_line', 'Linha de produção'], ['review', 'Revisão'],
    ['counting', 'Contagem'], ['line_changeover', 'Troca de linha'],
    ['production_line_other', '✏️ Outro (Linha)'],
  ] },
  { key: 'formulacao', icon: '🧪', label: 'Formulação', items: [
    ['formulation', 'Formulação'], ['mixing', 'Mistura'],
    ['encapsulation', 'Cápsulas / Tablets'], ['material_handling', 'Preparo de material (peneira…)'],
    ['formulation_other', '✏️ Outro (Formulação)'],
  ] },
  { key: 'limpeza', icon: '🧹', label: 'Limpeza / Suporte', items: [
    ['cleaning', 'Limpeza'], ['repair', 'Conserto de máquina'],
    ['facility_maintenance', 'Manutenção'], ['organization', 'Organização'],
    ['machine_downtime', 'Máquina parada'],
    ['label_change', '🏷️ Troca de label'], ['label_repair', '🔧 Conserto de label'],
    ['cleaning_other', '✏️ Outro (Limpeza/Suporte)'],
  ] },
  { key: 'embalagem', icon: '📦', label: 'Embalagem / Ordens', items: [
    ['orders', 'Ordens'], ['order_printing', 'Impressão de ordens'],
    ['order_printing_2', '2ª impressão'], ['labeling', 'Colar labels'],
    ['packaging', 'Embalagem'],
    ['marketplace_prep', 'Trocar label / marketplace'],
    ['packaging_other', '✏️ Outro (Embalagem)'],
  ] },
  { key: 'envio', icon: '🚚', label: 'Envio', items: [
    ['shipping', 'Envio'], ['dc_shipment', 'Envio DC'],
    ['clinic_shipment', 'Envio Clínica'], ['box_closing', 'Fechar caixas'],
    ['shipping_other', '✏️ Outro (Envio)'],
  ] },
  { key: 'outros', icon: '⋯', label: 'Outros', items: [
    ['special_task', '✨ Algo Especial'], ['break', 'Pausa'], ['meeting', 'Reunião'], ['training', 'Treinamento'],
  ] },
];

```

## 13.6 — v3.activity_types (catálogo completo, do banco)
```json
[
 {
  "slug": "break",
  "display_name": "Pausa",
  "category": "meta",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "☕"
 },
 {
  "slug": "end_of_day",
  "display_name": "Fim de Expediente",
  "category": "meta",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "🌙"
 },
 {
  "slug": "lunch",
  "display_name": "Almoço",
  "category": "meta",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "🍽"
 },
 {
  "slug": "box_closing",
  "display_name": "Fechar Caixas",
  "category": "pnp_phase",
  "flow": "pnp",
  "requires_product": false,
  "is_background": false,
  "emoji": "📦"
 },
 {
  "slug": "labeling",
  "display_name": "Etiquetagem",
  "category": "pnp_phase",
  "flow": "pnp",
  "requires_product": true,
  "is_background": false,
  "emoji": "🏷"
 },
 {
  "slug": "order_printing",
  "display_name": "Impressão de Ordens",
  "category": "pnp_phase",
  "flow": "pnp",
  "requires_product": false,
  "is_background": false,
  "emoji": "🖨"
 },
 {
  "slug": "order_printing_2",
  "display_name": "2ª Impressão de Ordens",
  "category": "pnp_phase",
  "flow": "pnp",
  "requires_product": false,
  "is_background": false,
  "emoji": "🖨"
 },
 {
  "slug": "orders",
  "display_name": "Ordens (P&P)",
  "category": "pnp_phase",
  "flow": "pnp",
  "requires_product": false,
  "is_background": false,
  "emoji": "📋"
 },
 {
  "slug": "packaging",
  "display_name": "Empacotamento",
  "category": "pnp_phase",
  "flow": "pnp",
  "requires_product": true,
  "is_background": false,
  "emoji": "📦"
 },
 {
  "slug": "shipping",
  "display_name": "Envio Pedidos (cliente)",
  "category": "pnp_phase",
  "flow": "pnp",
  "requires_product": true,
  "is_background": false,
  "emoji": "🚚"
 },
 {
  "slug": "counting",
  "display_name": "Contagem",
  "category": "production_phase",
  "flow": "production",
  "requires_product": true,
  "is_background": false,
  "emoji": "📦"
 },
 {
  "slug": "dc_shipment",
  "display_name": "Envio pro DC (FBA/WFS)",
  "category": "production_phase",
  "flow": "production",
  "requires_product": false,
  "is_background": false,
  "emoji": null
 },
 {
  "slug": "encapsulation",
  "display_name": "Encapsulação",
  "category": "production_phase",
  "flow": "production",
  "requires_product": true,
  "is_background": true,
  "emoji": "💊"
 },
 {
  "slug": "formulation",
  "display_name": "Formulação",
  "category": "production_phase",
  "flow": "production",
  "requires_product": true,
  "is_background": true,
  "emoji": "🧪"
 },
 {
  "slug": "line_changeover",
  "display_name": "Troca de Linha (Setup)",
  "category": "production_phase",
  "flow": "production",
  "requires_product": false,
  "is_background": false,
  "emoji": null
 },
 {
  "slug": "marketplace_prep",
  "display_name": "Preparo p/ Marketplace (Contagem/FNSKU)",
  "category": "production_phase",
  "flow": "production",
  "requires_product": true,
  "is_background": false,
  "emoji": null
 },
 {
  "slug": "mixing",
  "display_name": "Mix",
  "category": "production_phase",
  "flow": "production",
  "requires_product": true,
  "is_background": true,
  "emoji": "🥣"
 },
 {
  "slug": "production_line",
  "display_name": "Linha de Produção",
  "category": "production_phase",
  "flow": "production",
  "requires_product": true,
  "is_background": false,
  "emoji": "🏭"
 },
 {
  "slug": "review",
  "display_name": "Revisão",
  "category": "production_phase",
  "flow": "production",
  "requires_product": true,
  "is_background": false,
  "emoji": "🔍"
 },
 {
  "slug": "cleaning",
  "display_name": "Limpeza",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "🧹"
 },
 {
  "slug": "cleaning_other",
  "display_name": "Outro (Limpeza/Suporte)",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "✏️"
 },
 {
  "slug": "clinic_shipment",
  "display_name": "Envio Injeções (clínica)",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": null
 },
 {
  "slug": "facility_maintenance",
  "display_name": "Manutenção da Fábrica",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": null
 },
 {
  "slug": "formulation_other",
  "display_name": "Outro (Formulação)",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "✏️"
 },
 {
  "slug": "label_change",
  "display_name": "Troca de label",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "🏷️"
 },
 {
  "slug": "label_repair",
  "display_name": "Conserto de label",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "🔧"
 },
 {
  "slug": "machine_downtime",
  "display_name": "Downtime da Máquina",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": null
 },
 {
  "slug": "material_handling",
  "display_name": "Recebimento/Expedição (Carga/Descarga)",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": null
 },
 {
  "slug": "meeting",
  "display_name": "Reunião",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "💬"
 },
 {
  "slug": "organization",
  "display_name": "Organização",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "📋"
 },
 {
  "slug": "packaging_other",
  "display_name": "Outro (Embalagem)",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "✏️"
 },
 {
  "slug": "production_line_other",
  "display_name": "Outro (Linha)",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "✏️"
 },
 {
  "slug": "repair",
  "display_name": "Conserto",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "🔧"
 },
 {
  "slug": "shipping_other",
  "display_name": "Outro (Envio)",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "✏️"
 },
 {
  "slug": "special_task",
  "display_name": "Especial / Outros",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "✨"
 },
 {
  "slug": "training",
  "display_name": "Treinamento",
  "category": "support",
  "flow": "support",
  "requires_product": false,
  "is_background": false,
  "emoji": "📚"
 }
]
```
