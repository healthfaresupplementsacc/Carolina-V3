# HealthFare — Design Tokens & Uso

Fonte única: [`src/shared/hf-design.css`](../../src/shared/hf-design.css) (`:root` vars) + helpers em [`src/shared/hf-design.js`](../../src/shared/hf-design.js). Derivado do redesign do Claude Design (`REDESIGN_SOURCE.html`). Identidade **azul + verde** HealthFare.

## Cores
| Token | Hex | Quando usar |
|---|---|---|
| `--hf-blue-deep` | #0f4c92 | Logo H, fundo login, azul institucional |
| `--hf-blue-mid` | #2f7ae0 | Ambient gradient 1 |
| `--hf-blue-soft` | #3a86ee | Botão "Entrar/Join" (secondary) |
| `--hf-blue-dark` | #1f5fd0 | Hover do secondary |
| `--hf-green-leaf` | #44ae4f | Folha do logo, accent primário |
| `--hf-green-bright` | #19c277 | Fim do gradiente do CTA primário |
| `--hf-green-dark` | #0e7a4e | Almoço, accent default |
| `--hf-green-light` | #3cc878 | Início do gradiente Almoço |
| `--hf-teal` | #1b8f8f | Ambient gradient 3 |
| `--hf-red` / `--hf-red-light` | #b3261e / #cf463c | Finalizar / destrutivo / gravação |
| `--hf-orange` / `--hf-orange-light` | #b35c00 / #d97712 | Clock-out, alertas de duração |
| `--hf-text-primary…faded` | #0c2545 → #8195ab | Hierarquia de texto (5 níveis) |
| `--hf-bg-app` | #e9f0f8 | Fundo base |
| `--hf-bg-glass` / `-strong` | rgba(255,255,255,.66/.86) | Cards glass |

**Regra (D5):** azul + verde são SEMPRE primárias. Cores de produto (lilás, laranja, etc.) só como **accent pontual** via `productAccent()`.

## Tipografia
- Corpo: `--hf-font-body` = **Manrope** (400/500/600/700/800).
- Display/títulos/botões: `--hf-font-display` = **Sora** (500/600/700/800).
- Fallback: `system-ui`. Carregadas via Google Fonts (`preconnect` no `<head>`); `@import` de fallback no CSS.

## Raios / Sombras
`--hf-r-sm 8` · `md 14` · `lg 20` · `xl 26` · `pill 34`. Sombras: `--hf-shadow-sm/md/lg` (difusas, baixas, tom azul-marinho).

## Classes utilitárias
`.hf-glass` / `.hf-glass-strong` / `.hf-card` (superfícies) · `.hf-btn` + `.hf-btn-primary/secondary/ghost/destructive/warn/lunch` · `.hf-sheen` (brilho deslizante dentro de CTA) · `.hf-input` · `.hf-chip-blue/green/amber` · `.hf-ambient` (+ `.blob.b1..b4`) · `.hf-scroll` · `.hf-mantra`.

## Accent dinâmico
- `--accent` (default `#0e7a4e`): sobrescreva inline por operador (`operatorAccent(id)`) — colore CTA, ring de progresso, etc.
- `color-mix(in srgb, var(--accent) 88%, var(--hf-green-bright))` no gradiente do CTA primário.

## Ambient layer (vivo)
4 blobs à deriva (`driftA-D`), opacidade ligada a CSS vars atualizadas por JS:
- `--day` (0→1 conforme hora; pico ~13h) · `--energy` (0→1 por nº de tasks ativas) · `--pulse` (animável) · `--hf-ambient` (multiplicador de densidade dos settings: 0.5 sutil / 1 médio / 1.5 intenso).
- `HFDesign.ambientVars(date, activeTasks)` calcula `--day`/`--energy`.

## Animações (`@keyframes`)
`hfPop` (entrada modal/card) · `hfRise` (entrada com slide, use stagger .5/.6/.65s) · `hfFade` (backdrop) · `hfFloat` · `hfShake` (PIN errado) · `hfSheen` (CTA) · `hfPulse` (status dot) · `hfMantra` (frase) · `driftA-D` (ambient). `prefers-reduced-motion` desliga.

## Helpers (`HFDesign`)
`phaseOfDay` · `greeting` · `clockStr` · `dateStr` · `initials` · `statusDot` · `ageBadge(startedAt,now,{warnMin,overMin})` → `{text,color,minutes,level}` · `operatorAccent` · `productAccent` · `ambientVars` · `mantra(lang,i)`.

## Acessibilidade / touch
Alvos ≥44px (na prática ≥58–72px). Contraste alto. `aria-label` em botões só-ícone. `viewport-fit=cover` + `theme-color #0f4c92`.
