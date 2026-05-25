# Dashboard V3 — UI atual (briefing pra redesign)

Documento descritivo do estado **atual** do dashboard V3. Sem prescrições; só o que existe hoje. Pra alguém que nunca abriu o sistema entender antes de redesenhar.

URL de produção: `https://productionlineservice-production.up.railway.app/dashboard/`
Build: estático servido por Express em `/dashboard` (SPA Vite, sem build no servidor).

---

## 1. Estrutura geral

### O que é
Single-page application em React 18 + Vite. Cliente puro: **fala só com `/api/v3/data/*`** (envelope JSON). Não tem backend SSR, não tem banco direto, não tem nada além de fetch.

Auth: PIN admin (`x-admin-pin` header) — único nível. Sem multi-usuário, sem permissões finas.

### Roteamento
Por **hash** do URL (`#hoje`, `#producao`, …). Sem `react-router`. Trocar aba = `location.hash` muda → componente da página é remontado.

Ordem dos tabs no nav (esquerda → direita), todos no mesmo nível:

| slug | label | descrição curta |
|---|---|---|
| `hoje` | **Hoje** | Centro de comando do dia (default ao abrir) |
| `producao` | **Produção** | Esteira de fases por lote |
| `pp` | **P&P** | Bloco de Picking & Packing do dia |
| `suporte` | **Suporte** | Ocorrências avulsas |
| `pessoas` | **Pessoas** | Timeline por pessoa |
| `produto` | **Produto** | Histórico por produto + contagens |
| `metas` | **Metas** | Esperado × realizado, duplicatas suspeitas |
| `falar` | **Falar** | Porta de saída manual (postar como "Carolina") |
| `planejamento` | **Planejamento** | **PLACEHOLDER** (Bloco 4 futuro) |
| `carolina` | **Carolina** | **PLACEHOLDER** (Bloco 5 futuro — chat de aprendizado) |
| `config` | **Config** | CRUD de Deadlines |

### Header (sticky no topo)
Sempre visível em todas as páginas. Da esquerda pra direita:
- **Brand:** `HealthFare V3` (bold) + chip cinza pequeno `shadow`
- **Worker status:** `🟢 worker ativo · fila 0 · shadow` (lê `/api/v3/data/health` a cada render — não polling)
- **Spacer flex**
- **Seletor de data:** `◀` `<input type="date">` `▶` (NY date). Compartilhado por TODAS as páginas — mudar a data afeta o que cada aba lê.
- **Botão sair:** limpa o PIN da sessão, volta pra tela de login.

### Nav (segunda linha)
Linha abaixo do header. Fundo um pouco mais escuro (`--panel2`). Tabs como `<a href="#slug">`, com a ativa em **fundo azul + texto escuro**. Hover: muda só a cor do texto.

### Tela de PIN (não autenticado)
Página única centrada:
- Título "HealthFare V3" grande
- Input `type="password"` com letter-spacing largo (formato de PIN visual)
- Botão "entrar"
- Mensagem de erro vermelha se o PIN vazio
- Não valida no front — só salva em `sessionStorage` e a API retorna 401 se errado

---

## 2. Cada tela em detalhe

### 2.1 — `Hoje` (Centro de Comando)

**A página mais densa e principal.** Layout vertical:

```
┌─────────────────────────────────────────────────────────────┐
│ Centro de comando · ao vivo            [+ novo registro] ▶ │
│ Legenda: ■Produção  ■P&P  ■Suporte   🔗cowork ⏱live ⏰esp.│
├─────────────────────────────────────────────────────────────┤
│ [TOPO — 4 cards de resumo lado a lado, wrap em mobile]     │
│  📦 Produção hoje  🎯 Metas  🚚 P&P  ⚠ Atenção            │
├─────────────────────────────────────────────────────────────┤
│ [Banner "🔗 modo juntar"] (só quando mergeArm ativo)        │
├─────────────────────────────────────────────────────────────┤
│ [TIMELINE horizontal — uma linha por pessoa]                │
│                                                             │
│  ● AO VIVO  | 8 AM    9 AM    10 AM   ...   6 PM            │
│  ───────────|──────────────────────────────────────────────│
│  (V) Vitor  | [Linha Tribulus 1h21m]┃                       │
│  idle 23m  │       [Form. Vita B1 14m⏰]                   │
│  ───────────|──────────────────────────────────────────────│
│  (S) Simone | [Imp. Ordens 20m·468]  [Etiquetagem 2h49m🔗VI]│
│  sem reg.   │                                               │
│  ...        │                                               │
└─────────────────────────────────────────────────────────────┘
                                          [Painel detalhe 360px]
                                          [Toast bottom-right]
```

#### TOPO — 4 cards horizontais

Layout: flexbox com `flex: 1; min-width: 230px`, wrap em telas pequenas.

| card | header | número grande | lista abaixo |
|---|---|---|---|
| **📦 Produção hoje** | uppercase cinza | `468 garrafas` (32px bold) | breakdown por produto |
| **🎯 Metas em andamento** | | `467 / 750 · 62%` por meta | barra de progresso (verde se bateu, accent se em curso); "começou 9:34 AM" |
| **🚚 P&P do dia** | | `3h 30m` (duração total) | `ordens 475 ordens` · `tempo/ordem 26s` · `correio 1:00 PM · faltam 1h 23m` |
| **⚠ Atenção** | RED border + glow quando >0 | número de alertas (vermelho) | lista de alertas (duplicatas/inválidos/conserto) |

Cada card: `background: var(--panel)`, border-radius 12px, padding 16/18.

#### Timeline (o coração da tela)

Container `overflow-x: auto`. **Largura por hora FIXA** (150px desktop, 130px tablet, 120px mobile) — o dia inteiro NÃO comprime na largura da tela; rola horizontalmente se preciso. Bruno priorizou legibilidade > "tudo cabe".

**Estrutura:**
- **Coluna de nomes (esquerda, sticky):** 200px desktop (140/120 em telas menores). Avatar circular 38px com iniciais brancas/azuis. Nome em 14px bold. Abaixo: `idle 23m` (cinza, vira âmbar ≥30min) e `sem registro Xh · desde 3:34 PM` (âmbar quando há gap longo/parou de postar).
- **Trilha (direita):** posição relativa. Background com linhas verticais sutis a cada hora (`repeating-linear-gradient`). Cada bloco posicionado em `left%`/`width%` calculados a partir do `started_at`/`ended_at`.
- **Eixo de horas (topo):** uma linha tipo "● AO VIVO" ou "histórico", com ticks `9 AM`, `12 PM`, `3 PM` etc (formato 12h NY).
- **Linha "agora":** barra vertical fina **azul accent** com glow, que atravessa todas as linhas. Só aparece quando a data é hoje.

#### Bloco de atividade

Cada event = um retângulo absoluto na trilha da pessoa, colorido por **fluxo**:

| cor | fluxo | exemplo |
|---|---|---|
| `--prod #1e3a8a` (azul escuro) | production | linha de produção, encapsulação, revisão |
| `--pnp #78350f` (marrom/âmbar escuro) | pnp | impressão de ordens, etiquetagem |
| `--support #4c1d95` (roxo escuro) | support | limpeza, conserto, organização, almoço (meta também roxo) |

**Dentro do bloco** (na ordem vertical):
- Linha 1: **função** (13px bold, branco) — `Linha de Produção`
- Linha 2: **produto** (11px regular) — `Tribulus Terrestris`
- Linha 3: **cronômetro** (11px tabular-nums, mono) — `⏱ 1:23:45` (live) ou `1:23:45` (fechado)

**Decorações no canto:**
- **Cowork:** chip(s) brancos com **iniciais** (`AN`, `VI`) no canto **superior direito**. Hover mostra "cowork com Ana · Linha de Produção". O texto da função ganha padding-right pra não bater nas chips.
- **Overrun** (background passou `expected_seconds`): `⏰` no canto **superior esquerdo**, borda âmbar pulsante. Texto ganha padding-left.
- **Live** (event ainda aberto + data = hoje): borda accent + animação `ccpulse` (glow azul oscilando).
- **Selected** (clicado): outline azul accent 2px.
- **Cowork variant:** borda **tracejada** branca.

**Interações no bloco:**
- **Hover** → pop-up pequeno (`.cc-hover`) segue o mouse (fixed position, `pointer-events:none`), com nome da pessoa, função + produto, e cronômetro accent. Clamp pra não sair da viewport.
- **Click** → abre o painel lateral de detalhe (`.cc-detail`).
- Em **modo juntar** (mergeArm): clique vira "candidato a merge" em vez de abrir o painel.

#### Painel lateral de detalhe (`CCDetail`)

Quando clica num bloco. **360px de largura**, fundo `--panel`, **fullscreen abaixo de 700px**. Posição: `fixed; top:0; right:0; bottom:0; z-index:50`.

**Header sticky:** nome da pessoa, abaixo um chip-pílula com o `kind` (foreground/background/meta) colorido + nome da atividade + slug em cinza. Botão `×` no canto.

**Corpo:** `<dl>` em duas colunas (96px label + flex valor), em uppercase pequeno os labels:

```
FLUXO     production
ENTRADA   9:02 AM  (May 25, 9:02 AM)
SAÍDA     9:25 AM
DURAÇÃO   22:55  · contando (se live)
PRODUTO   Stinging Nettle / BR-2026-0157
COWORK    Ana, Vitor (nomes resolvidos)
ESPERADO  3:00:00  ⏰ passou 12min  (se overrun)
CONFIANÇA [badge colorido]
PHASE     Revisão
DESCRIÇÃO ...
SLACK TS  1779454937.239559
FECHAMENTO manual
ID        ev 109
```

**Footer (view mode):** botões `Editar` (primário azul) · `Juntar com outro` · `Dividir`.

#### Drawer de edição (modo `edit`)

O mesmo painel lateral, mas o `<dl>` vira `<form>`. Campos (em `<select>` ou input):
- **Pessoa** (select de `/catalog/persons`)
- **Função** (select agrupado por flow: Produção / P&P / Suporte; cada item marca `· bg` se background ou `· meta`)
- **Produto** + **Lote** em campos SEPARADOS (lado a lado):
  - Produto: select de `/catalog/products` (todos os 64 suplementos), com "(nenhum)"
  - Lote: input text livre, com chips dos lotes ativos pra clicar
- **Início / Fim** em `<input type="datetime-local">` com label "(NY)" — fuso NY explícito, conversão EDT/EST automática
- **Quantidade** + **Unidade** (order/bottle/box/uncertain)
- **Descrição** (textarea)

**Aviso de sobreposição:** se o novo `[started_at, ended_at]` cruza outro **foreground** da mesma pessoa, aparece card âmbar inline listando os conflitos. Bg/meta coexistem por invariante — não alertam. **Não bloqueia** — botão Salvar fica âmbar com texto "Confirmar Salvar mesmo assim" e exige 2º clique.

**Botões:** `Salvar` (primário) · `Apagar` (com 2-cliques de confirmação, vermelho) · `Cancelar`.

**Toast de undo** (bottom-right) após apagar: `"Event 142 apagado." [Desfazer]` com timer 10s. Clicar Desfazer chama `/events/:id/restore`.

#### Botão "+ novo registro"

No header da página `Hoje`, alinhado à direita. Abre o mesmo drawer em modo `create` — form em branco, started_at default 12:00 PM NY do dia selecionado. Não tem aviso de sobreposição em modo create (a princípio — pode mudar).

#### Merge / Split

- **Juntar:** "Juntar com outro" no painel → fecha painel, ativa `mergeArm` (state em `Hoje`). Banner azul accent aparece no topo da timeline: `🔗 Modo juntar: clique em outro event pra juntar com "Linha de Produção" (ev 129)` + botão Cancelar. Próximo clique em qualquer bloco abre um modal de confirmação:
  ```
  ┌─────────────────────────────────────────┐
  │ Juntar 2 events                      ×  │
  ├─────────────────────────────────────────┤
  │ [ev 129 · Vitor]     +    [ev 130·Ana] │
  │  Linha de Produção        Revisão       │
  │  1:45 PM → 3:23 PM        1:45 PM →2:48 │
  │                                         │
  │ Resultado (sobrevivente ev 129):        │
  │  1:45 PM → 3:23 PM                      │
  │  Outro vira soft-deleted (merged)       │
  │                                         │
  │  [Cancelar]      [Confirmar juntar]    │
  └─────────────────────────────────────────┘
  ```
  Avisos âmbar se pessoas/atividades diferentes (não bloqueia).

- **Dividir:** "Dividir" no painel → modal com `<input type="datetime-local">` (default no meio do intervalo). Valida que o split_at está estritamente entre `started_at` e `ended_at`. Preview das 2 partes resultantes.

#### Auto-refresh

Quando a data é hoje:
- Polling de **12s** em todos os reads (`/timeline`, `/production`, `/pp`, `/goals`, `/counts`, `/deadlines`)
- `useNow(1s)` tick — re-renderiza pra atualizar cronômetros live e linha "agora"
- Datas passadas: polling desligado (POLL=0); fica estático

#### Mobile

- Largura por hora cai pra **120px**, coluna de nomes pra 120px, avatar 28px.
- Scroll horizontal funciona no touch; nomes ficam **sticky-left**.
- Painel lateral vira **fullscreen** (<700px).
- Toast vira full-width inferior (<560px).
- Cards do TOPO viram 2-por-linha (min-width 44%).

---

### 2.2 — `Produção`

Lista vertical de **lotes** trabalhados no dia, um por card.

Cada card (`.lote`):
- Cabeçalho: `Lote BR-2026-0145 · Tribulus Terrestris` (esquerda) + lista de pessoas (cinza, direita)
- **Bloco de meta** (se houver): "Meta 750 · Realizado 467 · 62% ✗ não bateu" + barra horizontal (`.bar`) preenchida em vermelho/verde
- **Esteira de fases** (`.esteira`): fileira horizontal de retângulos `.fase` (cada um = uma fase: encapsulação, mix, linha, revisão...), com `→` cinza entre eles. Cada retângulo mostra nome (bold) + tempo (`fmtDur`).
- Linha de rodapé: "tempo no lote: 5h 23m · ⚠ 1 event(s) de duração inválida ignorados"

Layout simples, sem interação além de scroll. Não dá pra editar daqui (a edição é via `Hoje`).

### 2.3 — `P&P` (Picking & Packing)

Mostra **um único card** com o bloco do dia:
- Métricas grandes (`.metric`): "Tempo total do bloco" / "Pacotes feitos" / "Tempo por pacote"
- Lista de sub-passos: `✓ Impressão de Ordens · 20m`, etc.
- Deadline em rodapé: "Deadline correio 1:00 PM · faltam 1h 23m"

Bem mais simples que `Hoje`. Tudo num card só.

### 2.4 — `Suporte`

Tabela de ocorrências:
| atividade | pessoa | início | duração |
|---|---|---|---|
| Conserto ⚠ downtime (vermelho) | Bruno Sarmento | 11:11 AM | 29m |

Sem edição inline.

### 2.5 — `Pessoas`

Uma seção (`.person`) por pessoa, fundo `--panel2` arredondado:
- Nome em bold + contagem ("3 atividade(s)")
- Linha de atividades (`.tl`): pequenos blocos coloridos pela CATEGORIA do activity (não pelo flow), com hora de início + nome — `9:02 review`, `9:37 cleaning`, etc.
- Legenda no fim (`FlowLegend` em `ui.jsx`)

Layout antigo, mais simples que a timeline do `Hoje`. Não tem cronômetro nem interação.

### 2.6 — `Produto`

- `<select>` de produtos no topo (lista de `/catalog/products`)
- Ao escolher: aparece histórico do produto (`from → to`):
  - Tabela de contagens (data, lote, garrafas, reportado por, **Editar / Apagar**)
  - Rodapé com contagem de lotes no histórico
- **Editar contagem**: modal com input `bottles` → `PATCH /counts/:id` (usa `supersede`; cria nova contagem, anterior fica superseded, histórico preservado).
- **Apagar contagem**: `DELETE /counts/:id`. Sem restore via UI (registro fica em `deleted_at` no banco).
- Toast com feedback.

### 2.7 — `Metas`

Cards das metas do dia, lado a lado (`.cards`):
- Nome do produto + número do lote
- "Esperado → Realizado" + porcentagem colorida + ✓/✗
- Barra de progresso
- Tempo no lote
- **Botões inline:** Editar (modal: expected_quantity, unit, confidence → `PATCH /goals/:id`) · Apagar (`DELETE`)

Seção "⚠ Possíveis duplicatas — revisar" abaixo (se houver):
- Card por duplicata suspeita: produto, lote, qty, quem reportou, quando
- Botões: **Confirmar duplicata** (vermelho — não soma) · **Confirmar adicional** (azul — entra no realizado). Chama `POST /counts/:id/confirm`.

### 2.8 — `Falar` (porta de saída manual)

Página com 2 cards lado a lado + tabela de histórico abaixo + sub-form de reação.

**Card "Nova mensagem"** (esquerda, flex:1):
- **Persona** (select de `/sender-profiles`) + **Canal** (Produção/Admin) lado a lado
- **Texto** (textarea) com toolbar acima de botões `B I ` ~` (envolvem seleção em mrkdwn) + `·` + atalhos de mention `Vitor Simone Ana Henrique` (inserem `<@U…>` no cursor)
- **Imagem** (file input, max 8MB, base64 → POST)
- **Responder em thread** (input text, aceita link Slack ou ts cru)
- **PREVIEW WYSIWYG**: mostra o nome do remetente, o texto formatado, a imagem (max 240px). Card destacado com border-left accent.
- Botão **Enviar** → 1º clique fica âmbar "Confirmar envio" → 2º clique posta. + botão Cancelar.

**Card "Personas"** (direita, ~320px):
- Lista das personas salvas (`★` na default, ícone se houver)
- Botão "+ nova" no header → modal de criação (nome + ícone opcional `:emoji:` ou URL)
- Por linha: links pequenos "★ default" · "editar" · "apagar"

**Sub-form "Reagir a uma mensagem (emoji)"** (card abaixo, max 540px):
- Canal + emoji (sem `:`) + ts/link da msg
- Botão **Reagir** → `POST /react`
- Nota explicando que reação não permite override de username (vai como bot real)

**Tabela "Histórico (últimos 15)"**:
| quando | tipo | persona | canal | texto / emoji | img? | thread? | ts |
|---|---|---|---|---|---|---|---|
| May 25, 9:34 AM | ✉ post | Carolina | C09UNBXFR | "olá time!" | 🖼 (inline) ou 📎 (link) | 🧵 ou — | 1779… |

### 2.9 — `Planejamento` (PLACEHOLDER)

Card único cinza dizendo "Em construção — chega no Bloco 4. Tasks futuras, o que vem pela frente, notificação opcional por task."

### 2.10 — `Carolina` (PLACEHOLDER)

Card único cinza dizendo "Em construção — chega no Bloco 5. Conversa de aprendizado: a Carolina traz observações, você confirma/corrige, ela aprende."

### 2.11 — `Config`

Subtítulo: "Configurações". Por enquanto só tem **Deadlines**:
- Header com "Deadlines" + botão "+ novo deadline" alinhado à direita
- Tabela: id, label (+ notes cinza), fluxo, tipo (recurring/oneoff), horário (12h AM/PM), dias da semana (`Dom Seg Ter…`), data (pra oneoff), ativa, botões Editar/Apagar
- Modal de criação/edição (wide=640px): label, flow, kind, time_of_day, **botões toggle de dias** (Dom/Seg/Ter/…/Sáb com primary quando ativo), due_date (se oneoff), checkbox active, notes (textarea)

---

## 3. Sistema visual atual

### 3.1 — Cores (CSS variables em `:root`)

| variável | valor | uso |
|---|---|---|
| `--bg` | `#0f172a` | fundo geral (azul muito escuro, slate-900) |
| `--panel` | `#1e293b` | cards, header, painel lateral |
| `--panel2` | `#172033` | nav, sub-cards, headers de tabela |
| `--border` | `#334155` | bordas em geral, dividers |
| `--text` | `#e2e8f0` | texto principal (quase branco) |
| `--muted` | `#64748b` | texto secundário, labels |
| `--accent` | `#38bdf8` | CTA, ativo, hover, links, sky-400 |
| `--ok` | `#16a34a` | sucesso, meta batida |
| `--bad` | `#dc2626` | erro, apagar, falha |
| `--warn` | `#ea580c` | aviso, overrun, downtime |
| `--prod` | `#1e3a8a` | **fluxo produção** (blue-800) |
| `--pnp` | `#78350f` | **fluxo P&P** (amber-900, marrom) |
| `--support` | `#4c1d95` | **fluxo suporte / meta** (violet-900) |
| `--high` | `#16a34a` | confidence high (verde) |
| `--medium` | `#ca8a04` | confidence medium (amarelo) |
| `--low` | `#ea580c` | confidence low (laranja) |
| `--unconfirmed` | `#dc2626` | confidence unconfirmed (vermelho) |

**Paleta geral:** tema escuro Tailwind-ish slate como base, sky/cyan como accent. Tem boa consistência mas faltam tons intermediários e estado hover/focus padronizado.

### 3.2 — Tipografia

- **Família:** `system-ui, -apple-system, Segoe UI, Roboto, sans-serif`. Sem webfont (fast load, zero rede).
- **Base:** 14px no body.
- **Hierarquia:**
  - `h2` 16px (título de seção)
  - `h3` 13px (subtítulo)
  - `.cc-big` 32px bold (números grandes nos cards)
  - `.cc-detail-title` 16px bold
  - `.cc-bk-fn` 13px bold (função no bloco)
  - `.cc-bk-pr` 11px (produto no bloco)
  - `.cc-bk-live` 11px tabular-nums (cronômetro)
  - `.small` 12px
  - Labels em `.cc-card-h` e `.cc-field > span`: 11-12px **UPPERCASE** com letter-spacing pequeno, cinza
- **Pesos:** 400 (regular), 600 (semibold pra nomes/labels), 700 (bold pra função/títulos), 800 (cc-big, chips de cowork)
- **Tabular-nums** nos cronômetros e tempos (alinhamento de dígitos).

### 3.3 — Espaçamento, bordas, cards

- **Border-radius padrão:**
  - Botões/inputs: 6px
  - Cards comuns: 10px
  - Cards do topo CC: 12px
  - Chips/pills/badges: 4-10px (variado, **não consistente**)
- **Padding de card:** entre 13/15px (card antigo) e 16/18px (card cc-card) — **diferente entre seções**
- **Gap de flex/grid:** 10-14px geralmente
- **`main` content:** `max-width: 1100px` centralizado (margens automáticas)

### 3.4 — Ícones

**Tudo emoji** (sem biblioteca de ícones). Lista do que aparece:

| | onde |
|---|---|
| 📦 | header card Produção hoje |
| 🎯 | header card Metas |
| 🚚 | header card P&P |
| ⚠ | header card Atenção (e warnings) |
| ✓ ✗ | meta bateu/não |
| ⏱ | cronômetro live |
| ⏰ | overrun de background |
| 🔗 | cowork (no banner do modo juntar; nos blocos virou chip com iniciais) |
| ● | ao vivo (na coluna de nomes do eixo) |
| 🟢 🔴 | worker status |
| ◀ ▶ | seletor de data |
| ★ | persona default |
| ✉ ⚛ | tipo no histórico do Falar |
| 🖼 📎 | imagem inline/link |
| 🧵 | thread |
| × | fechar painel/modal |

**Pros:** zero dependência, rápido, multiplataforma.
**Contras:** rende diferente por OS, alguns parecem pequenos demais, sem controle fino de cor (são gráficos coloridos do sistema).

### 3.5 — Animações

- **`ccpulse` (2s loop):** box-shadow accent pulsando no bloco live.
- **`cc-modal-in` (0.16s):** modal entra com translateY + scale + opacity.
- **`cc-toast-in` (0.18s):** toast slide-up bottom-right.
- **`.cc-block:hover { transform: translateY(-1px) }`** sutil no hover.
- **`transition: transform .08s ease`** no bloco.

Nenhum easing complexo; tudo `ease` ou `ease-out` curtos.

### 3.6 — Responsivo

3 breakpoints:
- **≤900px (tablet):** coluna de nomes do CC 140px, hora 130px, avatar 32px.
- **≤700px:** painel lateral vira fullscreen.
- **≤560px (mobile):** main padding reduzido, cards 44% min-width (2 por linha), name col 120px, hour 120px, avatar 28px, toast full-width inferior, modal max-width none.

Sem hamburger menu — os tabs ficam wrap em flex. Em mobile com 11 tabs, vira **2-3 linhas de nav** — fica densa mas funcional.

---

## 4. Arquitetura frontend

### 4.1 — Stack

```
React 18.3.1 + react-dom 18.3.1
Vite 5.4.11 (build) + @vitejs/plugin-react 4.3.4
type: module
sem TypeScript, sem CSS framework, sem state lib externa
```

Bundle final: ~213KB JS (~65KB gzip), 16KB CSS (~4KB gzip). Build em ~700ms.

### 4.2 — Estrutura de arquivos `dashboard/`

```
dashboard/
├── package.json
├── vite.config.js          (base:/dashboard/, outDir:../public/dashboard)
├── index.html              (1 div root + main.jsx)
└── src/
    ├── main.jsx             (6 linhas — createRoot + App)
    ├── App.jsx              (89 linhas — shell + roteamento por hash + PinGate + Worker + topbar/nav)
    ├── pages.jsx            (2107 linhas — TODAS as 11 páginas + componentes)
    ├── ui.jsx               (58 linhas — Loading, ErrorBox, Empty, Metric, ConfBadge, GoalBar, ActivityBlock, FlowLegend)
    ├── api.js               (214 linhas — apiGet/Post/Patch/Delete, useFetch, usePoll, useNow, helpers de formato/fuso)
    └── styles.css           (523 linhas — tudo num arquivo, sem CSS modules)
```

**Observação central:** `pages.jsx` tem **2107 linhas**. Tudo num arquivo: cada tela, cada modal, cada sub-componente (`CCBlock`, `CCRow`, `CCTimeline`, `CCDetail`, `CCMergeConfirm`, `CCSplitModal`, `CCModal`, `CCToast`, `CCHoverTip`, `GoalEditModal`, `CountEditModal`, `DeadlineEditModal`, `PersonaEditModal`, `ReactForm`). Sem separação por feature/folder.

### 4.3 — Componentes principais (dentro de `pages.jsx`)

| componente | linha aprox | papel |
|---|---|---|
| `Hoje` | ~25 | Página `Hoje`, gerencia estado central (sel, hov, mergeArm, etc.) |
| `CCTopo` | ~115 | Container dos 4 cards do topo |
| `CardProducao` / `CardMetas` / `CardPP` / `CardAtencao` | ~170-260 | Cada card individual |
| `CCTimeline` | ~290 | Renderiza eixo + lista de rows |
| `CCRow` | ~360 | Uma pessoa: nome+idle à esquerda + trilha |
| `CCBlock` | ~400 | Um event individual (cor, cronômetro, chips, click/hover) |
| `CCDetail` | ~530 | Painel lateral em 3 modos (view/edit/create) |
| `CCMergeConfirm` | ~750 | Modal de merge com preview |
| `CCSplitModal` | ~830 | Modal de split com datetime |
| `CCModal` | ~880 | Wrapper genérico de modal (overlay+box) |
| `CCToast` | ~905 | Toast bottom-right com undo |
| `CCHoverTip` | ~930 | Pop-up que segue o mouse |
| `Producao` `PP` `Suporte` `Pessoas` `Produto` `Metas` | ~960+ | Páginas das outras abas |
| `Falar` + `ReactForm` + `PersonaEditModal` | ~1500+ | Tab Falar |
| `Config` + `DeadlineEditModal` | ~1900+ | Tab Config |

### 4.4 — Consumo de dados

**Base:** `/api/v3/data/`. Auth via header `x-admin-pin` (lido de `sessionStorage.v3pin`).

**Envelope padrão da API:**
```json
{
  "meta": { "version": "v3", "tz": "America/New_York", "date": "...", "generated_at": "..." },
  "data": { ... }
}
```

**Helpers em `api.js`:**
- `apiGet(path)` / `apiPost(path, body)` / `apiPatch(path, body)` / `apiDelete(path, body)`
- `useFetch(path, deps)` — fetch único, retorna `{loading, data, meta, error}`
- `usePoll(path, deps, intervalMs)` — fetch + setInterval, refresh silencioso (não pisca pra loading)
- `useNow(active, intervalMs)` — relógio re-renderizando a cada N ms (default 1s)
- `getPin/setPin/clearPin` — sessionStorage
- Formatadores: `fmtDur` (h m s genérico), `fmtClock` (h:mm:ss), `fmtTime` (12h NY), `fmtDateTime`, `fmtHour12`, `fmt12hHHMM`, `fmtMinutes`
- Fuso NY: `nyToday`, `nyMinutes`, `shiftDate`, `isoToNyDatetimeLocal`, `nyDatetimeLocalToIso`, `toNyOffsetIso`

**Erros:** `apiCall` interpreta 401 como sessão inválida (`.unauthorized = true`), demais como `Error(message)`. Não tem retry automático.

### 4.5 — Estado local vs API

**Vem da API (via useFetch/usePoll):** TUDO o que aparece — events, metas, contagens, deadlines, batches, persons, products, activity_types, health, sender_profiles, history de envios manuais. Sem cache local — cada navegação faz fetch.

**Estado local React (useState):**
- Em `App`: `authed` (PIN), `date` (seletor global), `route` (hash)
- Em `Hoje`: `sel` (event selecionado no painel), `hov` (hover tip coords), `refreshTick` (força refetch após write), `toast`, `mergeArm`, `mergeConfirm`, `splitOpen`
- Em `CCDetail`: `mode` (view/edit/create), `form` (campos), `busy`, `err`, `confirmingOverlap`, `confirmingDelete`
- Em `Falar`: `text`, `channel`, `senderId`, `imageData`, `threadTs`, `confirming`, `sending`, `editingProfile`, `err`
- Em `Metas`/`Produto`/`Config`: `tick` (refresh local), `editing`, `toast`

Sem Redux, sem Zustand, sem Context provider — props drilling e useState. Funciona porque o app é raso.

---

## 5. Pontos fracos do UI atual (visão do código)

Os principais problemas que vejo, ordenados por impacto:

### 5.1 — Inconsistência de padding/border/radius entre cards
Há pelo menos **dois sistemas de card** convivendo:
- `.card` (legado): padding 14/16, radius 10
- `.cc-card` (centro de comando): padding 16/18, radius 12

E mais um terceiro estilo em `.lote`. Cada um veio numa fase diferente. Não tem token compartilhado de "spacing scale" ou "radius scale". Se eu mudar a aparência geral, preciso editar várias regras.

### 5.2 — Mistura de paradigmas visuais entre telas
- `Hoje` é **denso, visual, com timeline horizontal, blocos coloridos, dataviz** — feito recentemente.
- `Producao`/`PP`/`Suporte`/`Pessoas` são **tabelares/textuais, layout vertical, cards simples** — feitos no Bloco 3b inicial.
- `Metas`/`Produto`/`Config` ficam no meio: tabela com botões inline.

A diferença é gritante quando se troca de aba. Parece **duas gerações de UI conviv endo**. O `Hoje` "puxou" o resto pra baixo.

### 5.3 — `pages.jsx` com 2107 linhas
Hostil pra escala e revisão. Componentes não estão por feature/folder. Achar `CCBlock` no meio de 21 outros componentes é cansativo. Em qualquer refactor com mais de 2 telas tocadas, o git diff fica ilegível.

### 5.4 — Tipografia sem escala clara
Tamanhos meio aleatórios: 10.5, 11, 12, 13, 14, 16, 17, 22, 32. Sem `--font-xs/sm/md/lg/xl` ou similar. Labels uppercase têm 10.5/11/12px misturado.

### 5.5 — Botões inconsistentes
3 famílias diferentes:
- `button` global (no styles base): radius 6, padding 5/12
- `.cc-btn` (drawer/timeline): radius 6, padding 7/14
- `.cc-btn-link` (texto): sem fundo, accent

E variantes: `cc-btn-primary` (azul accent), `cc-btn-danger` (vermelho), `.warn` (laranja).

Não tem estado "outline", "ghost", "loading-spinner" — só `disabled`.

### 5.6 — Acessibilidade fraca
- Pouco uso de `aria-label`; apenas alguns botões críticos (◀, ×, close).
- Foco visual no botão é só `border-color: var(--accent)` (sem outline ring).
- Contraste do `--muted` (`#64748b` em `#0f172a`) está no **limite** WCAG AA pra texto normal.
- Estados live (cronômetro) não anunciam mudança pra screen readers (`aria-live`).
- Sem skip-link, sem landmarks (`role="main"` é só implícito via `<main>`).

### 5.7 — Cores dos fluxos com pouco contraste interno
`--prod #1e3a8a` (azul escuro) é OK no fundo `--bg #0f172a` mas o **texto branco em cima ganha pouco contraste** quando o bloco é fino — o `--pnp #78350f` (marrom escuro) e `--support #4c1d95` (roxo escuro) têm o mesmo problema. As 3 cores são todas escuras-saturadas; **distinguir P&P (marrom) de Suporte (roxo escuro) à distância é difícil**.

### 5.8 — Mobile: muito scroll horizontal + tabs em 3 linhas
- 11 tabs no nav → wrap em 2-3 linhas no celular, ocupa altura. Sem hamburger.
- Timeline com hour-width 120px no mobile → um dia inteiro = ~1500px de scroll lateral.
- Forms do drawer ficam **fullscreen** mas têm muitos campos, parece um popup gigante no celular.

### 5.9 — `Pessoas` aba parece esquecida
Comparada com `Hoje`, é mais simples e visualmente desatualizada. Não tem cronômetro, não tem cowork inline, não tem cores de flow — usa `--prod/--pnp/--support` via `category` (que está errado em alguns casos, ex.: `category=meta` vira roxo). Resumindo: a única tela que mostra "trabalho por pessoa" fora do `Hoje` está atrasada.

### 5.10 — Polling de 12s sem indicação visual
A timeline atualiza sozinha — mas o usuário não sabe que isso aconteceu. Não tem indicador de "sincronizado às 14:23:45" nem um spinner leve quando refetch acontece. O cronômetro tickando dá a falsa sensação de "está vivo", mas se um event novo é criado no Slack ele aparece "do nada" sem feedback.

### 5.11 — `Falar` é poderoso mas visualmente cru
Funciona, mas **parece um formulário de admin de 2010**:
- Toolbar dos botões mrkdwn é compacta demais (.cc-btn font 12px min-width 28px)
- Lista de personas é só `<ul>` plana com links
- Preview é um card cinza com `<pre>` — não imita o look do Slack
- Histórico é tabela com símbolos `✉ ⚛ 🖼 📎 🧵` apertados
- Falta hierarquia visual entre "compositor" e "personas/histórico"

### 5.12 — Config tem apenas Deadlines
A aba se chama "Config" mas só configura uma coisa. Outros settings importantes (expected_seconds dos backgrounds, threshold de idle, meta_pauses_foreground, expedient_end_hour_ny) não têm UI — só DB.

---

## Resumo executivo pro designer

**O dashboard nasceu funcional, evoluiu por blocos verticais (B.LEITURA, B.EDIÇÃO, Falar, ajustes ad-hoc) e ficou com camadas visuais sobrepostas.** A tela `Hoje` é o estado-da-arte; as outras 7 abas operacionais (`Produção`, `P&P`, `Suporte`, `Pessoas`, `Produto`, `Metas`, `Config`) são funcionais mas visualmente menos cuidadas. A `Falar` é cheia de features mas crua. `Planejamento` e `Carolina` são placeholders.

**Tema:** dark slate + sky accent. Sólido como base mas falta sistema de tokens (spacing, radius, type, button states).

**Stack:** React + Vite, sem TS, sem CSS framework, sem state lib. ~213KB JS final.

**Onde redesenhar tem mais alavanca:**
1. Unificar o **sistema de card/spacing/radius** com tokens explícitos
2. Trazer as **outras 7 telas pro padrão visual do `Hoje`** (cards modernos, chips, badges consistentes)
3. **Repensar `Falar`** como compositor com preview lado-a-lado WYSIWYG estilo Slack
4. **Cores de flow:** trocar os 3 escuros (azul/marrom/roxo) por uma paleta com contraste melhor — talvez 3 tons distintos saturados com text-on-color preservado
5. **Acessibilidade:** focus rings, aria-labels, contraste do `--muted`
6. **Mobile:** menu sanduíche pros 11 tabs; talvez horarios scroll-snap pra um modo "tela cheia por pessoa"
