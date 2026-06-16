# /op v4 — State Machine (app.v4.js)

`app.v4.js` é render-on-state: um objeto `S` + `setState`/`render` que reescreve
`#hf-root`. Não há FSM formal como no `state-machine.js` legado; o "estado" é
`S.screen` + `S.flow` (objeto do fluxo de criar tarefa) + `S.overlay` + `S.settingsOpen`.

## Telas (S.screen)
```
                         PIN ok
   ┌──────────┐   submitPin()   ┌──────────┐
   │  login   │ ───────────────▶│   home   │
   └──────────┘                 └──────────┘
        ▲  doLogout/auto_timeout/clock-out │ startFlow()
        └──────────────────────────────────┤
                                            ▼  (S.flow ≠ null, overlay sobre o home)
```

## Fluxo de criar tarefa (S.flow.step)
```
 group ──pickGroup──▶ type ──pickType──▶ (requires_product?)
                                          │ sim                    │ não
                                          ▼                        ▼
                                        supp ──pickSupp──▶ batch ──(pickBatch/skip/ok)──▶ confirm
                                                                                            │
                          quickLunch ───────────────────────────────────────────────────▶ confirm
                                                                                            │
   confirm ──confirmStart()──▶ (forgot?)                                                    │
        │ não → POST /event/start ───────────────────────────────────────▶ home (reload)   │
        │ sim → step=finished                                                               │
        ▼                                                                                   │
   finished ──commitRetro()──▶ POST /event/retroactive {started_at, ended_at?} ─▶ home      │
   flowBack ◀── volta um passo (type/supp/batch/confirm/finished)                           │
   cancelFlow ◀── fecha (S.flow=null)                                                       ┘
```
**Retroactive vive DENTRO do confirm** (toggle "Quando começou?": Agora|Esqueci).
"Esqueci" + horário válido → botão vira "COMEÇAR ÀS HH:MMam" → ao confirmar, vai
pro passo `finished` ("Já terminou?") antes de gravar via `/event/retroactive`.

## Overlays (S.overlay.type) — sobre qualquer tela
- `finish` — finalizar task (bottles? + nota) → `POST /event/:id/end`
- `join` — entrar junto (cowork-B) → `POST /event/:id/join`
- `note` — nota rápida (voz) → `POST /note`
- `clock` — fim do dia (contagens P5) → `GET /missing-bottle-counts` → `POST /clock-out`
- `forgotten` — cascade (colega esqueceu) → `POST /forgotten-checkout/resolve` (fila `forgottenQueue`)

## Settings (S.settings, localStorage `hf_op_settings_v4`)
`mantras` · `mantraLang` (pt/es/en/rotate) · `dayPhase` (auto/morning/afternoon/
evening) · `density` (low/medium/high → multiplica `--hf-ambient`) · `aging`
(BETA) + `warnMin`/`overMin` (cor do age-badge nas task cards).

## Timers
- `tClock` 1s: relógio + countdown `logoffLeft` (auto-logoff) → `doLogout('auto_timeout')`.
- `tBeat` 45s: `POST /auth/heartbeat`.
- `tMantra` 7s: rotaciona frase.
- `online`/`offline`: flush da fila offline ao voltar.
`bump()` (qualquer clique/input) reseta o countdown de auto-logoff.

## Eventos de delegação
`click`→`data-act` (ACT[...]) · `input`→`data-input` (query re-renderiza c/ foco
preservado; batch/orders/note só armazenam) · `change`→`data-change` (selects de
hora → re-render p/ atualizar status/label).
