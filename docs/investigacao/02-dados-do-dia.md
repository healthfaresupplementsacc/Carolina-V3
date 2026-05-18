# 02 — Dados gravados no banco hoje (18 Mai 2026, ET)

Dumps read-only em `_raw/*.json`. Contagens de `_raw/_counts.json`.

| Tabela | Linhas hoje | Observação |
|--------|-------------|------------|
| messages | 57 | canal produção só (admin não gravado) |
| workflow_instances | 14 | muitos com product_name NULL |
| phase_instances | 20 | **11 "Linha de Produção"; 6 já com `[fantasma_auto_cleanup]`** |
| ad_hoc_task_instances | 1 | id 42 "Outro" / Ana |
| tasks (legacy) | 8 | ids 487–494 |
| pauses (legacy) | 5 | ids 63,66,68,69,71 |
| production_counts | 0 | **nenhum count hoje** |
| operator_activity_log | 20 | ids 77–96, **cadeia única encadeada entre operadores** |
| operator_notes | 1 | id 2, source=app_home |
| admin_audit_log | 37 | inclui cleanup fantasma + ai_admin |
| carolina_proposals | 10 | ids 24–33, todas `status=pending`, `source=cron` |
| silent_log | 19 | ids 44–62, **todas mensagens da Carolina silenciadas** |
| urgency_notifications | ERRO | tabela **não tem coluna `created_at`** → não coletável por data (doc 11) |
| orders_sessions | 2 | ids 44 (502 ord), 45 (32 ord) — Simone |
| operators | 36 (total) | ver mapa abaixo |

## phase_instances de hoje (joined — `_raw/phase_joined_today.json`)

EVIDENCIADO (id · phase · status · produto · batch · starter · st→en · oal_n):

- 549 Imprimir ordens · closed · — · — · Simone · 09:35→10:13 · oal0 (P&P 502)
- 533 Linha de Produção · **deleted** · Potassium Iodide · 0134 · Vitor · 09:58 · oal2 (wf453)
- 545 Linha de Produção · **deleted** · Plant Sterols · 0134 · Vitor · 09:58 · oal0 (wf454)
- 534 Linha de Produção · closed · Plant Sterols · 0134 · Vitor · 09:58→13:54 · oal1 (wf454)
- 544 Linha de Produção · **open** · Plant Sterols · 0134 · **Bruno** · 09:58 · oal1 (wf454)
- 535 Empacotar · closed · — · — · Vitor · 10:01→12:46 (wf455)
- 536 Linha de Produção · **deleted** · — · — · Vitor · 10:01 (", Bruno, Ana na linha")
- 537 Linha de Produção · **deleted [fantasma]** · — · — · **Simone** · 10:14→14:27 · dur 4h09 (era "colocando label" = P&P!)
- 546 Linha de Produção · closed · Rutin · — · Ana · 10:21→12:45 · **wf 22** (workflow ANTIGO)
- 538 Linha de Produção · **deleted** · Rutin · — · Ana · 10:21 (dup de 546, wf458)
- 550 Imprimir ordens · closed · — · — · Simone · 11:29→11:42 (P&P 32)
- 539 Linha de Produção · **deleted [fantasma]** · — · — · Ana · 12:22→12:45 ("LIMPEZA")
- 547 Linha de Produção · closed · Hyaluronic Acid · 0139 · Ana · 12:57→13:57 · wf460
- 540 Linha de Produção · closed · Hyaluronic Acid · 0139 · Ana · 12:57→13:44 · wf460 (**dup de 547, mesmo wf/batch**)
- 551 Revisão · open · — · 0134 · Vitor · 14:13 (wf467)
- 552 Revisão · open · — · — · Simone · 14:23 (wf468)
- 553 Revisão · open · Plant Sterols · 0134 · Vitor · 14:40 (wf454)
- 554 Linha de Produção · **deleted [fantasma]** · — · — · Simone · 14:48 (wf469)
- 555 Linha de Produção · **deleted** · Potassium Iodide · 0134 · Vitor · 15:09 ("Manutencao do Potassium", wf453)
- 556 Linha de Produção · **deleted [fantasma]** · — · — · Ana · 15:09 (wf470)

## tasks (legacy) — `_raw/tasks_today.json`

- 487 Bruno · Plant Sterols 0134 · **deleted** · helpers=Simone · slack_ts 1779112687
- 488 **Vitor** · Plant Sterols 0134 · **deleted** · slack_ts **1779112687** (mesmo ts do 487, operador diferente)
- 489 Ana · Rutin · closed · 8672s · start ts 1779114077 · **end ts 1779122749 (= msg "ANA- F: LIMPEZA")**
- 490 Ana · Hyaluronic 0139 · closed · 3645s
- 491 Vitor · — · closed 0s · "Double check e fechamento das caixas" · task_type=outro
- 492 Vitor · — · 0134 · closed 0s · "Plant-0134 ( em capsulas )- Bruno" · outro
- 493 Ana · — · closed 1594s · "limpeza" · task_type=limpeza
- 494 Vitor · Plant Sterols 0134 · **open** · "Revisao Plant (0134)" · revisao

## oal — `_raw/oal_joined_today.json`

20 entries, ids 77–96. **Cadeia `left_for_id`/`came_back_from_id` é uma lista encadeada ÚNICA atravessando Vitor↔Simone↔Ana** (77→78→79→80→81→82→…→96). Ex.: oal 82 Simone pi537 dur **14949s (4h09)** = a tal "Linha de Produção" fantasma da Simone (que na real era P&P). oal 96 Vitor pi544 `dur=null` (aberto). oal 87 Ana ad_hoc ati42 (o "Outro").

## pauses (legacy) — `_raw/pauses_today.json`

- 63 Simone 13:41→14:23 `ended_reason=auto_new_task` (fechada por nova task, não por "voltei")
- 66 Ana 14:28→15:09 `manual_return`
- 68 Ana 15:09→15:09 `[break não-rastreado]` `untracked_return` (instantânea)
- 69 Vitor task494 15:11→15:56
- 71 Vitor task494 15:56→16:41 `auto_new_task`
**Não há pause para "Bruno - Indo almocar 14:24"** explicitamente vinculada (ver doc 07).

## orders_sessions — `_raw/orders_sessions_today.json`

- 44 Simone 502 ord · 09:35→10:13 · 2337s · helpers="Vitor,"
- 45 Simone 32 ord · 11:29→11:42 · 818s

## operators (mapa) — `_raw/operators_all.json`

EVIDENCIADO (relevantes): id1 **Ana** slack=NULL · id2 **Bruno** slack=**NULL** · id3 **Vitor** slack=`U08JC85HMNE` · id4 **Simone** slack=`U07FG34TMPF` · id333 **Bruno Camp** slack=`D03UL80GDRB` (**isso é um DM-id `D…`, não user-id `U…` — valor inválido**). Não há "Bruno Sarmento". Restante: dezenas de `AdminValidateTest_*` (lixo de testes em prod).
