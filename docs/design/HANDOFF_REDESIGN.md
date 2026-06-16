# Redesign HealthFare — Handoff técnico

Redesign visual aplicado em cima do sistema existente (backend/endpoints/Carolina
INTOCADOS). Fonte visual: `REDESIGN_SOURCE.html` (Claude Design, framework x-dc)
→ traduzido pra **vanilla JS/CSS** (sem x-dc, sem build).

## Camadas
| Camada | Arquivo | Papel |
|---|---|---|
| Design system | `src/shared/hf-design.css` + `hf-design.js` | tokens, keyframes, glass/btn/input, ambient layer; helpers (greeting, ageBadge, accents…). Servido em `/shared/` (mount no wire.js). Fonte única p/ todas as surfaces. |
| Tokens (doc) | `docs/design/COLOR_TOKENS.md` | cores/fontes/raios e quando usar |
| /op v4 | `src/op/{index,style,sw,app}.v4.*` + `products.json` + `assets/` | página do operador redesenhada (vanilla, render-on-state) |
| /admin v4 | `src/admin/style.v4.css` | reskin overlay (importar após style.css) — cobre admin + métricas |
| /dashboard-v4 v4 | `dashboard-v4/src/redesign-v4.css` | reskin leve (importar em main.jsx + `vite build` após revisão) |

## /op v4 — arquitetura
`app.v4.js` é um IIFE único: `S` (state) + `setState`/`render` (innerHTML de
`#hf-root`) + **delegação de eventos** (`data-act` click, `data-input` input,
`data-change` change). Sem framework. Reaproveita:
- `window.HF_DATA` (fuse-data.js, dados reais do banco) — grupos/tasks/supplements/lotes.
- `HFStateMachine.searchSupplements` (autocomplete local).
- `HFOfflineQueue` (fila offline localStorage) p/ POSTs de event/note.
- `HFDesign` (helpers) + `hf-design.css` (visual).

Endpoints usados (todos já existentes — R6, nada inventado): `auth/login·logout·
heartbeat`, `architect/person/:id/today`, `active-operators`, `event/start·
retroactive·:id/end·:id/join`, `note`, `missing-bottle-counts`, `clock-out`,
`forgotten-checkout/resolve`. (`voice/upload` NÃO é usado no v4 — ver abaixo.)

## Como adicionar uma página nova com a identidade
1. No `<head>`: preconnect Google Fonts + `<link rel=stylesheet href="/shared/hf-design.css">`.
2. `theme-color #0f4c92`, viewport `viewport-fit=cover`.
3. Use classes `hf-glass`/`hf-btn-primary`/`hf-input`/`hf-chip-*` + tokens `var(--hf-*)`.
4. Ambient: `<div class="hf-ambient"><div class="blob b1">…b4></div>` + atualize
   `--day`/`--energy`/`--hf-ambient` (ver `HFDesign.ambientVars`).
5. Accent por contexto: defina `--accent` inline (`HFDesign.operatorAccent`/`productAccent`).

## Decisões de escopo (honestas)
- **Voz no v4 = Web Speech → preenche a nota** (transcript). O upload de áudio
  (`/voice/upload`, admin ouve depois) **não** está no v4 — o design só faz
  transcript. Reintroduzir o upload é um TODO (gravar MediaRecorder + enviar com
  `event_id` após o start). Documentado pra não parecer regressão silenciosa.
- **Imagens não otimizadas** (R6 = zero deps; npm quebrado). PNGs servidos como
  estão + `loading="lazy"` + `width/height`. Otimizar (WEBP/thumb) é TODO.
- **Swap v4→ativo** é manual (ver SHELL_QUEUE) e só após smoke do `.v4`.
- **/dashboard-v4 reskin** criado mas não buildado (risco/baixa prioridade).
- Tests do app.v4 são **source-guard** (node, sem jsdom). Behavioral real = smoke
  em prod (puppeteer no login + fluxo).

## Goal/ring do Home
`completedToday` = events finalizados hoje; `goal` = `mine.goal` se o endpoint
`architect/person/:id/today` retornar, senão `max(8, total de events do dia)`.
Se quiser meta real por operador, expor no endpoint (TODO).
