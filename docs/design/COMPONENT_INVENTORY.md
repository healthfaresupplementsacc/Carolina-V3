# Component Inventory — hf-design.css

Classes utilitárias do design system (`src/shared/hf-design.css`). Tudo usa
tokens `var(--hf-*)`. Exemplos de uso abaixo.

## Superfícies (glass)
| Classe | Uso | Exemplo |
|---|---|---|
| `.hf-glass` | card translúcido padrão (blur 22) | `<div class="hf-glass" style="padding:24px;border-radius:30px">…</div>` |
| `.hf-glass-strong` | modais/overlays (86% branco, blur 30) | `<div class="hf-glass-strong">…</div>` |
| `.hf-card` | card leve (blur 14) | listas de task |

## Botões
| Classe | Uso |
|---|---|
| `.hf-btn .hf-btn-primary` | CTA principal (gradiente accent→green-bright) |
| `.hf-btn-secondary` | ação azul (join) |
| `.hf-btn-ghost` | secundária translúcida (voltar/cancelar) |
| `.hf-btn-destructive` | finalizar/apagar (vermelho) |
| `.hf-btn-warn` | clock-out (laranja) |
| `.hf-btn-lunch` | atalho almoço (verde) |
| `.hf-sheen` | `<span class="hf-sheen">` dentro de um botão `position:relative;overflow:hidden` → brilho deslizante |

Ex.: `<button class="hf-btn hf-btn-primary" style="padding:18px 28px"><span class="hf-sheen"></span>Iniciar</button>`

## Inputs / chips
- `.hf-input` — campo de texto/numérico (min-height 58, foco azul).
- `.hf-chip .hf-chip-blue|green|amber` — etiquetas (supplement azul, lote verde).

## Ambient layer
```html
<div class="hf-ambient"><div class="blob b1"></div><div class="blob b2"></div>
<div class="blob b3"></div><div class="blob b4"></div></div>
```
Opacidade dos blobs = `var(--day)` (hora), `var(--energy)` (tasks ativas),
`var(--hf-ambient)` (densidade dos settings). Atualize via `HFDesign.ambientVars()`.

## Mantra
`.hf-mantra` — frase flutuante (anim `hfMantra`). Conteúdo de `HFDesign.mantra(lang,i)`.

## Keyframes disponíveis
`hfPop` (entrada modal/card) · `hfRise` (slide-up, use stagger .5/.6/.65s) ·
`hfFade` (backdrop) · `hfFloat` · `hfShake` (PIN errado) · `hfSheen` (CTA) ·
`hfPulse` (status dot / gravando) · `hfMantra` · `driftA-D` (ambient).
`@media (prefers-reduced-motion)` desliga tudo.

## Helpers (`HFDesign`, hf-design.js)
| fn | retorna |
|---|---|
| `phaseOfDay(date)` | 'madrugada'|'manhã'|'tarde'|'noite' |
| `greeting(phaseOrDate)` | 'Bom dia' etc |
| `clockStr(date)` | '08:05' (24h) |
| `dateStr(date)` | 'terça-feira, 16 de junho' |
| `initials(name)` | 'BS' |
| `statusDot(state)` | cor (busy verde / lunch laranja / free cinza) |
| `ageBadge(start,now,{warnMin,overMin})` | `{text,color,minutes,level}` (ok/warn/over) |
| `operatorAccent(id)` / `productAccent(name)` | cor da paleta (determinístico) |
| `ambientVars(date,activeTasks)` | `{'--day','--energy'}` |
| `mantra(lang,i)` | frase |

## Scrollbar
`.hf-scroll` — scrollbar fina translúcida (webkit + firefox).

## Tokens-chave (resumo)
Azul `#0f4c92`/`#2f7ae0`/`#3a86ee` · Verde `#44ae4f`/`#19c277`/`#0e7a4e` ·
Vermelho `#b3261e` · Laranja `#b35c00` · Texto `#0c2545`→`#8195ab` · Fonts
Manrope (corpo) / Sora (display) · Raios 8/14/20/26/34. Detalhe em COLOR_TOKENS.md.
